// FILE: OfficeWidgetView.tsx
// Purpose: The floating always-on-top office window: just the office, draggable by its top strip.
// Layer: Web office view (route component for /office-widget, desktop only)
// Exports: OfficeWidgetView

import type { ThreadId } from "@saint/contracts";
import { useMemo, useState } from "react";

import { OfficeCanvas } from "./OfficeCanvas";
import { useOfficeState } from "./useOfficeState";

export function OfficeWidgetView() {
  const office = useOfficeState();
  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId | null>(null);
  const engineState = useMemo(
    () => ({ agents: office.agents, layout: office.layout, selectedThreadId }),
    [office.agents, office.layout, selectedThreadId],
  );
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#f7f7f7]">
      {/* Grab strip: Tauri moves the frameless window from elements marked as drag regions. */}
      <div data-tauri-drag-region className="drag-region h-3 shrink-0 cursor-grab" />
      <OfficeCanvas className="flex-1" state={engineState} onSelect={setSelectedThreadId} />
    </div>
  );
}
