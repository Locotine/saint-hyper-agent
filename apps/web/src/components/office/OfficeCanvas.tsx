// FILE: OfficeCanvas.tsx
// Purpose: Mounts the Pixi office engine into a React-owned box and feeds it state.
// Layer: Web office view
// Exports: OfficeCanvas

import { useEffect, useEffectEvent, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import type { ThreadId } from "@saint/contracts";

import {
  createOfficeEngine,
  type OfficeEngine,
  type OfficeEngineState,
} from "./engine/officeEngine";

export function OfficeCanvas(props: {
  readonly state: OfficeEngineState;
  readonly onSelect: (threadId: ThreadId) => void;
  readonly className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleSelect = useEffectEvent((threadId: ThreadId) => props.onSelect(threadId));
  const handleReady = useEffectEvent((scene: OfficeEngine) => scene.update(props.state));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let scene: OfficeEngine | null = null;
    createOfficeEngine(host, { onSelect: (desk) => handleSelect(desk) })
      .then((created) => {
        if (cancelled) {
          created.destroy();
          return;
        }
        scene = created;
        sceneRef.current = created;
        handleReady(created);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      scene?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.update(props.state);
  }, [props.state]);

  return (
    <div ref={hostRef} className={cn("relative min-h-0 min-w-0 overflow-hidden", props.className)}>
      {error ? (
        <p className="absolute inset-0 flex items-center justify-center p-6 text-ui text-muted-foreground">
          The office could not load: {error}
        </p>
      ) : null}
    </div>
  );
}
