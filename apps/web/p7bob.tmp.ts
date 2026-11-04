// Temporary probe: bob listens to terminal, todo and shell streams while alice works. Delete after use.
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { Effect, Layer, Stream } from "effect";
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
const base = `ws://127.0.0.1:3813/?client=bob-bbbbbbbb`;
const compat = await negotiateOverHttp(base);
const url = makeFeatureSocketUrl(base, compat!);
const Group = WsFeatureRpcGroup.merge(WsDeviceRpcGroup)
  .merge(WsComputerRpcGroup)
  .merge(WsProjectAgentRpcGroup)
  .merge(WsHyperAgentRpcGroup);
const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);
const program = Effect.gen(function* () {
  const rpc = yield* RpcClient.make(Group);
  const terminal: string[] = [];
  yield* rpc[WS_METHODS.subscribeTerminalEvents]({} as never).pipe(
    Stream.runForEach((e: any) => Effect.sync(() => terminal.push(e.threadId))),
    Effect.forkChild,
  );
  const shell: any = yield* rpc[ORCHESTRATION_WS_METHODS.getShellSnapshot]({} as never);
  console.log("[bob] shell projects", shell.projects.length, "threads", shell.threads.length);
  yield* Effect.sleep("12 seconds");
  console.log("[bob] terminal events seen from others:", terminal.length);
});
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(protocol)) as never).catch((e) =>
  console.log("[bob] CRASH", e),
);
process.exit();
