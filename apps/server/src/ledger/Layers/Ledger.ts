import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type { FlowRunId, LedgerEvent, LedgerHandle, LedgerTaint } from "@saint/contracts";
import { Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { canonicalJson } from "../../agentGateway/creationUtils.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { Ledger, LedgerError, type LedgerShape } from "../Services/Ledger.ts";

export const LEDGER_GENESIS_HASH = "0".repeat(64);
const SIGNING_SEED_NAME = "ledger-ed25519-seed";
// DER prefix that wraps a raw 32-byte Ed25519 seed as a PKCS#8 private key.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

interface EventRow {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly actor: string;
  readonly flowId: string | null;
  readonly nodeId: string | null;
  readonly payloadJson: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly sig: string;
}

interface HandleRow {
  readonly handle: string;
  readonly size: number;
  readonly mime: string;
  readonly provenance: string;
  readonly taint: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly blob: Uint8Array;
}

export function ledgerEventHash(
  prevHash: string,
  event: Pick<LedgerEvent, "ts" | "kind" | "actor" | "flowId" | "nodeId" | "payload">,
): string {
  const body = canonicalJson({
    ts: event.ts,
    kind: event.kind,
    actor: event.actor,
    flowId: event.flowId,
    nodeId: event.nodeId,
    payload: event.payload,
  });
  return createHash("sha256").update(`${prevHash}\n${body}`).digest("hex");
}

const fail = (operation: string) => (cause: unknown) =>
  new LedgerError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const toEvent = (row: EventRow): LedgerEvent => ({
  seq: row.seq,
  ts: row.ts,
  kind: row.kind,
  actor: row.actor,
  flowId: row.flowId as FlowRunId | null,
  nodeId: row.nodeId,
  payload: JSON.parse(row.payloadJson) as unknown,
  prevHash: row.prevHash,
  hash: row.hash,
  sig: row.sig,
});

const makeLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const seed = yield* secrets
    .getOrCreateRandom(SIGNING_SEED_NAME, 32)
    .pipe(Effect.mapError(fail("Ledger.loadSigningKey")));
  const privateKey: KeyObject = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  // One writer: each append reads the chain head and extends it.
  const appendLock = yield* Semaphore.make(1);

  const selectAllEvents = sql<EventRow>`
    SELECT seq, ts, kind, actor, flow_id AS "flowId", node_id AS "nodeId",
      payload_json AS "payloadJson", prev_hash AS "prevHash", hash, sig
    FROM ledger_events
    ORDER BY seq ASC
  `;

  const append: LedgerShape["append"] = (input) =>
    Effect.gen(function* () {
      const head = yield* sql<{ hash: string }>`
        SELECT hash FROM ledger_events ORDER BY seq DESC LIMIT 1
      `;
      const prevHash = head[0]?.hash ?? LEDGER_GENESIS_HASH;
      const event = {
        ts: new Date().toISOString(),
        kind: input.kind,
        actor: input.actor,
        flowId: input.flowId ?? null,
        nodeId: input.nodeId ?? null,
        payload: input.payload ?? null,
      };
      const hash = ledgerEventHash(prevHash, event);
      const sig = sign(null, Buffer.from(hash, "hex"), privateKey).toString("base64");
      const inserted = yield* sql<{ seq: number }>`
        INSERT INTO ledger_events (ts, kind, actor, flow_id, node_id, payload_json, prev_hash, hash, sig)
        VALUES (${event.ts}, ${event.kind}, ${event.actor}, ${event.flowId}, ${event.nodeId},
          ${JSON.stringify(event.payload)}, ${prevHash}, ${hash}, ${sig})
        RETURNING seq
      `;
      return { ...event, seq: inserted[0]!.seq, prevHash, hash, sig } as LedgerEvent;
    }).pipe(sql.withTransaction, appendLock.withPermits(1), Effect.mapError(fail("Ledger.append")));

  const listByFlow: LedgerShape["listByFlow"] = (flowId, afterSeq = 0) =>
    sql<EventRow>`
      SELECT seq, ts, kind, actor, flow_id AS "flowId", node_id AS "nodeId",
        payload_json AS "payloadJson", prev_hash AS "prevHash", hash, sig
      FROM ledger_events
      WHERE flow_id = ${flowId} AND seq > ${afterSeq}
      ORDER BY seq ASC
    `.pipe(
      Effect.map((rows) => rows.map(toEvent)),
      Effect.mapError(fail("Ledger.listByFlow")),
    );

  // ponytail: verifies the whole chain in memory; page through by seq once ledgers reach millions.
  const verifyChain: LedgerShape["verify"] = () =>
    selectAllEvents.pipe(
      Effect.map((rows) => {
        let prevHash = LEDGER_GENESIS_HASH;
        for (const row of rows) {
          const event = toEvent(row);
          const intact =
            row.prevHash === prevHash &&
            ledgerEventHash(prevHash, event) === row.hash &&
            verify(null, Buffer.from(row.hash, "hex"), publicKey, Buffer.from(row.sig, "base64"));
          if (!intact) return { intact: false, count: rows.length, brokenAtSeq: row.seq };
          prevHash = row.hash;
        }
        return { intact: true, count: rows.length, brokenAtSeq: null };
      }),
      Effect.mapError(fail("Ledger.verify")),
    );

  const exportJsonl: LedgerShape["exportJsonl"] = () =>
    selectAllEvents.pipe(
      Effect.map((rows) =>
        [
          JSON.stringify({ kind: "ledger.header", algorithm: "sha256+ed25519", publicKeyPem }),
          ...rows.map((row) => JSON.stringify(toEvent(row))),
        ].join("\n"),
      ),
      Effect.mapError(fail("Ledger.exportJsonl")),
    );

  const putHandle: LedgerShape["putHandle"] = (input) =>
    Effect.gen(function* () {
      const sha256 = createHash("sha256").update(input.content).digest("hex");
      const handle = `${input.kind}:${sha256.slice(0, 12)}` as LedgerHandle;
      yield* sql`
        INSERT INTO ledger_handles (handle, sha256, size, mime, provenance, taint, created_by, created_at, blob)
        VALUES (${handle}, ${sha256}, ${Buffer.byteLength(input.content)}, ${input.mime},
          ${input.provenance}, ${input.taint}, ${input.createdBy}, ${new Date().toISOString()},
          ${gzipSync(input.content)})
        ON CONFLICT (sha256) DO NOTHING
      `;
      return handle;
    }).pipe(Effect.mapError(fail("Ledger.putHandle")));

  const getHandle: LedgerShape["getHandle"] = (handle, lines) =>
    Effect.gen(function* () {
      const rows = yield* sql<HandleRow>`
        SELECT handle, size, mime, provenance, taint, created_by AS "createdBy",
          created_at AS "createdAt", blob
        FROM ledger_handles WHERE handle = ${handle}
      `;
      const row = rows[0];
      if (!row) return null;
      const all = gunzipSync(row.blob).toString("utf8").split("\n");
      const content = lines
        ? all.slice(Math.max(0, lines.from - 1), Math.max(0, lines.to)).join("\n")
        : all.join("\n");
      return {
        handle: row.handle as LedgerHandle,
        mime: row.mime,
        provenance: row.provenance,
        taint: row.taint as LedgerTaint,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        size: row.size,
        content,
        totalLines: all.length,
      };
    }).pipe(Effect.mapError(fail("Ledger.getHandle")));

  return {
    append,
    listByFlow,
    verify: verifyChain,
    exportJsonl,
    putHandle,
    getHandle,
  } satisfies LedgerShape;
});

export const LedgerLive = Layer.effect(Ledger, makeLedger);
