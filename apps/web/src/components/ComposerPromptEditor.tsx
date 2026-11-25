import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { useLexicalEditable } from "@lexical/react/useLexicalEditable";
import {
  $addUpdateTag,
  $createRangeSelection,
  $getSelection,
  $setSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  SKIP_DOM_SELECTION_TAG,
  KEY_BACKSPACE_COMMAND,
  PASTE_COMMAND,
  TextNode,
  $getRoot,
  $nodesOfType,
  type ElementNode,
  type LexicalNode,
  type EditorState,
} from "lexical";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEventHandler,
  type Ref,
  type RefObject,
} from "react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "~/composer-logic";
import {
  matchComposerLinkToken,
  matchComposerSlashCommandChipToken,
  splitPromptIntoComposerSegments,
} from "~/composer-editor-mentions";
import { parseBareComposerLink } from "~/lib/linkChips";
import { hasExplicitClipboardImageSignal } from "~/hooks/useComposerDropzone";
import { type TerminalContextDraft } from "~/lib/terminalContext";
import { shouldCollapsePastedText } from "~/lib/composerPastedText";
import type { ProviderMentionReference } from "@saint/contracts";
import { useStore } from "~/store";
import { createComposerThreadMentionSourcesSelector } from "~/storeSelectors";
import { resolveThreadDisplayProvider } from "~/lib/threadDisplayProvider";
import { cn } from "~/lib/utils";
import {
  COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
} from "./chat/composerPickerStyles";
import {
  ComposerMentionNode,
  ComposerSkillNode,
  ComposerSlashCommandNode,
  ComposerAgentMentionNode,
  ComposerTerminalContextNode,
  ComposerLinkNode,
  $createComposerMentionNode,
  $createComposerSkillNode,
  $createComposerSlashCommandNode,
  $createComposerAgentMentionNode,
  $createComposerTerminalContextNode,
  $createComposerLinkNode,
  isComposerInlineTokenNode,
  COMPOSER_NODE_CLASSES,
  type ComposerInlineTokenNode,
} from "./composer-nodes";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;
const CONTROLLED_UPDATE_TAG = "saint-composer-controlled-sync";
const RECENT_EMITTED_VALUE_LIMIT = 16;
// WebKit (macOS Safari / Linux WebKitGTK) dispatches `compositionend` immediately before the
// committing `keydown(Enter)` with `isComposing === false` and `keyCode === 13` (WebKit #165004).
const COMPOSER_POST_COMPOSITION_GRACE_MS = 35;

const ComposerRemoveTerminalContextContext = createContext<(contextId: string) => void>(() => {});

// Node classes imported from ./composer-nodes

function terminalContextSignature(contexts: ReadonlyArray<TerminalContextDraft>): string {
  return contexts
    .map((context) =>
      [
        context.id,
        context.threadId,
        context.terminalId,
        context.terminalLabel,
        context.lineStart,
        context.lineEnd,
        context.createdAt,
        context.text,
      ].join("\u001f"),
    )
    .join("\u001e");
}

function mentionReferencesSignature(mentions: ReadonlyArray<ProviderMentionReference>): string {
  return mentions.map((mention) => `${mention.name}\u0000${mention.path}`).join("\u0001");
}

function clampExpandedCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.floor(cursor)));
}

function getComposerInlineTokenTextLength(_node: ComposerInlineTokenNode): 1 {
  return 1;
}

function getComposerInlineTokenExpandedTextLength(node: ComposerInlineTokenNode): number {
  return node.getTextContentSize();
}

function getAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenTextLength(node) : 0);
}

function getExpandedAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenExpandedTextLength(node) : 0);
}

function findSelectionPointForInlineToken(
  node: ComposerInlineTokenNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "element" } | null {
  const parent = node.getParent();
  if (!parent || !$isElementNode(parent)) return null;
  const index = node.getIndexWithinParent();
  if (remainingRef.value === 0) {
    return {
      key: parent.getKey(),
      offset: index,
      type: "element",
    };
  }
  if (remainingRef.value === getComposerInlineTokenTextLength(node)) {
    return {
      key: parent.getKey(),
      offset: index + 1,
      type: "element",
    };
  }
  remainingRef.value -= getComposerInlineTokenTextLength(node);
  return null;
}

function getComposerNodeTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenTextLength(node);
  }
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isLineBreakNode(node)) {
    return 1;
  }
  if ($isElementNode(node)) {
    return node.getChildren().reduce((total, child) => total + getComposerNodeTextLength(child), 0);
  }
  return 0;
}

function getComposerNodeExpandedTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenExpandedTextLength(node);
  }
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isLineBreakNode(node)) {
    return 1;
  }
  if ($isElementNode(node)) {
    return node
      .getChildren()
      .reduce((total, child) => total + getComposerNodeExpandedTextLength(child), 0);
  }
  return 0;
}

function getAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent = current.getParent() as LexicalNode | null;
    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }
    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      offset += getComposerNodeTextLength(sibling);
    }
    current = nextParent;
  }

  if (node instanceof ComposerLinkNode || node instanceof ComposerTerminalContextNode) {
    return getAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isTextNode(node)) {
    if (
      node instanceof ComposerMentionNode ||
      node instanceof ComposerSkillNode ||
      node instanceof ComposerSlashCommandNode ||
      node instanceof ComposerAgentMentionNode
    ) {
      return getAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
    }
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];
      if (!child) continue;
      offset += getComposerNodeTextLength(child);
    }
    return offset;
  }

  return offset;
}

function getExpandedAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent = current.getParent() as LexicalNode | null;
    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }
    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      offset += getComposerNodeExpandedTextLength(sibling);
    }
    current = nextParent;
  }

  if (node instanceof ComposerLinkNode || node instanceof ComposerTerminalContextNode) {
    return getExpandedAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isTextNode(node)) {
    if (
      node instanceof ComposerMentionNode ||
      node instanceof ComposerSkillNode ||
      node instanceof ComposerSlashCommandNode ||
      node instanceof ComposerAgentMentionNode
    ) {
      return getExpandedAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
    }
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];
      if (!child) continue;
      offset += getComposerNodeExpandedTextLength(child);
    }
    return offset;
  }

  return offset;
}

function findSelectionPointAtOffset(
  node: LexicalNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "text" | "element" } | null {
  if (
    node instanceof ComposerMentionNode ||
    node instanceof ComposerSkillNode ||
    node instanceof ComposerSlashCommandNode ||
    node instanceof ComposerAgentMentionNode ||
    node instanceof ComposerLinkNode ||
    node instanceof ComposerTerminalContextNode
  ) {
    return findSelectionPointForInlineToken(node, remainingRef);
  }

  if ($isTextNode(node)) {
    const size = node.getTextContentSize();
    if (remainingRef.value <= size) {
      return {
        key: node.getKey(),
        offset: remainingRef.value,
        type: "text",
      };
    }
    remainingRef.value -= size;
    return null;
  }

  if ($isLineBreakNode(node)) {
    const parent = node.getParent();
    if (!parent) return null;
    const index = node.getIndexWithinParent();
    if (remainingRef.value === 0) {
      return {
        key: parent.getKey(),
        offset: index,
        type: "element",
      };
    }
    if (remainingRef.value === 1) {
      return {
        key: parent.getKey(),
        offset: index + 1,
        type: "element",
      };
    }
    remainingRef.value -= 1;
    return null;
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    for (const child of children) {
      const point = findSelectionPointAtOffset(child, remainingRef);
      if (point) {
        return point;
      }
    }
    if (remainingRef.value === 0) {
      return {
        key: node.getKey(),
        offset: children.length,
        type: "element",
      };
    }
  }

  return null;
}

function $getComposerRootLength(): number {
  const root = $getRoot();
  const children = root.getChildren();
  return children.reduce((sum, child) => sum + getComposerNodeTextLength(child), 0);
}

function $setSelectionAtComposerOffset(nextOffset: number): void {
  const root = $getRoot();
  const composerLength = $getComposerRootLength();
  const boundedOffset = Math.max(0, Math.min(nextOffset, composerLength));
  const remainingRef = { value: boundedOffset };
  const point = findSelectionPointAtOffset(root, remainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };
  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
}

function $readSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = getAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const composerLength = $getComposerRootLength();
  return Math.max(0, Math.min(offset, composerLength));
}

function $readExpandedSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = getExpandedAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const expandedLength = $getRoot().getTextContent().length;
  return Math.max(0, Math.min(offset, expandedLength));
}

function $appendTextWithLineBreaks(parent: ElementNode, text: string): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > 0) {
      parent.append($createTextNode(line));
    }
    if (index < lines.length - 1) {
      parent.append($createLineBreakNode());
    }
  }
}

function $setComposerEditorPrompt(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft>,
  mentionReferences: ReadonlyArray<ProviderMentionReference> = [],
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);

  const segments = splitPromptIntoComposerSegments(prompt, terminalContexts, mentionReferences);
  for (const segment of segments) {
    if (segment.type === "mention") {
      const thread = segment.threadId
        ? useStore.getState().sidebarThreadSummaryById[segment.threadId]
        : undefined;
      const provider = thread ? resolveThreadDisplayProvider(thread) : undefined;
      paragraph.append(
        $createComposerMentionNode(segment.path, segment.kind, provider, segment.threadId),
      );
      continue;
    }
    if (segment.type === "skill") {
      const prefixedName = `${segment.prefix ?? "$"}${segment.name}`;
      paragraph.append($createComposerSkillNode(prefixedName));
      continue;
    }
    if (segment.type === "slash-command") {
      paragraph.append($createComposerSlashCommandNode(segment.command));
      continue;
    }
    if (segment.type === "terminal-context") {
      if (segment.context) {
        paragraph.append($createComposerTerminalContextNode(segment.context));
      }
      continue;
    }
    if (segment.type === "agent-mention") {
      paragraph.append($createComposerAgentMentionNode(segment.alias, segment.color));
      continue;
    }
    if (segment.type === "link") {
      paragraph.append($createComposerLinkNode(segment.url));
      continue;
    }
    $appendTextWithLineBreaks(paragraph, segment.text);
  }
}

function collectTerminalContextIds(node: LexicalNode): string[] {
  if (node instanceof ComposerTerminalContextNode) {
    return [node.__context.id];
  }
  if ($isElementNode(node)) {
    return node.getChildren().flatMap((child) => collectTerminalContextIds(child));
  }
  return [];
}

export interface ComposerPromptEditorHandle {
  blur: () => void;
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  isFocused: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    selectionCollapsed: boolean;
    terminalContextIds: string[];
  };
}

interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  disabled: boolean;
  placeholder: string;
  ariaLabel?: string | undefined;
  className?: string;
  /** One-line field for the single-row composer: one line tall, placeholder truncated. */
  singleLine?: boolean;
  onRemoveTerminalContext: (contextId: string) => void;
  /**
   * Invoked when a sufficiently large text paste should collapse into an attachment
   * card instead of inserting raw text. When omitted, pastes insert as text.
   */
  onCollapsePastedText?: (text: string) => void;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
    isComposing?: boolean,
  ) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => boolean;
  onPaste: ClipboardEventHandler<HTMLElement>;
}

