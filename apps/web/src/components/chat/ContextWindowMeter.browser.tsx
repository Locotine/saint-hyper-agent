// Verify the actual tooltip keeps the applied mode separate from runtime usage.
import { EventId, type OrchestrationThreadActivity } from "@saint/contracts";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  deriveAppliedContextWindowSelection,
  deriveContextWindowSelectionStatus,
  deriveLatestContextWindowState,
} from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

it("shows Auto as applied with the 967k runtime threshold and no pending Auto", async () => {
  const activities: OrchestrationThreadActivity[] = [
    {
      id: EventId.makeUnsafe("config"),
      kind: "context-window.configured",
      tone: "info",
      summary: "Auto",
      payload: { cleared: true },
      turnId: null,
      createdAt: "2026-09-17T00:00:00Z",
    },
    {
      id: EventId.makeUnsafe("usage"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Usage",
      payload: { usedTokens: 500_000, maxTokens: 967_000, usedPercent: 51.7 },
      turnId: null,
      createdAt: "2026-09-17T00:00:01Z",
    },
  ];
  const usage = deriveLatestContextWindowState(activities).snapshot!;
  const status = deriveContextWindowSelectionStatus({
    activeSnapshot: usage,
    selectedValue: "auto",
    appliedValue: deriveAppliedContextWindowSelection(activities),
  });
  await render(
    <ContextWindowMeter
      usage={usage}
      showClaudeCache
      activeWindowLabel={status.activeLabel}
      pendingWindowLabel={status.pendingSelectedLabel}
    />,
  );
  await page.getByRole("button", { name: "Context window 52% used" }).click();
  await expect.element(page.getByText("Auto-compact target: Auto")).toBeVisible();
  await expect.element(page.getByText("Active context limit: 967k tokens")).toBeVisible();
  await expect.element(page.getByText("Next turn:", { exact: false })).not.toBeInTheDocument();
});

it("keeps 0% as an empty track and renders a minimum visible arc for small Antigravity usage", async () => {
  const zeroActivities: OrchestrationThreadActivity[] = [
    {
      id: EventId.makeUnsafe("zero"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Usage",
      payload: { usedTokens: 0, maxTokens: 1_048_576, usedPercent: 0 },
      turnId: null,
      createdAt: "2026-11-23T00:00:00Z",
    },
  ];
  const zeroUsage = deriveLatestContextWindowState(zeroActivities).snapshot!;
  const view = await render(<ContextWindowMeter usage={zeroUsage} />);
  const zeroButton = page.getByRole("button", { name: "Context window 0% used" }).element();
  expect(zeroButton.querySelectorAll("circle")).toHaveLength(1);

  const smallActivities: OrchestrationThreadActivity[] = [
    {
      id: EventId.makeUnsafe("small"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Usage",
      payload: { usedTokens: 26_000, maxTokens: 1_048_576, usedPercent: 2.48 },
      turnId: null,
      createdAt: "2026-11-23T00:00:01Z",
    },
  ];
  const smallUsage = deriveLatestContextWindowState(smallActivities).snapshot!;
  await view.rerender(<ContextWindowMeter usage={smallUsage} />);
  const smallButton = page.getByRole("button", { name: "Context window 2.5% used" }).element();
  const circles = smallButton.querySelectorAll("circle");
  expect(circles).toHaveLength(2);
  const circumference = 2 * Math.PI * 6;
  const dashOffset = Number(circles[1]?.getAttribute("stroke-dashoffset"));
  expect(dashOffset).toBeCloseTo(circumference * 0.95, 2);
});
