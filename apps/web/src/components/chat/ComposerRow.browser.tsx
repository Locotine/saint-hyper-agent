import "../../index.css";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ChatComposerFooter } from "./ChatComposerFooter";
import { useComposerSingleRow } from "./useComposerSingleRow";
import { useComposerOverlayHeight } from "./composerOverlay";
import {
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME,
  COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME,
} from "./composerPickerStyles";

function ComposerRow({
  onOpenPlan = () => {},
  prompt = "hello",
  containerWidth = 600,
}: {
  onOpenPlan?: () => void;
  prompt?: string;
  containerWidth?: number;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [recording, setRecording] = useState(false);
  const row = useComposerSingleRow({ formRef, eligible: true, prompt });
  const { overlayRef, overlayBottomClearancePx } = useComposerOverlayHeight();
  return (
    <div style={{ paddingTop: 200, width: containerWidth }}>
      <output aria-label="Footer clearance">{overlayBottomClearancePx}</output>
      <div ref={overlayRef}>
        <div style={{ height: 64 }}>Queued follow-up</div>
        <form ref={formRef} data-testid="row-form" data-layout={row ? "row" : "block"}>
          <div
            data-chat-composer-surface=""
            className={`${COMPOSER_INPUT_SURFACE_CLASS_NAME} ${row ? COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME : ""}`}
          >
            <div
              className={row ? COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME : ""}
              style={recording ? { display: "none" } : undefined}
            >
              <div data-testid="composer-editor" style={{ lineHeight: "24px" }}>
                <p>{prompt}</p>
              </div>
            </div>
            <ChatComposerFooter
              layout={row ? "row" : "block"}
              isComposerFooterCompact={false}
              leadingControls={<button type="button">Attach</button>}
              composerPickerControls={null}
              contextMeter={null}
              interactionMode="default"
              resetInteractionMode={() => {}}
              sidebarAction={{ title: "Show plan sidebar", label: "Plan", onClick: onOpenPlan }}
              voice={{
                enabled: true,
                recording,
                starting: false,
                waitingForAudio: false,
                transcribing: false,
                durationLabel: "0:01",
                waveformLevels: [],
                onCancel: () => setRecording(false),
                onSubmit: () => setRecording(false),
                onToggle: () => setRecording(true),
              }}
              pendingInput={null}
              submission={{
                phase: "ready",
                busy: false,
                connecting: false,
                expired: false,
                preparingImages: false,
                preparingWorktree: false,
                hasContent: true,
                hasPendingUserInputs: false,
                showPlanFollowUp: false,
                hasPrompt: true,
                onInterrupt: () => {},
                onImplementInNewThread: () => {},
              }}
            />
          </div>
        </form>
      </div>
    </div>
  );
}

beforeEach(async () => {
  await page.viewport(800, 600);
});
afterEach(cleanup);

it("measures the rendered row controls without masking the queued content above them", async () => {
  await render(<ComposerRow />);
  await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "row");
  await expect
    .element(page.getByRole("status", { name: "Footer clearance" }))
    .toHaveTextContent("52");
});

it("keeps row layout during dictation and after returning to the draft", async () => {
  await render(<ComposerRow />);
  await page.getByRole("button", { name: "Record voice note" }).click();
  await expect.element(page.getByRole("button", { name: "Stop voice recording" })).toBeVisible();
  await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "row");
  await page.getByRole("button", { name: "Stop voice recording" }).click();
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "row");
});

it("keeps the plan accessible in the compact row even without a task capsule", async () => {
  const openPlan = vi.fn();
  await render(<ComposerRow onOpenPlan={openPlan} />);
  await page.getByRole("button", { name: "Show plan sidebar" }).click();
  expect(openPlan).toHaveBeenCalledOnce();
});

it("expands to block layout without oscillating when prompt width exceeds the single-row slot", async () => {
  const shortPrompt = "hi";
  // Wide enough to wrap inside the ~300px single-row slot, but short enough to sit on
  // one line once expanded to the full 600px block width (the exact historical oscillation zone).
  const borderlinePrompt = "https://github.com/elementalsouls/Claude-BugHunter kéo repo này";
  const screen = await render(<ComposerRow prompt={shortPrompt} containerWidth={600} />);
  const form = page.getByTestId("row-form").element();
  await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "row");

  const transitions: string[] = [];
  const observer = new MutationObserver(() => {
    const layout = form.getAttribute("data-layout");
    if (layout) transitions.push(layout);
  });
  observer.observe(form, { attributes: true, attributeFilter: ["data-layout"] });

  try {
    await screen.rerender(<ComposerRow prompt={borderlinePrompt} containerWidth={600} />);
    await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "block");

    // Wait several animation frames to confirm ResizeObserver never oscillates back to "row".
    for (let i = 0; i < 6; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    expect(form.getAttribute("data-layout")).toBe("block");
    expect(transitions).toEqual(["block"]);

    // Clearing the prompt cleanly returns to single-row mode.
    await screen.rerender(<ComposerRow prompt="" containerWidth={600} />);
    await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "row");
  } finally {
    observer.disconnect();
  }
});
