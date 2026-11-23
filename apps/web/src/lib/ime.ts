// FILE: ime.ts
// Purpose: Cross-OS IME composition guard for keydown handlers (Windows/Linux keyCode 229 + standard isComposing).
// Layer: Web input utility

export interface KeyEventLike {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly nativeEvent?: {
    readonly isComposing?: boolean;
    readonly keyCode?: number;
  };
}

export function isImeComposingKeyEvent(event: KeyEventLike): boolean {
  const native = event.nativeEvent;
  return Boolean(
    event.isComposing || event.keyCode === 229 || native?.isComposing || native?.keyCode === 229,
  );
}