interface ComposerPromptEditorInnerProps extends ComposerPromptEditorProps {
  editorRef: Ref<ComposerPromptEditorHandle>;
}

function ComposerCommandKeyPlugin(props: {
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => boolean;
  isDomComposingRef: RefObject<boolean>;
  lastCompositionEndAtRef: RefObject<number>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handleCommand = (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
      event: KeyboardEvent | null,
    ): boolean => {
      if (!props.onCommandKeyDown || !event) {
        return false;
      }
      const recentlyEndedComposition =
        props.lastCompositionEndAtRef.current > 0 &&
        performance.now() - props.lastCompositionEndAtRef.current <=
          COMPOSER_POST_COMPOSITION_GRACE_MS;
      // Never intercept keys during active IME composition (e.g. Vietnamese Telex/VNI on WebKitGTK)
      // or during the immediate post-compositionend WebKit Enter commit frame.
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        props.isDomComposingRef.current ||
        recentlyEndedComposition
      ) {
        return false;
      }
      const handled = props.onCommandKeyDown(key, event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handleCommand("Enter", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handleCommand("Tab", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterSlash = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) =>
        event instanceof KeyboardEvent && event.key === "/" ? handleCommand("Slash", event) : false,
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEnter();
      unregisterTab();
      unregisterSlash();
    };
  }, [editor, props]);

  return null;
}

function $isCollapsedSelectionAdjacentToInlineTokenNode(
  selection: ReturnType<typeof $getSelection>,
  direction: "left" | "right",
): boolean {
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = selection.anchor.offset;
  if ($isElementNode(anchorNode)) {
    const childIndex = direction === "left" ? offset - 1 : offset;
    if (childIndex < 0 || childIndex >= anchorNode.getChildrenSize()) {
      return false;
    }
    return isComposerInlineTokenNode(anchorNode.getChildAtIndex(childIndex));
  }
  if (isComposerInlineTokenNode(anchorNode)) {
    return direction === "left" ? offset > 0 : offset === 0;
  }
  if ($isTextNode(anchorNode)) {
    if (direction === "left" && offset === 0) {
      return isComposerInlineTokenNode(anchorNode.getPreviousSibling());
    }
    if (direction === "right" && offset === anchorNode.getTextContentSize()) {
      return isComposerInlineTokenNode(anchorNode.getNextSibling());
    }
  }
  return false;
}

function ComposerInlineTokenArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          if (currentOffset <= 0) return;
          const promptValue = $getRoot().getTextContent();
          if (
            !$isCollapsedSelectionAdjacentToInlineTokenNode(selection, "left") &&
            !isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "left")
          ) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          const composerLength = $getComposerRootLength();
          if (currentOffset >= composerLength) return;
          const promptValue = $getRoot().getTextContent();
          if (
            !$isCollapsedSelectionAdjacentToInlineTokenNode(selection, "right") &&
            !isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "right")
          ) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

// WebKitGTK can drop `insertText` beforeinput events when a collapsed ElementPoint caret sits
// directly beside an inline DecoratorNode (e.g. right after pasting a bare GitHub link chip with
// no adjacent `#text` node). Inserting via Lexical's RangeSelection creates a real editable
// TextNode immediately so subsequent typing and IME composition proceed natively.
function ComposerDecoratorAdjacentInputPlugin(props: { isDomComposingRef: RefObject<boolean> }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      BEFORE_INPUT_COMMAND,
      (event) => {
        if (
          props.isDomComposingRef.current ||
          event.isComposing ||
          event.inputType !== "insertText" ||
          typeof event.data !== "string" ||
          event.data.length === 0 ||
          event.data.includes("\n")
        ) {
          return false;
        }
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }
        const anchorNode = selection.anchor.getNode();
        const adjacentToDecorator =
          $isElementNode(anchorNode) &&
          (anchorNode.getChildAtIndex(selection.anchor.offset - 1) instanceof ComposerLinkNode ||
            anchorNode.getChildAtIndex(selection.anchor.offset - 1) instanceof
              ComposerTerminalContextNode ||
            anchorNode.getChildAtIndex(selection.anchor.offset) instanceof ComposerLinkNode ||
            anchorNode.getChildAtIndex(selection.anchor.offset) instanceof
              ComposerTerminalContextNode);
        if (!adjacentToDecorator) {
          return false;
        }
        event.preventDefault();
        selection.insertRawText(event.data);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, props.isDomComposingRef]);

  return null;
}

