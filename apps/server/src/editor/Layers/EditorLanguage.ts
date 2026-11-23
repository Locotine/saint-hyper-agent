import { Effect, Layer } from "effect";

import { EditorLanguageService } from "../languageService.ts";
import { EditorLanguage } from "../Services/EditorLanguage.ts";

export const EditorLanguageLive = Layer.effect(
  EditorLanguage,
  Effect.gen(function* () {
    const service = new EditorLanguageService();
    yield* Effect.addFinalizer(() => Effect.sync(() => service.dispose()));
    return {
      request: (clientId, input, signal) => service.request(clientId, input, signal),
      dispose: () => service.dispose(),
    };
  }),
);
