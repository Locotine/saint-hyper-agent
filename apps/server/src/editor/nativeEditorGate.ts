// FILE: nativeEditorGate.ts
// Purpose: Apply the shared native-editor availability policy to server RPCs.
//          Stable and Beta both expose the language service and debugger.
// Layer: Server runtime gate
// Exports: NATIVE_EDITOR_UNAVAILABLE_CODE, nativeEditorUnavailableError, requireNativeEditor

import { Effect } from "effect";
import { WsRpcError } from "@saint/contracts";
import { isBetaFeatureEnabled, NATIVE_EDITOR_BETA_FEATURE } from "@saint/shared/betaFeatures";
import type { SaintDesktopFlavor } from "@saint/shared/desktopIdentity";

import { SERVER_DESKTOP_FLAVOR } from "../betaFeatureGate";

export const NATIVE_EDITOR_UNAVAILABLE_CODE = "NATIVE_EDITOR_UNAVAILABLE";

/** The refusal for a host flavor that does not ship the native editor, or null when it does. */
export function nativeEditorUnavailableError(
  flavor: SaintDesktopFlavor | "unknown",
): WsRpcError | null {
  if (isBetaFeatureEnabled(NATIVE_EDITOR_BETA_FEATURE, flavor)) return null;
  return new WsRpcError({
    message: "The native editor is unavailable in this build of Saint.",
    code: NATIVE_EDITOR_UNAVAILABLE_CODE,
    retryable: false,
  });
}

const refusal = nativeEditorUnavailableError(SERVER_DESKTOP_FLAVOR);
/** Fails an editor RPC on hosts that do not ship the native editor. */
export const requireNativeEditor: Effect.Effect<void, WsRpcError> = refusal
  ? Effect.fail(refusal)
  : Effect.void;
