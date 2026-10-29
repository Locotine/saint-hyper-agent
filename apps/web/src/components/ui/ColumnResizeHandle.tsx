// FILE: ColumnResizeHandle.tsx
// Purpose: Drag or arrow-key handle on a column's right edge. The caller clamps and stores the
//          width; the handle drives the pointer session over webviews and reports the share of
//          the parent's width for the separator's value.
// Layer: UI primitive
// Exports: ColumnResizeHandle

import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

import {
  attachPanelPointerOverlaySession,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "~/lib/panelResize";

const KEYBOARD_RESIZE_STEP = 16;

export function ColumnResizeHandle({
  label,
  percent,
  columnRef,
  clampWidth,
  onResize,
}: {
  /** Accessible name, e.g. "Resize file tree". */
  label: string;
  percent: number;
  columnRef: RefObject<HTMLElement | null>;
  clampWidth: (width: number, containerWidth: number) => number;
  onResize: (width: number, percent: number) => void;
}) {
  const resizeTo = (width: number) => {
    const containerWidth = columnRef.current?.parentElement?.clientWidth;
    if (!containerWidth) return;
    const clamped = clampWidth(width, containerWidth);
    onResize(clamped, Math.round((clamped / containerWidth) * 100));
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const column = columnRef.current;
    if (!column || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = column.getBoundingClientRect().width;
    const overlay = createPanelResizeOverlay();
    let detach: (() => void) | null = null;
    const finish = () => {
      detach?.();
      removePanelResizeOverlay(overlay);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    detach = attachPanelPointerOverlaySession(overlay, {
      onMove: (moveEvent) => resizeTo(startWidth + moveEvent.clientX - startX),
      onRelease: finish,
      onAbort: finish,
    });
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft"
        ? -KEYBOARD_RESIZE_STEP
        : event.key === "ArrowRight"
          ? KEYBOARD_RESIZE_STEP
          : 0;
    const column = columnRef.current;
    if (step === 0 || !column) return;
    event.preventDefault();
    resizeTo(column.getBoundingClientRect().width + step);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${percent}% of the width`}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={handleKeyDown}
      className="absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-[var(--app-surface-divider)] focus-visible:outline-none focus-visible:before:w-0.5 focus-visible:before:bg-ring"
    />
  );
}
