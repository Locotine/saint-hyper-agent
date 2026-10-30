import type { FlowNodeRun, FlowSpec } from "@saint/contracts";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../index.css";

import { FlowCanvas, type FlowCanvasSelection } from "./FlowCanvas";

const spec: FlowSpec = {
  version: "flow-v1",
  name: "Diamond",
  nodes: ["plan", "api", "ui", "qa"].map((id) => ({ id, role: `Role ${id}`, prompt: "p" })),
  edges: [
    { from: "plan", to: "api" },
    { from: "plan", to: "ui", policy: "hold" },
    { from: "api", to: "qa" },
    { from: "ui", to: "qa" },
  ],
};

const run = (nodeId: string, status: FlowNodeRun["status"]) =>
  [nodeId, { nodeId, status } as FlowNodeRun] as const;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "1200px";
  host.style.height = "600px";
  host.style.display = "flex";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

function render(props: {
  editable: boolean;
  onSelect?: (selection: FlowCanvasSelection) => void;
  onConnect?: (from: string, to: string) => void;
}) {
  flushSync(() =>
    root.render(
      <FlowCanvas
        spec={spec}
        nodeRuns={new Map([run("plan", "settled"), run("api", "running"), run("ui", "pending")])}
        approvedEdges={new Set()}
        selection={null}
        onSelect={props.onSelect ?? (() => {})}
        onConnect={props.onConnect ?? (() => {})}
        editable={props.editable}
      />,
    ),
  );
}

const nodeBox = (id: string) =>
  host.querySelector<HTMLElement>(`[data-flow-node-id="${id}"]`)!.getBoundingClientRect();

describe("FlowCanvas", () => {
  it("lays the diamond out left to right and marks live and held edges", () => {
    render({ editable: false });
    expect(nodeBox("api").left).toBe(nodeBox("ui").left);
    expect(nodeBox("plan").left).toBeLessThan(nodeBox("api").left);
    expect(nodeBox("qa").left).toBeGreaterThan(nodeBox("api").left);
    const states = [...host.querySelectorAll("[data-edge-state]")].map((edge) =>
      edge.getAttribute("data-edge-state"),
    );
    expect(states).toEqual(["live", "hold", "idle", "idle"]);
    expect(host.textContent).toContain("api · Running");
    // A read-only Canvas has no connect handles.
    expect(host.querySelector('[title="Drag onto another step to connect"]')).toBeNull();
  });

  it("selects a step on click and connects two steps by dragging the handle", () => {
    const onSelect = vi.fn();
    const onConnect = vi.fn();
    render({ editable: true, onSelect, onConnect });
    host.querySelector<HTMLElement>('[data-flow-node-id="qa"] button')!.click();
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "qa" });

    const handle = host.querySelector<HTMLElement>(
      '[data-flow-node-id="api"] [title="Drag onto another step to connect"]',
    )!;
    const from = handle.getBoundingClientRect();
    const to = nodeBox("ui");
    const pointer = (type: string, target: Element, x: number, y: number) =>
      flushSync(() =>
        target.dispatchEvent(
          new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }),
        ),
      );
    pointer("pointerdown", handle, from.x + 2, from.y + 2);
    const surface = host.querySelector('[data-testid="flow-canvas"] > div')!;
    pointer("pointermove", surface, to.x + 20, to.y + 20);
    pointer("pointerup", surface, to.x + 20, to.y + 20);
    expect(onConnect).toHaveBeenCalledWith("api", "ui");
  });
});
