import { CommandId, MessageId, ThreadId } from "@saint/contracts";
import { Effect, Layer, Option } from "effect";

import { stableGatewayDigest } from "../../agentGateway/creationUtils.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { runProcess } from "../../processRunner.ts";
import { buildForkSnapshot, parsePorcelainPaths, summarizableMessages } from "../forkContinue.ts";
import {
  ForkContinue,
  ForkContinueError,
  type ForkContinueShape,
} from "../Services/ForkContinue.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const toError = (message: string) => (cause: unknown) =>
  cause instanceof ForkContinueError ? cause : new ForkContinueError({ message, cause });
/** The summary reads at most this much of the transcript tail. */
const SUMMARY_SOURCE_CHARS = 24_000;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const textGeneration = Option.getOrUndefined(yield* Effect.serviceOption(TextGeneration));

  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = Option.getOrNull(
        yield* snapshotQuery
          .getThreadDetailWithoutActivitiesById(threadId)
          .pipe(Effect.mapError(toError("Could not read the thread."))),
      );
      if (!thread) return yield* new ForkContinueError({ message: "Thread not found." });
      const project = Option.getOrNull(
        yield* snapshotQuery
          .getProjectShellById(thread.projectId)
          .pipe(Effect.mapError(toError("Could not read the project."))),
      );
      return { thread, cwd: thread.worktreePath ?? project?.workspaceRoot ?? null };
    });

  const snapshot: ForkContinueShape["snapshot"] = (threadId, reason) =>
    Effect.gen(function* () {
      const { thread, cwd } = yield* read(threadId);
      const changedFiles = cwd
        ? yield* Effect.promise(() =>
            runProcess("git", ["status", "--porcelain"], {
              cwd,
              allowNonZeroExit: true,
              timeoutMs: 30_000,
            })
              .then((result) => (result.code === 0 ? parsePorcelainPaths(result.stdout) : []))
              .catch(() => []),
          )
        : [];
      // The summary uses the thread's own model, never a cheaper default.
      const material = summarizableMessages(thread.messages)
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n\n")
        .slice(-SUMMARY_SOURCE_CHARS);
      const summary =
        textGeneration && cwd && material
          ? yield* textGeneration
              .generateThreadRecap({
                cwd,
                newMaterial: material,
                modelSelection: thread.modelSelection,
              })
              .pipe(
                Effect.map((result) => result.recap),
                Effect.timeout("90 seconds"),
                Effect.orElseSucceed(() => null),
              )
          : null;
      return buildForkSnapshot({
        title: thread.title,
        reason,
        messages: thread.messages,
        changedFiles,
        summary,
      });
    });

  const forkContinue: ForkContinueShape["forkContinue"] = ({ threadId, reason }) =>
    Effect.gen(function* () {
      const { thread } = yield* read(threadId);
      const text = yield* snapshot(threadId, reason);
      const now = new Date().toISOString();
      const nextId = ThreadId.makeUnsafe(
        `fc-${stableGatewayDigest({ threadId, messages: thread.messages.length, now }, 32)}`,
      );
      const key = `fork-continue:${nextId}`;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`${key}:thread-create`),
          threadId: nextId,
          projectId: thread.projectId,
          title: thread.title,
          creationSource: "fork_continue",
          sourceThreadId: threadId,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          envMode: thread.envMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          createdAt: now,
        })
        .pipe(Effect.mapError(toError("Could not create the clean thread.")));
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`${key}:turn-start`),
          threadId: nextId,
          message: {
            messageId: MessageId.makeUnsafe(`${key}:message`),
            role: "user",
            text,
            attachments: [],
          },
          dispatchMode: "queue",
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: now,
        })
        .pipe(Effect.mapError(toError("Could not start the clean thread.")));
      return nextId;
    });

  return { snapshot, forkContinue } satisfies ForkContinueShape;
});

export const ForkContinueLive = Layer.effect(ForkContinue, make);
