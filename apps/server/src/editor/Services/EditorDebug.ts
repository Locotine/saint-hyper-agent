import type {
  EditorDebugActionInput,
  EditorDebugActionResult,
  EditorDebugSnapshot,
  EditorDebugStartInput,
} from "@saint/contracts";
import { ServiceMap } from "effect";

export interface EditorDebugShape {
  readonly start: (
    owner: string,
    input: EditorDebugStartInput,
    signal?: AbortSignal,
  ) => Promise<{ sessionId: string }>;
  readonly action: (
    owner: string,
    input: EditorDebugActionInput,
  ) => Promise<EditorDebugActionResult>;
  readonly poll: (owner: string, id: string, after: number) => EditorDebugSnapshot;
  readonly dispose: () => Promise<void>;
}

export class EditorDebug extends ServiceMap.Service<EditorDebug, EditorDebugShape>()(
  "saint/editor/Services/EditorDebug",
) {}
