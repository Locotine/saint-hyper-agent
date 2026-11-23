import "../index.css";

import { createRef, useState, type ComponentProps, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

type EditorProps = ComponentProps<typeof ComposerPromptEditor>;

async function mountEditor() {
  const ref = createRef<ComposerPromptEditorHandle>();
  let props: EditorProps = {
    value: "Original draft",
    cursor: 4,
    terminalContexts: [],
    disabled: false,
    placeholder: "Write a message",
    ariaLabel: "Message",
    onRemoveTerminalContext: vi.fn(),
    onChange: vi.fn(),
    onPaste: vi.fn(),
  };
  const content = () => (
    <>
      <input aria-label="Another control" />
      <ComposerPromptEditor {...props} ref={ref} />
    </>
  );
  const screen = await render(content());
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  const otherControl = document.querySelector<HTMLInputElement>(
    'input[aria-label="Another control"]',
  )!;
  return {
    ref,
    editor,
    otherControl,
    update: async (updates: Partial<EditorProps>) => {
      props = { ...props, ...updates };
      await screen.rerender(content());
    },
  };
}

async function settleSelection() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function focusParentFrame() {
  expect(window.parent).not.toBe(window);
  const body = window.parent.document.body;
  const originalTabIndex = body.getAttribute("tabindex");
  body.tabIndex = -1;
  body.focus();
  return () => {
    if (originalTabIndex === null) body.removeAttribute("tabindex");
    else body.setAttribute("tabindex", originalTabIndex);
  };
}

describe("ComposerPromptEditor focus ownership", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("updates a controlled draft without taking focus from another control", async () => {
    const mounted = await mountEditor();
    mounted.otherControl.focus();
    mounted.otherControl.value = "Keep my selection";
    mounted.otherControl.setSelectionRange(2, 6);

    await mounted.update({ value: "Restored draft", cursor: 3 });
    await settleSelection();

    expect(mounted.editor.textContent).toBe("Restored draft");
    expect(document.activeElement).toBe(mounted.otherControl);
    expect(mounted.otherControl.selectionStart).toBe(2);
    expect(mounted.otherControl.selectionEnd).toBe(6);
    expect(mounted.ref.current?.readSnapshot()).toMatchObject({
      value: "Restored draft",
      cursor: 3,
    });
  });

  it("refreshes mention references without taking focus from another control", async () => {
    const mounted = await mountEditor();
    mounted.otherControl.focus();

    await mounted.update({
      mentionReferences: [{ name: "linear", path: "plugin://linear@openai-curated" }],
    });
    await settleSelection();

    expect(mounted.editor.textContent).toBe("Original draft");
    expect(document.activeElement).toBe(mounted.otherControl);
  });

  it("keeps a controlled update inside an inactive window unfocused", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();
    const restoreParent = focusParentFrame();
    try {
      await expect.poll(() => document.hasFocus()).toBe(false);
      await settleSelection();
      expect(mounted.ref.current?.isFocused()).toBe(false);

      await mounted.update({ value: "Background draft", cursor: 5 });
      await settleSelection();

      expect(mounted.editor.textContent).toBe("Background draft");
      expect(document.hasFocus()).toBe(false);
      expect(mounted.ref.current?.readSnapshot().cursor).toBe(5);
    } finally {
      restoreParent();
    }
  });

  it("preserves another control chosen while the composer is disabled", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();
    await mounted.update({ disabled: true });
    expect(mounted.editor.contentEditable).toBe("false");
    mounted.otherControl.focus();

    await mounted.update({ disabled: false });
    await settleSelection();

    expect(document.activeElement).toBe(mounted.otherControl);
    expect(mounted.ref.current?.isFocused()).toBe(false);
  });

  it("does not reactivate a window when the composer is re-enabled", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();
    await mounted.update({ disabled: true });
    const restoreParent = focusParentFrame();
    try {
      await expect.poll(() => document.hasFocus()).toBe(false);
      await mounted.update({ disabled: false });
      await settleSelection();

      expect(document.hasFocus()).toBe(false);
      expect(mounted.ref.current?.isFocused()).toBe(false);
    } finally {
      restoreParent();
    }
  });

  it("restores composer focus after disabling when no other control was chosen", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();
    expect(document.hasFocus()).toBe(true);
    await mounted.update({ disabled: true });
    expect(mounted.editor.contentEditable).toBe("false");
    await mounted.update({ disabled: false });

    await expect.poll(() => mounted.ref.current?.isFocused()).toBe(true);
    expect(document.activeElement).toBe(mounted.editor);
  });

  it("honors an explicit focusAtEnd after a background draft update", async () => {
    const mounted = await mountEditor();
    mounted.otherControl.focus();
    await mounted.update({ value: "Restored draft", cursor: 3 });

    mounted.ref.current?.focusAtEnd();
    await expect.poll(() => mounted.ref.current?.isFocused()).toBe(true);
    await settleSelection();

    expect(document.activeElement).toBe(mounted.editor);
    expect(mounted.ref.current?.readSnapshot()).toMatchObject({
      value: "Restored draft",
      cursor: "Restored draft".length,
      selectionCollapsed: true,
    });
    expect(window.getSelection()?.anchorOffset).toBe("Restored draft".length);
  });
});