function ComposerInlineTokenSelectionNormalizePlugin(props: {
  isDomComposingRef: RefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Guard against WebKitGTK selection canonicalization bouncing a collapsed caret
    // back onto an inline token node (directly or via a 2-step bounce), which would
    // otherwise spin in an infinite microtask loop and freeze the renderer.
    let lastNormalizedSignature: string | null = null;
    let lastNormalizedNodeKey: string | null = null;
    let lastNormalizedAt = 0;
    let sameNodeNormalizationCount = 0;
    let scheduled = false;

    return editor.registerUpdateListener(({ editorState, tags }) => {
      if (props.isDomComposingRef.current || tags.has(CONTROLLED_UPDATE_TAG)) {
        return;
      }
      let afterOffset: number | null = null;
      let signature: string | null = null;
      let nodeKey: string | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          lastNormalizedSignature = null;
          return;
        }
        const anchorNode = selection.anchor.getNode();
        if (!isComposerInlineTokenNode(anchorNode)) {
          lastNormalizedSignature = null;
          return;
        }
        if (selection.anchor.offset === 0) {
          lastNormalizedSignature = null;
          return;
        }
        const beforeOffset = getAbsoluteOffsetForPoint(anchorNode, 0);
        afterOffset = beforeOffset + 1;
        nodeKey = anchorNode.getKey();
        signature = `${nodeKey}:${selection.anchor.offset}:${afterOffset}`;
      });
      if (afterOffset === null || signature === null || nodeKey === null) {
        return;
      }
      const now = performance.now();
      if (signature === lastNormalizedSignature || scheduled) {
        return;
      }
      if (nodeKey === lastNormalizedNodeKey && now - lastNormalizedAt < 1000) {
        if (sameNodeNormalizationCount >= 2) {
          return;
        }
        sameNodeNormalizationCount += 1;
      } else {
        lastNormalizedNodeKey = nodeKey;
        sameNodeNormalizationCount = 1;
      }
      lastNormalizedAt = now;
      lastNormalizedSignature = signature;
      scheduled = true;
      const targetOffset = afterOffset;
      queueMicrotask(() => {
        scheduled = false;
        if (props.isDomComposingRef.current) return;
        editor.update(
          () => {
            $setSelectionAtComposerOffset(targetOffset);
          },
          { tag: CONTROLLED_UPDATE_TAG },
        );
      });
    });
  }, [editor, props.isDomComposingRef]);

  return null;
}

function ComposerInlineTokenBackspacePlugin() {
  const [editor] = useLexicalComposerContext();
  const onRemoveTerminalContext = useContext(ComposerRemoveTerminalContextContext);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const selectionOffset = $readSelectionOffsetFromEditorState(0);
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          if (candidate instanceof ComposerTerminalContextNode) {
            onRemoveTerminalContext(candidate.__context.id);
            $setSelectionAtComposerOffset(selectionOffset);
          } else {
            $setSelectionAtComposerOffset(tokenStart);
          }
          event?.preventDefault();
          return true;
        };
        if (removeInlineTokenNode(anchorNode)) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineTokenNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineTokenNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineTokenNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onRemoveTerminalContext]);

  return null;
}

function ComposerSlashCommandTransformPlugin(props: { isDomComposingRef: RefObject<boolean> }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (node) => {
      if (
        isComposerInlineTokenNode(node) ||
        !node.isSimpleText() ||
        node.isComposing() ||
        props.isDomComposingRef.current
      ) {
        return;
      }
      const match = matchComposerSlashCommandChipToken(node.getTextContent());
      if (!match) {
        return;
      }
      const splitNodes = node.splitText(match.start, match.end);
      const commandNode = match.start === 0 ? splitNodes[0] : splitNodes[1];
      commandNode?.replace($createComposerSlashCommandNode(match.command));
    });
  }, [editor, props.isDomComposingRef]);

  return null;
}

// Converts a bare URL into a link chip as soon as a delimiter follows it while typing, mirroring
// the read-only message bubble. The controlled value→editor sync never re-tokenizes user input
// (the editor text already equals the prompt string, so the rewrite is skipped), so live chipping
// must run as a node transform. A chip's text content is the raw URL, so the serialized prompt is
// unchanged and selection/length stay stable.
function ComposerLinkTransformPlugin(props: { isDomComposingRef: RefObject<boolean> }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // registerNodeTransform(TextNode) fires only for plain text nodes; the chip subclasses have
    // their own node types and are skipped. The isComposerInlineTokenNode guard is defensive.
    return editor.registerNodeTransform(TextNode, (node) => {
      if (
        isComposerInlineTokenNode(node) ||
        !node.isSimpleText() ||
        node.isComposing() ||
        props.isDomComposingRef.current
      ) {
        return;
      }
      const match = matchComposerLinkToken(node.getTextContent(), {
        includeTrailingTokenAtEnd: false,
      });
      if (!match) {
        return;
      }
      const splitNodes = node.splitText(match.start, match.end);
      const urlNode = match.start === 0 ? splitNodes[0] : splitNodes[1];
      urlNode?.replace($createComposerLinkNode(match.url));
    });
  }, [editor, props.isDomComposingRef]);

  return null;
}

// A paste whose entire payload is one bare URL chips immediately, with no trailing delimiter,
// matching how the sent-message bubble renders it. Mixed or prose pastes fall through to the
// default handler; ComposerLinkTransformPlugin then chips any delimiter-terminated URLs in them.
function ComposerLinkPastePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const clipboardData = event instanceof ClipboardEvent ? event.clipboardData : null;
        // Let image/file attachments take precedence over a companion image URL in text/plain
        // (mirrors ComposerBigPastePlugin so browser "Copy Image" attaches the image once,
        // including on WebKitGTK where clipboardData.files is empty for image pastes).
        if (
          clipboardData &&
          (clipboardData.files.length > 0 || hasExplicitClipboardImageSignal(clipboardData))
        ) {
          return false;
        }
        const url = parseBareComposerLink(clipboardData?.getData("text/plain") ?? "");
        if (!url) {
          return false;
        }
        // Command listeners already run inside an editor update, so read the selection and insert
        // synchronously here (a nested editor.update would be deferred, letting the default paste
        // also run — a double insert). When there is no caret to insert at, fall through to the
        // default paste so the URL is still pasted as text and the transform chips it later.
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        event.preventDefault();
        selection.insertNodes([$createComposerLinkNode(url)]);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

