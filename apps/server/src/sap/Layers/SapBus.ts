import { randomUUID } from "node:crypto";

import {
  CommandId,
  LEDGER_HANDLE_PATTERN,
  MessageId,
  SAP_MAX_HOPS,
  SapMessage,
  type FlowRunId,
  type FlowRun,
  type SapStats,
} from "@saint/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { Aegis } from "../../aegis/Services/Aegis.ts";
import { FlowService } from "../../flow/Services/FlowService.ts";
import { Ledger } from "../../ledger/Services/Ledger.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { renderSapMailbox, resolveSapAsk, sapLoopHash } from "../sapResolver.ts";
import { SapBus, SapBusError, type SapBusShape, type SapSendInput } from "../Services/SapBus.ts";

const SapMessageJson = Schema.fromJsonString(SapMessage);
const decode = Schema.decodeUnknownEffect(SapMessageJson);
const encode = Schema.encodeEffect(SapMessageJson);
const toError = (message: string) => (cause: unknown) =>
  cause instanceof SapBusError ? cause : new SapBusError({ message, cause });
/** A message repeated this many times in one flow is a loop; the next copy is dropped. */
const LOOP_REPEAT_LIMIT = 2;

export function sapStats(messages: ReadonlyArray<SapMessage>): SapStats {
  return {
    asks: messages.filter((message) => message.act === "ASK").length,
    answeredBySaint: messages.filter((message) => message.answeredBy === "saint").length,
    unverifiedClaims: messages.filter((message) => message.verified === false).length,
    dropped: messages.filter((message) => message.state === "dropped").length,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const flows = yield* FlowService;
  const ledger = yield* Ledger;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const aegis = Option.getOrUndefined(yield* Effect.serviceOption(Aegis));
  // ponytail: one lock for every send so a mailbox is never delivered twice; per-node if hot.
  const lock = yield* Semaphore.make(1);

  const save = (message: SapMessage, loopHash: string) =>
    encode(message).pipe(
      Effect.flatMap(
        (recordJson) => sql`
          INSERT INTO sap_messages (message_id, flow_id, to_node, state, loop_hash, created_at, record_json)
          VALUES (${message.id}, ${message.flowId}, ${message.to}, ${message.state}, ${loopHash},
            ${message.createdAt}, ${recordJson})
          ON CONFLICT (message_id) DO UPDATE SET state = excluded.state, record_json = excluded.record_json
        `,
      ),
      Effect.mapError(toError("Could not store the SAP message.")),
    );

  const update = (message: SapMessage) =>
    encode(message).pipe(
      Effect.flatMap(
        (recordJson) => sql`
          UPDATE sap_messages SET state = ${message.state}, record_json = ${recordJson}
          WHERE message_id = ${message.id}
        `,
      ),
      Effect.mapError(toError("Could not update the SAP message.")),
    );

  const listFlow = (flowId: FlowRunId) =>
    sql<{ recordJson: string }>`
      SELECT record_json AS "recordJson" FROM sap_messages WHERE flow_id = ${flowId}
      ORDER BY created_at, message_id
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.recordJson))),
      Effect.mapError(toError("Could not read the SAP messages.")),
    );

  const callerNode = (threadId: SapSendInput["fromThreadId"]) =>
    flows.nodeForThread(threadId).pipe(
      Effect.mapError(toError("Could not find the sender's flow.")),
      Effect.flatMap((found) =>
        found
          ? Effect.succeed(found)
          : Effect.fail(
              new SapBusError({
                message: "SAP works between steps of one flow; this thread is not a flow step.",
              }),
            ),
      ),
    );

  const verifiedRefs = (refs: ReadonlyArray<string>) =>
    Effect.forEach(
      refs.filter((ref) => LEDGER_HANDLE_PATTERN.test(ref)),
      (ref) =>
        ledger.getHandle(ref as never, { from: 1, to: 1 }).pipe(
          Effect.map((record) => record !== null),
          Effect.orElseSucceed(() => false),
        ),
    ).pipe(Effect.map((found) => found.some(Boolean)));

  /** Sends every pending message for `to` as one queued turn on its thread. */
  const deliver = (run: FlowRun, to: string) =>
    Effect.gen(function* () {
      const view = yield* flows
        .get(run.id)
        .pipe(Effect.mapError(toError("Could not read the flow.")));
      const threadId = view?.nodes.find((node) => node.nodeId === to)?.threadId;
      if (!threadId) return;
      const pending = (yield* listFlow(run.id)).filter(
        (message) => message.to === to && message.state === "pending",
      );
      if (pending.length === 0) return;
      const key = `sap:${run.id}:${pending.map((message) => message.id).join(",")}`;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`${key}:turn-start`),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe(`${key}:message`),
            role: "user",
            text: renderSapMailbox(pending),
            attachments: [],
          },
          dispatchMode: "queue",
          runtimeMode: run.runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        })
        .pipe(Effect.mapError(toError(`Could not deliver SAP messages to "${to}".`)));
      yield* Effect.forEach(pending, (message) => update({ ...message, state: "delivered" }), {
        discard: true,
      });
    });

  const post = (
    run: FlowRun,
    draft: Omit<
      SapMessage,
      "id" | "flowId" | "state" | "stateReason" | "answeredBy" | "answer" | "verified" | "createdAt"
    >,
  ) =>
    Effect.gen(function* () {
      const view = yield* flows
        .get(run.id)
        .pipe(Effect.mapError(toError("Could not read the flow.")));
      const target = view?.nodes.find((node) => node.nodeId === draft.to);
      if (draft.to !== "user" && !target) {
        return yield* new SapBusError({
          message: `"${draft.to}" is not a step of this flow. Steps: ${view?.nodes.map((node) => node.nodeId).join(", ")}.`,
        });
      }
      const loopHash = sapLoopHash(draft);
      const repeats = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS "count" FROM sap_messages WHERE flow_id = ${run.id} AND loop_hash = ${loopHash}
      `.pipe(Effect.mapError(toError("Could not check for SAP loops.")));
      const base: SapMessage = {
        ...draft,
        id: `m-${randomUUID().slice(0, 8)}`,
        flowId: run.id,
        state: "pending",
        stateReason: null,
        answeredBy: null,
        answer: null,
        verified: draft.act === "CLAIM" ? yield* verifiedRefs(draft.refs) : null,
        createdAt: new Date().toISOString(),
      };
      const answer = draft.act === "ASK" && target ? resolveSapAsk(draft.topic, run, target) : null;
      const message: SapMessage =
        draft.hops > SAP_MAX_HOPS
          ? { ...base, state: "dropped", stateReason: `More than ${SAP_MAX_HOPS} hops.` }
          : (repeats[0]?.count ?? 0) >= LOOP_REPEAT_LIMIT
            ? {
                ...base,
                state: "dropped",
                stateReason: "The same message repeated; looks like a loop.",
              }
            : answer !== null
              ? { ...base, state: "answered", answeredBy: "saint", answer }
              : base;
      yield* save(message, loopHash);
      yield* ledger
        .append({
          kind: `sap.${message.state === "pending" ? "sent" : message.state}`,
          actor: message.from === "user" ? "user" : `node:${message.from}`,
          flowId: run.id,
          nodeId: message.from === "user" ? null : message.from,
          payload: {
            id: message.id,
            act: message.act,
            to: message.to,
            topic: message.topic,
            refs: message.refs,
            verified: message.verified,
          },
        })
        .pipe(Effect.mapError(toError("Could not write the ledger.")));
      if (message.verified === false && aegis) {
        yield* aegis
          .raise({
            kind: "claim_unverified",
            severity: "low",
            title: `Unverified claim from ${message.from}`,
            detail: message.body.slice(0, 500),
            why: [
              `flow ${run.spec.name}`,
              `${message.from} → ${message.to} CLAIM`,
              "no Saint evidence handle cited",
            ],
            flowId: run.id,
            nodeId: message.from,
            decidable: false,
          })
          .pipe(Effect.ignore);
      }
      if (message.state === "pending" && message.to !== "user") yield* deliver(run, message.to);
      return message;
    });

  const send: SapBusShape["send"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const { run, node } = yield* callerNode(input.fromThreadId);
        if (input.to === node.nodeId) {
          return yield* new SapBusError({ message: "A step cannot message itself." });
        }
        return yield* post(run, {
          from: node.nodeId,
          to: input.to,
          act: input.act,
          topic: input.act === "ASK" ? (input.topic ?? "free") : null,
          body: input.body,
          refs: input.refs ?? [],
          replyTo: null,
          hops: 0,
        });
      }),
    );

  const reply: SapBusShape["reply"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const { run, node } = yield* callerNode(input.fromThreadId);
        const parent = (yield* listFlow(run.id)).find((message) => message.id === input.messageId);
        if (!parent || parent.to !== node.nodeId) {
          return yield* new SapBusError({
            message: `No message "${input.messageId}" was sent to you.`,
          });
        }
        yield* update({ ...parent, state: "answered", answeredBy: "agent", answer: input.body });
        return yield* post(run, {
          from: node.nodeId,
          to: parent.from,
          act: "TELL",
          topic: null,
          body: input.body,
          refs: input.refs ?? [],
          replyTo: parent.id,
          hops: parent.hops + 1,
        });
      }),
    );

  const list: SapBusShape["list"] = (flowId) =>
    listFlow(flowId).pipe(Effect.map((messages) => ({ messages, stats: sapStats(messages) })));

  return { send, reply, list } satisfies SapBusShape;
});

export const SapBusLive = Layer.effect(SapBus, make);