describe("ComposerPromptEditor link paste and IME composition", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function ControlledComposerHarness({
    initialValue = "",
    onCommandKeyDown,
    editorRef,
  }: {
    initialValue?: string;
    onCommandKeyDown?: EditorProps["onCommandKeyDown"];
    editorRef: RefObject<ComposerPromptEditorHandle | null>;
  }) {
    const [value, setValue] = useState(initialValue);
    const [cursor, setCursor] = useState(initialValue.length);
    return (
      <>
        <output data-testid="controlled-value">{value}</output>
        <ComposerPromptEditor
          ref={editorRef}
          value={value}
          cursor={cursor}
          terminalContexts={[]}
          disabled={false}
          placeholder="Write a message"
          ariaLabel="Message"
          onRemoveTerminalContext={() => {}}
          onChange={(nextValue, nextCursor) => {
            setValue(nextValue);
            setCursor(nextCursor);
          }}
          onPaste={() => {}}
          {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        />
      </>
    );
  }

  it("chips a bare GitHub URL paste and stays responsive through Vietnamese IME composition", async () => {
    const ref = createRef<ComposerPromptEditorHandle>();
    const onCommandKeyDown = vi.fn(() => true);
    await render(<ControlledComposerHarness editorRef={ref} onCommandKeyDown={onCommandKeyDown} />);
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(editor);
    await settleSelection();

    const githubUrl = "https://github.com/elementalsouls/Claude-BugHunter";
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", githubUrl);
    editor.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );

    await expect.poll(() => ref.current?.readSnapshot().value).toBe(githubUrl);
    await expect
      .poll(() => editor.textContent?.includes("elementalsouls/Claude-BugHunter"))
      .toBe(true);
    await settleSelection();

    // Simulate Vietnamese IME composition lifecycle after pasting the link.
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    // Enter while composing must NEVER trigger onCommandKeyDown (submit).
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(onCommandKeyDown).not.toHaveBeenCalled();

    // End composition and type real Vietnamese text via Chromium input events.
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    await userEvent.type(editor, " kéo repo này");
    await expect.poll(() => ref.current?.readSnapshot().value).toBe(`${githubUrl} kéo repo này`);
    await settleSelection();

    // After composition ends, normal Enter reaches onCommandKeyDown again.
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(onCommandKeyDown).toHaveBeenCalledTimes(1);
  });

  it("defers controlled prop sync while IME composition is active and ignores stale echoed values", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();

    // Start an active DOM IME composition session.
    mounted.editor.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
    );

    // Controlled prop update arrives mid-composition: must NOT wipe/rewrite the editor DOM yet.
    await mounted.update({ value: "External update during IME", cursor: 8 });
    await settleSelection();
    expect(mounted.editor.textContent?.replaceAll("\u200b", "")).toBe("Original draft");

    // Once composition ends, the pending controlled sync flushes cleanly.
    mounted.editor.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "" }),
    );
    await expect
      .poll(() => mounted.editor.textContent?.replaceAll("\u200b", ""))
      .toBe("External update during IME");
    expect(mounted.ref.current?.readSnapshot().value).toBe("External update during IME");
  });
});
