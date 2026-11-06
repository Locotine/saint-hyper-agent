import { pathToFileURL } from "node:url";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, saintCli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./effectServer";
import { NetService } from "@saint/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import { consumeDesktopParentInput, withDesktopParentLifetime } from "./desktopParentLifetime";

const nodeScriptCandidate =
  process.env.ELECTRON_RUN_AS_NODE === "1" &&
  typeof process.argv[2] === "string" &&
  /\.(?:c?js|mjs)$/iu.test(process.argv[2])
    ? process.argv[2]
    : undefined;

if (nodeScriptCandidate) {
  // Packaged Bun sidecars share `process.execPath` with helper scripts (Antigravity
  // `capture.cjs`, `agent-gateway-mcp-proxy.mjs`). When invoked with
  // `ELECTRON_RUN_AS_NODE=1 <execPath> <script.cjs> ...args`, strip the embedded
  // entrypoint from `process.argv` and run the target script directly.
  process.argv.splice(1, 1);
  await import(pathToFileURL(nodeScriptCandidate).href);
} else {
  const desktopParentInput = consumeDesktopParentInput(process.env, () => process.stdin);

  const RuntimeLayer = Layer.empty.pipe(
    Layer.provideMerge(CliConfig.layer),
    Layer.provideMerge(ServerLive),
    Layer.provideMerge(OpenLive),
    Layer.provideMerge(NetService.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(FetchHttpClient.layer),
  );

  Command.run(saintCli, { version })
    .pipe(Effect.provide(RuntimeLayer))
    .pipe((program) => withDesktopParentLifetime(program, desktopParentInput))
    .pipe((program) => NodeRuntime.runMain(program as Effect.Effect<void, unknown, never>));
}