// Thread mention chips resolve their provider icon from the sidebar summaries,
// which may not be loaded yet when a draft is restored (and can change after a
// provider handoff). Refresh the stored provider on existing chips whenever the
// summaries change so the icon never stays stale.
function ComposerThreadMentionProviderPlugin() {
  const [editor] = useLexicalComposerContext();
  const threadMentionSources = useStore(
    useMemo(() => createComposerThreadMentionSourcesSelector(), []),
  );
  const providerByThreadId = useMemo(
    () => new Map(threadMentionSources.map((source) => [source.id as string, source.provider])),
    [threadMentionSources],
  );

  useEffect(() => {
    const staleProvider = (node: ComposerMentionNode): boolean => {
      const threadId = node.getMentionThreadId();
      if (!threadId) return false;
      const provider = providerByThreadId.get(threadId);
      return provider !== undefined && provider !== node.getMentionProvider();
    };
    const needsUpdate = editor
      .getEditorState()
      .read(() => $nodesOfType(ComposerMentionNode).some(staleProvider));
    if (!needsUpdate) return;
    editor.update(
      () => {
        for (const node of $nodesOfType(ComposerMentionNode)) {
          if (!staleProvider(node)) continue;
          const provider = providerByThreadId.get(node.getMentionThreadId() ?? "");
          if (provider) node.setMentionProvider(provider);
        }
      },
      { tag: "history-merge" },
    );
  }, [editor, providerByThreadId]);

  return null;
}

