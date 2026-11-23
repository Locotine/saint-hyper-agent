import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { EditorDebugService } from "../debugService.ts";
import { EditorDebug } from "../Services/EditorDebug.ts";

export const EditorDebugLive = Layer.effect(
  EditorDebug,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const service = new EditorDebugService(config.stateDir);
    yield* Effect.addFinalizer(() => Effect.promise(() => service.dispose()));
    return {
      start: (owner, input, signal) => service.start(owner, input, signal),
      action: (owner, input) => service.action(owner, input),
      poll: (owner, id, after) => service.poll(owner, id, after),
      dispose: () => service.dispose(),
    };
  }),
);
