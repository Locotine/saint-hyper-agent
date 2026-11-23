import type { EditorIntelligenceInput, EditorIntelligenceResult } from "@saint/contracts";
import { ServiceMap } from "effect";

export interface EditorLanguageShape {
  readonly request: (
    clientId: string,
    input: EditorIntelligenceInput,
    signal?: AbortSignal,
  ) => Promise<EditorIntelligenceResult>;
  readonly dispose: () => void;
}

export class EditorLanguage extends ServiceMap.Service<EditorLanguage, EditorLanguageShape>()(
  "saint/editor/Services/EditorLanguage",
) {}