// A sufficiently large text paste collapses into an attachment card instead of
// flooding the editor. Intercepting at the Lexical command level (rather than the
// React onPaste prop) is required: Lexical's own paste listener would otherwise
// insert the raw text before a bubbled React handler could preventDefault.
function ComposerBigPastePlugin(props: { onCollapsePastedText: (text: string) => void }) {
  const [editor] = useLexicalComposerContext();
  const onCollapseRef = useRef(props.onCollapsePastedText);

  useEffect(() => {
    onCollapseRef.current = props.onCollapsePastedText;
  }, [props.onCollapsePastedText]);

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const clipboardData = event instanceof ClipboardEvent ? event.clipboardData : null;
        if (!clipboardData) {
          return false;
        }
        // Image/file pastes are handled by the composer dropzone — never collapse them.
        if (clipboardData.files.length > 0 || hasExplicitClipboardImageSignal(clipboardData)) {
          return false;
        }
        const text = clipboardData.getData("text/plain");
        if (!shouldCollapsePastedText(text)) {
          return false;
        }
        event.preventDefault();
        onCollapseRef.current(text);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

function ComposerPromptEditorInner({
  value,
  cursor,
  terminalContexts,
  mentionReferences: mentionReferencesProp,
  disabled,
  placeholder,
  ariaLabel,
  className,
  singleLine,
  onRemoveTerminalContext,
  onCollapsePastedText,
  onChange,
  onCommandKeyDown,
  onPaste,
  editorRef,
}: ComposerPromptEditorInnerProps) {
  const mentionReferences = mentionReferencesProp ?? [];
  const [editor] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();
  const onChangeRef = useRef(onChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const terminalContextsSignature = terminalContextSignature(terminalContexts);
  const terminalContextsSignatureRef = useRef(terminalContextsSignature);
  const mentionsSignature = mentionReferencesSignature(mentionReferences);
  const mentionsSignatureRef = useRef(mentionsSignature);
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: expandCollapsedComposerCursor(value, initialCursor),
    selectionCollapsed: true,
    terminalContextIds: terminalContexts.map((context) => context.id),
  });
  const isDomComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const pendingControlledSyncRef = useRef(false);
  const composingChangeEmittedRef = useRef(false);
  const compositionEndFlushPendingRef = useRef(false);
  const recentEmittedValuesRef = useRef<string[]>([]);
  const latestControlledPropsRef = useRef({
    value,
    cursor,
    terminalContexts,
    terminalContextsSignature,
    mentionReferences,
    mentionsSignature,
  });
  latestControlledPropsRef.current = {
    value,
    cursor,
    terminalContexts,
    terminalContextsSignature,
    mentionReferences,
    mentionsSignature,
  };

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const applyControlledSync = useCallback(
    (props: {
      value: string;
      cursor: number;
      terminalContexts: ReadonlyArray<TerminalContextDraft>;
      terminalContextsSignature: string;
      mentionReferences: ReadonlyArray<ProviderMentionReference>;
      mentionsSignature: string;
    }) => {
      const normalizedCursor = clampCollapsedComposerCursor(props.value, props.cursor);
      const previousSnapshot = snapshotRef.current;
      const contextsChanged =
        terminalContextsSignatureRef.current !== props.terminalContextsSignature;
      const mentionsChanged = mentionsSignatureRef.current !== props.mentionsSignature;
      if (
        previousSnapshot.value === props.value &&
        previousSnapshot.cursor === normalizedCursor &&
        !contextsChanged &&
        !mentionsChanged
      ) {
        // React has caught up to the latest emitted value; discard earlier in-flight echo
        // entries so a subsequent controlled reset (e.g. clearing back to "" after `/fast`)
        // is never misclassified as a stale typing echo.
        recentEmittedValuesRef.current.length = 0;
        return;
      }

      // If React is still committing an earlier value the editor already moved past during a
      // fast typing/IME burst, do not clobber the user's newer in-flight text with root.clear().
      if (previousSnapshot.value !== props.value && !contextsChanged && !mentionsChanged) {
        const staleIndex = recentEmittedValuesRef.current.lastIndexOf(props.value);
        if (staleIndex !== -1) {
          recentEmittedValuesRef.current.splice(0, staleIndex + 1);
          return;
        }
      }

      // Never tear down the DOM or move selection while an IME composition (e.g. Vietnamese
      // Telex/VNI on WebKitGTK) owns the active TextNode; flush cleanly once composition ends.
      if (isDomComposingRef.current) {
        pendingControlledSyncRef.current = true;
        return;
      }

      const rootElement = editor.getRootElement();
      const isFocused = Boolean(
        rootElement && document.hasFocus() && document.activeElement === rootElement,
      );

      // Pasting a bare URL creates a ComposerLinkNode (collapsed length 1) while string-based
      // cursor clamping treats an unterminated trailing URL as raw text (length url.length).
      // Avoid a spurious editor.update when the live selection is already at the clamped target.
      if (previousSnapshot.value === props.value && !contextsChanged && !mentionsChanged) {
        let alreadyAtTarget = false;
        editor.getEditorState().read(() => {
          const liveLength = $getComposerRootLength();
          const liveOffset = $readSelectionOffsetFromEditorState(previousSnapshot.cursor);
          const boundedTarget = Math.max(0, Math.min(normalizedCursor, liveLength));
          alreadyAtTarget = liveOffset === boundedTarget;
        });
        if (alreadyAtTarget) {
          snapshotRef.current = {
            ...previousSnapshot,
            cursor: normalizedCursor,
            expandedCursor: expandCollapsedComposerCursor(props.value, normalizedCursor),
          };
          return;
        }
      }

      snapshotRef.current = {
        value: props.value,
        cursor: normalizedCursor,
        expandedCursor: expandCollapsedComposerCursor(props.value, normalizedCursor),
        selectionCollapsed: true,
        terminalContextIds: props.terminalContexts.map((context) => context.id),
      };
      recentEmittedValuesRef.current.length = 0;
      terminalContextsSignatureRef.current = props.terminalContextsSignature;
      mentionsSignatureRef.current = props.mentionsSignature;

      if (
        previousSnapshot.value === props.value &&
        !contextsChanged &&
        !mentionsChanged &&
        !isFocused
      ) {
        return;
      }

      const shouldRewriteEditorState =
        previousSnapshot.value !== props.value || contextsChanged || mentionsChanged;
      editor.update(
        () => {
          $addUpdateTag(CONTROLLED_UPDATE_TAG);
          if (shouldRewriteEditorState) {
            $setComposerEditorPrompt(props.value, props.terminalContexts, props.mentionReferences);
          }
          if (shouldRewriteEditorState || isFocused) {
            $setSelectionAtComposerOffset(normalizedCursor);
          }
        },
        // Keep Lexical's draft cursor current without moving the user's DOM selection.
        isFocused ? undefined : { tag: SKIP_DOM_SELECTION_TAG },
      );
    },
    [editor],
  );

  const readSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    selectionCollapsed: boolean;
    terminalContextIds: string[];
  } => {
    let snapshot = snapshotRef.current;
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      const selectionCollapsed = !$isRangeSelection(selection) || selection.isCollapsed();
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      snapshot = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        selectionCollapsed,
        terminalContextIds,
      };
    });
    snapshotRef.current = snapshot;
    return snapshot;
  }, [editor]);

  // Track real browser IME composition on the editable root so WebKitGTK's Safari-mode
  // composition lifecycle never leaves us stuck or lets a controlled rewrite destroy an
  // actively composed text node.
  useEffect(() => {
    const handleCompositionStart = () => {
      isDomComposingRef.current = true;
      lastCompositionEndAtRef.current = 0;
      compositionEndFlushPendingRef.current = false;
    };
    const flushAfterComposition = (event: Event) => {
      if (event.type === "compositionend") {
        lastCompositionEndAtRef.current = performance.now();
      } else {
        lastCompositionEndAtRef.current = 0;
      }
      if (!isDomComposingRef.current) return;
      isDomComposingRef.current = false;
      const hadPendingControlledSync = pendingControlledSyncRef.current;
      const hadComposingChange = composingChangeEmittedRef.current;
      pendingControlledSyncRef.current = false;
      composingChangeEmittedRef.current = false;
      if (!hadPendingControlledSync && !hadComposingChange) return;
      if (!hadPendingControlledSync && hadComposingChange) {
        compositionEndFlushPendingRef.current = true;
      }
      queueMicrotask(() => {
        if (isDomComposingRef.current) return;
        if (hadPendingControlledSync) {
          applyControlledSync(latestControlledPropsRef.current);
          return;
        }
        if (!compositionEndFlushPendingRef.current) return;
        compositionEndFlushPendingRef.current = false;
        const snapshot = readSnapshot();
        const cursorAdjacentToMention =
          isCollapsedCursorAdjacentToInlineToken(snapshot.value, snapshot.cursor, "left") ||
          isCollapsedCursorAdjacentToInlineToken(snapshot.value, snapshot.cursor, "right");
        onChangeRef.current(
          snapshot.value,
          snapshot.cursor,
          snapshot.expandedCursor,
          cursorAdjacentToMention,
          snapshot.terminalContextIds,
          false,
        );
      });
    };
    return editor.registerRootListener((rootElement, prevRootElement) => {
      if (prevRootElement) {
        prevRootElement.removeEventListener("compositionstart", handleCompositionStart);
        prevRootElement.removeEventListener("compositionend", flushAfterComposition);
        prevRootElement.removeEventListener("blur", flushAfterComposition);
      }
      isDomComposingRef.current = false;
      composingChangeEmittedRef.current = false;
      compositionEndFlushPendingRef.current = false;
      if (rootElement) {
        rootElement.addEventListener("compositionstart", handleCompositionStart);
        rootElement.addEventListener("compositionend", flushAfterComposition);
        rootElement.addEventListener("blur", flushAfterComposition);
      }
    });
  }, [applyControlledSync, editor, readSnapshot]);

  // Disabling the editor (e.g. while a turn dispatch is connecting) turns off
  // contenteditable, which drops browser focus to <body>. Remember whether the
  // composer owned focus at disable time and hand it back once re-enabled, so
  // sending a message never silently kicks the user out of the input.
  const restoreFocusOnEnableRef = useRef(false);
  useEffect(() => {
    if (disabled) {
      const rootElement = editor.getRootElement();
      restoreFocusOnEnableRef.current = Boolean(
        rootElement && document.hasFocus() && document.activeElement === rootElement,
      );
      editor.setEditable(false);
      return;
    }
    editor.setEditable(true);
  }, [disabled, editor]);

  useEffect(() => {
    // ContentEditable commits its editable state separately from setEditable().
    // Wait for that commit, and preserve any control/window chosen in the meantime.
    if (disabled || !isEditable || !restoreFocusOnEnableRef.current) return;
    restoreFocusOnEnableRef.current = false;
    const rootElement = editor.getRootElement();
    if (
      document.hasFocus() &&
      (document.activeElement === document.body || document.activeElement === rootElement)
    ) {
      rootElement?.focus();
    }
  }, [disabled, editor, isEditable]);

  useLayoutEffect(() => {
    applyControlledSync({
      value,
      cursor,
      terminalContexts,
      terminalContextsSignature,
      mentionReferences,
      mentionsSignature,
    });
  }, [
    applyControlledSync,
    cursor,
    mentionReferences,
    mentionsSignature,
    terminalContexts,
    terminalContextsSignature,
    value,
  ]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      rootElement.focus();
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      snapshotRef.current = {
        value: snapshotRef.current.value,
        cursor: boundedCursor,
        expandedCursor: expandCollapsedComposerCursor(snapshotRef.current.value, boundedCursor),
        selectionCollapsed: true,
        terminalContextIds: snapshotRef.current.terminalContextIds,
      };
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.expandedCursor,
        false,
        snapshotRef.current.terminalContextIds,
        isDomComposingRef.current || editor.isComposing(),
      );
    },
    [editor],
  );

  const blurEditor = useCallback(() => {
    editor.getRootElement()?.blur();
  }, [editor]);

  // Keep global shortcuts decoupled from Lexical's root element details.
  const isEditorFocused = useCallback(() => {
    const rootElement = editor.getRootElement();
    return Boolean(
      rootElement &&
      typeof document !== "undefined" &&
      document.hasFocus() &&
      document.activeElement === rootElement,
    );
  }, [editor]);

  useImperativeHandle(
    editorRef,
    () => ({
      blur: blurEditor,
      focus: () => {
        focusAt(snapshotRef.current.cursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(
          collapseExpandedComposerCursor(
            snapshotRef.current.value,
            snapshotRef.current.value.length,
          ),
        );
      },
      isFocused: isEditorFocused,
      readSnapshot,
    }),
    [blurEditor, focusAt, isEditorFocused, readSnapshot],
  );

  const handleEditorChange = useCallback(
    (editorState: EditorState, _editor: unknown, tags: Set<string>) => {
      if (tags.has(CONTROLLED_UPDATE_TAG)) {
        return;
      }
      editorState.read(() => {
        const selection = $getSelection();
        const selectionCollapsed = !$isRangeSelection(selection) || selection.isCollapsed();
        const nextValue = $getRoot().getTextContent();
        const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
        const nextCursor = clampCollapsedComposerCursor(
          nextValue,
          $readSelectionOffsetFromEditorState(fallbackCursor),
        );
        const fallbackExpandedCursor = clampExpandedCursor(
          nextValue,
          snapshotRef.current.expandedCursor,
        );
        const nextExpandedCursor = clampExpandedCursor(
          nextValue,
          $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
        );
        const terminalContextIds = collectTerminalContextIds($getRoot());
        const previousSnapshot = snapshotRef.current;
        if (
          previousSnapshot.value === nextValue &&
          previousSnapshot.cursor === nextCursor &&
          previousSnapshot.expandedCursor === nextExpandedCursor &&
          previousSnapshot.terminalContextIds.length === terminalContextIds.length &&
          previousSnapshot.terminalContextIds.every((id, index) => id === terminalContextIds[index])
        ) {
          return;
        }
        const emitted = recentEmittedValuesRef.current;
        if (previousSnapshot.value !== nextValue) {
          emitted.push(previousSnapshot.value);
          if (emitted.length > RECENT_EMITTED_VALUE_LIMIT) {
            emitted.splice(0, emitted.length - RECENT_EMITTED_VALUE_LIMIT);
          }
        }
        snapshotRef.current = {
          value: nextValue,
          cursor: nextCursor,
          expandedCursor: nextExpandedCursor,
          selectionCollapsed,
          terminalContextIds,
        };
        const cursorAdjacentToMention =
          isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
          isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
        const isComposing = isDomComposingRef.current || editor.isComposing();
        if (isComposing) {
          composingChangeEmittedRef.current = true;
        } else {
          composingChangeEmittedRef.current = false;
          compositionEndFlushPendingRef.current = false;
        }
        onChangeRef.current(
          nextValue,
          nextCursor,
          nextExpandedCursor,
          cursorAdjacentToMention,
          terminalContextIds,
          isComposing,
        );
      });
    },
    [editor],
  );

  // Run external paste handling (image/file attachments and desktop clipboard image probing)
  // in capture phase BEFORE Lexical's native target-phase `paste` listener fires. Otherwise
  // `@lexical/plain-text` unconditionally calls `event.preventDefault()` on every paste when a
  // selection exists, causing `useComposerDropzone.onComposerPaste` to bail on
  // `event.defaultPrevented` and dropping pasted images across all platforms.
  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => event instanceof ClipboardEvent && event.defaultPrevented,
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor]);

  // WebKitGTK on Linux/Wayland can swallow Ctrl+V without dispatching a DOM `paste` event when
  // the OS clipboard contains only an image (no text/plain target). If a Ctrl+V keydown on the
  // editable root produces no paste event within a short grace window, dispatch a synthetic paste
  // event so the dropzone's native image clipboard reader runs.
  const lastPasteEventAtRef = useRef(0);
  const handleContentEditablePaste: ClipboardEventHandler<HTMLDivElement> | undefined = onPaste
    ? (event) => {
        lastPasteEventAtRef.current = performance.now();
        onPaste(event);
      }
    : undefined;

  useEffect(() => {
    if (!onPaste || disabled) return;
    if (
      typeof window === "undefined" ||
      typeof window.desktopBridge?.clipboard?.readImagePngDataUrl !== "function"
    ) {
      return;
    }
    let fallbackTimer: number | null = null;
    const clearFallback = () => {
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        !event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "v"
      ) {
        return;
      }
      const keydownAt = performance.now();
      clearFallback();
      // Give Wayland `wl_data_offer` negotiation enough headroom on text/link pastes so
      // we only fire the synthetic image-clipboard fallback when WebKitGTK truly suppressed `paste`.
      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = null;
        if (lastPasteEventAtRef.current >= keydownAt) return;
        const rootElement = editor.getRootElement();
        if (!rootElement || document.activeElement !== rootElement) return;
        if (typeof ClipboardEvent === "function") {
          rootElement.dispatchEvent(
            new ClipboardEvent("paste", { bubbles: true, cancelable: true }),
          );
        }
      }, 180);
    };
    const unregister = editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("keydown", handleKeyDown);
      clearFallback();
      rootElement?.addEventListener("keydown", handleKeyDown);
    });
    return () => {
      clearFallback();
      unregister();
    };
  }, [disabled, editor, onPaste]);

  return (
    <ComposerRemoveTerminalContextContext.Provider value={onRemoveTerminalContext}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "block max-h-[200px] w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-foreground focus:outline-none",
                COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
                COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
                COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
                singleLine && "min-h-[1lh]",
                className,
              )}
              data-testid="composer-editor"
              aria-placeholder={placeholder}
              aria-label={ariaLabel}
              placeholder={<span />}
              onPasteCapture={handleContentEditablePaste}
            />
          }
          placeholder={
            terminalContexts.length > 0 ? null : (
              <div
                className={cn(
                  "pointer-events-none absolute inset-0",
                  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
                  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
                  singleLine && "truncate",
                )}
              >
                {placeholder}
              </div>
            )
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleEditorChange} />
        <ComposerCommandKeyPlugin
          isDomComposingRef={isDomComposingRef}
          lastCompositionEndAtRef={lastCompositionEndAtRef}
          {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        />
        <ComposerInlineTokenArrowPlugin />
        <ComposerDecoratorAdjacentInputPlugin isDomComposingRef={isDomComposingRef} />
        <ComposerInlineTokenSelectionNormalizePlugin isDomComposingRef={isDomComposingRef} />
        <ComposerInlineTokenBackspacePlugin />
        <ComposerSlashCommandTransformPlugin isDomComposingRef={isDomComposingRef} />
        <ComposerLinkTransformPlugin isDomComposingRef={isDomComposingRef} />
        <ComposerLinkPastePlugin />
        <ComposerThreadMentionProviderPlugin />
        {onCollapsePastedText ? (
          <ComposerBigPastePlugin onCollapsePastedText={onCollapsePastedText} />
        ) : null}
        <HistoryPlugin />
      </div>
    </ComposerRemoveTerminalContextContext.Provider>
  );
}

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps
>(function ComposerPromptEditor(
  {
    value,
    cursor,
    terminalContexts,
    mentionReferences,
    disabled,
    placeholder,
    ariaLabel,
    className,
    singleLine,
    onRemoveTerminalContext,
    onCollapsePastedText,
    onChange,
    onCommandKeyDown,
    onPaste,
  },
  ref,
) {
  const initialValueRef = useRef(value);
  const initialTerminalContextsRef = useRef(terminalContexts);
  // Normalize once at the wrapper boundary so the inner editor can treat mention refs as concrete.
  const normalizedMentionReferences = mentionReferences ?? [];
  const initialMentionReferencesRef = useRef(normalizedMentionReferences);
  const initialConfig: InitialConfigType = {
    namespace: "saint-composer-editor",
    editable: true,
    nodes: [...COMPOSER_NODE_CLASSES],
    editorState: () => {
      $setComposerEditorPrompt(
        initialValueRef.current,
        initialTerminalContextsRef.current,
        initialMentionReferencesRef.current,
      );
    },
    onError: (error) => {
      throw error;
    },
  };

  return (
    <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
      <ComposerPromptEditorInner
        value={value}
        cursor={cursor}
        terminalContexts={terminalContexts}
        mentionReferences={normalizedMentionReferences}
        disabled={disabled}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        onRemoveTerminalContext={onRemoveTerminalContext}
        onChange={onChange}
        onPaste={onPaste}
        editorRef={ref}
        {...(onCollapsePastedText ? { onCollapsePastedText } : {})}
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        {...(className ? { className } : {})}
        {...(singleLine ? { singleLine } : {})}
      />
    </LexicalComposer>
  );
});
