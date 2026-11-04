// Temporary Phase 7 probe: one scoped client drives a real server over WebSocket. Delete after use.
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { Effect, Layer, Stream, Fiber } from "effect";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WsFeatureRpcGroup,
  WsProjectAgentRpcGroup,
  WsHyperAgentRpcGroup,
  WsDeviceRpcGroup,
  WsComputerRpcGroup,
} from "@saint/contracts";
import { negotiateOverHttp, makeFeatureSocketUrl } from "./src/wsTransport.ts";

const client = process.argv[2] ?? "alice-aaaaaaaa";
const base = `ws://127.0.0.1:${process.env.PROBE_PORT ?? "3813"}/?client=${client}`;
const cwd = process.argv[3] ?? "/tmp/saint-p7-ws";
const id = (p: string) => `${p}-${crypto.randomUUID()}`;
const log = (...a: unknown[]) => console.log(`[${client}]`, ...a);

const compat = await negotiateOverHttp(base);
if (!compat) throw new Error("negotiate failed");
const url = makeFeatureSocketUrl(base, compat);
log("feature url ok");

const Group = WsFeatureRpcGroup.merge(WsDeviceRpcGroup)
  .merge(WsComputerRpcGroup)
  .merge(WsProjectAgentRpcGroup)
  .merge(WsHyperAgentRpcGroup);
const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const step = <A, E, R>(name: string, eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.tap((v) => Effect.sync(() => log("OK", name, JSON.stringify(v)?.slice(0, 160)))),
    Effect.tapError((e) => Effect.sync(() => log("FAIL", name, JSON.stringify(e)?.slice(0, 400)))),
    Effect.option,
  );

const program = Effect.gen(function* () {
  const rpc = yield* RpcClient.make(Group);
  const now = () => new Date().toISOString();
  const model = { provider: "codex", model: "gpt-5" } as never;
  const projectId = id("project");
  const threadId = id("thread");
  yield* step(
    "project.create",
    rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "project.create",
      commandId: id("cmd"),
      projectId,
      title: `P7 ${client}`,
      workspaceRoot: cwd,
      createWorkspaceRootIfMissing: true,
      createdAt: now(),
    } as never),
  );
  yield* step(
    "thread.create",
    rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "thread.create",
      commandId: id("cmd"),
      threadId,
      projectId,
      title: "P7 thread",
      modelSelection: model,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now(),
    } as never),
  );

  // Terminal: subscribe, open, write, expect our echo back.
  const seen: string[] = [];
  const sub = yield* rpc[WS_METHODS.subscribeTerminalEvents]({} as never).pipe(
    Stream.runForEach((event: any) =>
      Effect.sync(() => {
        if (event.threadId === threadId)
          seen.push(`${event.type}:${(event.data ?? "").slice(0, 40)}`);
      }),
    ),
    Effect.tapError((e) => Effect.sync(() => log("FAIL terminal stream", JSON.stringify(e)))),
    Effect.forkChild,
  );
  yield* Effect.sleep("300 millis");
  yield* step(
    "terminal.open",
    rpc[WS_METHODS.terminalOpen]({
      threadId,
      terminalId: "default",
      cwd,
      cols: 80,
      rows: 24,
    } as never),
  );
  yield* step(
    "terminal.write",
    rpc[WS_METHODS.terminalWrite]({
      threadId,
      terminalId: "default",
      data: "echo P7_MARK\r",
    } as never),
  );
  yield* Effect.sleep("1500 millis");
  log(
    "terminal events:",
    seen.length,
    seen.some((s) => s.includes("P7_MARK")) ? "ECHO SEEN" : "NO ECHO",
    seen.slice(0, 4),
  );

  // Draft-chat terminal: a thread id the server does not know yet.
  const draftId = id("thread");
  const draftSeen: string[] = [];
  const sub2 = yield* rpc[WS_METHODS.subscribeTerminalEvents]({} as never).pipe(
    Stream.runForEach((event: any) =>
      Effect.sync(() => {
        if (event.threadId === draftId) draftSeen.push(event.type);
      }),
    ),
    Effect.forkChild,
  );
  yield* Effect.sleep("300 millis");
  yield* step(
    "draft terminal.open",
    rpc[WS_METHODS.terminalOpen]({
      threadId: draftId,
      terminalId: "default",
      cwd,
      cols: 80,
      rows: 24,
    } as never),
  );
  yield* step(
    "draft terminal.write",
    rpc[WS_METHODS.terminalWrite]({
      threadId: draftId,
      terminalId: "default",
      data: "echo hi\r",
    } as never),
  );
  yield* Effect.sleep("1200 millis");
  log("draft terminal events:", draftSeen.length);

  // Side chat: fork the thread the way the web composer does.
  const sideId = id("thread");
  yield* step(
    "thread.fork.create (sidechat)",
    rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "thread.fork.create",
      commandId: id("cmd"),
      threadId: sideId,
      sourceThreadId: threadId,
      sidechatSourceThreadId: threadId,
      projectId,
      title: "Sidechat: P7",
      modelSelection: model,
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      importedMessages: [],
      createdAt: now(),
    } as never),
  );
  const shell: any = yield* step(
    "getShellSnapshot",
    rpc[ORCHESTRATION_WS_METHODS.getShellSnapshot]({} as never),
  );
  const threads = shell._tag === "Some" ? shell.value.threads : [];
  log(
    "shell threads:",
    threads.length,
    "sidechat visible:",
    threads.some((t: any) => t.id === sideId),
  );
  yield* step(
    "subscribeThread sidechat (first item)",
    rpc[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId: sideId } as never).pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    ),
  );
  yield* Fiber.interrupt(sub);
  yield* Fiber.interrupt(sub2);
  yield* step(
    "terminal.close",
    rpc[WS_METHODS.terminalClose]({ threadId, terminalId: "default" } as never),
  );
  yield* step(
    "draft terminal.close",
    rpc[WS_METHODS.terminalClose]({ threadId: draftId, terminalId: "default" } as never),
  );
});

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(protocol)) as never).catch(
  (e) => {
    log("PROBE CRASH", e);
    process.exitCode = 1;
  },
);
process.exit();
