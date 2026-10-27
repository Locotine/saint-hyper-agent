// FILE: toolCallLabel.ts
// Purpose: Normalizes generic tool-call titles and humanizes command executions for timeline rows.
// Layer: UI utility
// Exports: deriveReadableToolTitle, deriveReadableCommandDisplay, deriveFriendlyCommandTarget, command icon classifiers, deriveInlineCommandCall, deriveLiteralCommand, deriveCommandReadTargets, normalizeCompactToolLabel, isGenericToolTitle, extractWebFetchUrl
// Depends on: @saint/contracts tool lifecycle item types

import type { ToolLifecycleItemType } from "@saint/contracts";
import { BROWSER_TOOL_TITLES } from "@saint/shared/browserAutomationPresentation";
import {
  COMPUTER_TOOL_TITLES,
  computerToolName,
  type ComputerToolName,
} from "./computerToolPresentation";
import { basenameOfPath } from "../file-icons";
import { extractToolArgumentField } from "./toolArgumentSummary";

export function normalizeCompactToolLabel(value: string): string {
  return value
    .trimEnd()
    .replace(/\s(?:complete|completed|done|finished|success|succeeded|started|running)$/i, "")
    .trim();
}

// Canonical form for comparing tool display strings (heading vs preview vs
// label): ignores case, whitespace runs, and trailing status words so dedup
// decisions behave identically in the work-log builder and the timeline rows.
export function normalizeToolTextForComparison(value: string | undefined): string {
  return normalizeCompactToolLabel(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Web-fetch tool calls (e.g. Claude's `WebFetch`) arrive as generic dynamic tool
// calls whose detail is the raw `ToolName: {json}` argument summary. Recognizing
// them lets the timeline surface the target site (favicon + URL) instead of the
// raw JSON arguments.
const WEB_FETCH_TOOL_NAMES = new Set(["webfetch", "fetch", "urlfetch", "fetchurl", "httpfetch"]);

function isWebFetchToolName(toolName: string | null | undefined): boolean {
  if (!toolName) {
    return false;
  }
  const normalized = toolName.toLowerCase().replace(/[^a-z]/g, "");
  if (WEB_FETCH_TOOL_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("fetch") &&
    (normalized.includes("web") || normalized.includes("url") || normalized.includes("http"))
  );
}

// Pulls the first http(s) URL out of a web-fetch tool call's argument summary.
// Prefers the JSON `url`/`uri` field (the actual shape) and falls back to a bare
// URL token so a slightly different summary still resolves. Returns null for
// non-fetch tools or when no usable URL is present, so callers fall back to the
// generic tool-call rendering.
export function extractWebFetchUrl(input: {
  readonly toolName?: string | null | undefined;
  readonly detail?: string | null | undefined;
}): string | null {
  if (!isWebFetchToolName(input.toolName)) {
    return null;
  }
  const detail = input.detail;
  if (!detail) {
    return null;
  }
  const candidate =
    extractToolArgumentField(detail, ["url", "uri"]) ??
    /https?:\/\/[^\s"'<>)\]}]+/i.exec(detail)?.[0]?.replace(/[.,;:!?]+$/, "");
  if (candidate && /^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  return null;
}

// Turns internal MCP identifiers into readable inline labels for timeline rows.
function humanizeMcpToolIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("mcp__")) {
    return null;
  }

  const [, server, tool, ...rest] = trimmed.split("__");
  const normalizedServer = humanizeMcpToken(server);
  const normalizedTool = [tool, ...rest]
    .map((part) => humanizeMcpToken(part))
    .filter((part) => part.length > 0)
    .join(" ");

  if (!normalizedServer || !normalizedTool) {
    return null;
  }
  return `${normalizedServer}: ${normalizedTool}`;
}

function humanizeMcpServerTool(server: string, tool: string): string | null {
  const normalizedServer = humanizeMcpToken(server);
  const normalizedTool = humanizeMcpToken(tool);
  if (!normalizedServer || !normalizedTool) {
    return null;
  }
  return `${normalizedServer}: ${normalizedTool}`;
}

export interface ReadableToolTitleInput {
  readonly title?: string | null;
  readonly fallbackLabel: string;
  readonly itemType?: ToolLifecycleItemType | undefined;
  readonly requestKind?:
    | "command"
    | "file-read"
    | "file-change"
    | "permissions"
    | "tool"
    | undefined;
  readonly command?: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly isRunning?: boolean;
}

interface SaintMcpToolPresentation {
  readonly running: string;
  readonly completed: string;
  readonly failed: string;
}

// Historical messages still contain retired tools; presentation does not expose them to agents.
const BROWSER_HISTORY_TITLES = {
  ...BROWSER_TOOL_TITLES,
  browser_snapshot: "Snapshot browser page",
  browser_webmcp_tools: "Discover page WebMCP tools",
  browser_webmcp_call: "Call page WebMCP tool",
  browser_click: "Click browser target",
  browser_hover: "Hover browser target",
  browser_drag: "Drag between browser targets",
  browser_type: "Type into browser target",
  browser_select: "Select browser options",
  browser_press: "Press browser keys",
  browser_scroll: "Scroll browser page",
  browser_wait: "Wait for browser condition",
  browser_evaluate: "Evaluate browser expression",
} as const;
type BrowserHistoryToolName = keyof typeof BROWSER_HISTORY_TITLES;
type SaintBrowserToolName = `saint_${BrowserHistoryToolName}`;
const BROWSER_HISTORY_TOOL_NAMES = Object.keys(BROWSER_HISTORY_TITLES) as BrowserHistoryToolName[];
const BROWSER_TOOL_NAME_SET = new Set<string>(BROWSER_HISTORY_TOOL_NAMES);

const SAINT_BROWSER_TOOL_PRESENTATIONS = Object.fromEntries(
  BROWSER_HISTORY_TOOL_NAMES.map((toolName) => {
    const title = BROWSER_HISTORY_TITLES[toolName];
    return [`saint_${toolName}`, { running: title, completed: title, failed: title }];
  }),
) as Record<SaintBrowserToolName, SaintMcpToolPresentation>;

/**
 * The desktop tools, spoken. Every browser tool had a curated presentation and
 * every computer tool had none, so the most consequential rows in the
 * transcript — an agent moving a pointer on the user's own machine — fell
 * through to the invented "Saint is handling computer click" fallback.
 *
 * The wording deliberately keeps the machine in the sentence ("this computer's
 * desktop") rather than saying "the desktop", because on the backends that
 * matter it is the user's own.
 */
const SAINT_COMPUTER_TOOL_PRESENTATIONS = {
  saint_computer_screenshot: presentComputerTool("taking a screenshot", "took a screenshot"),
  saint_computer_get_state: presentComputerTool("reading the screen", "read the screen"),
  saint_computer_get_screen_size: presentComputerTool(
    "measuring the screen",
    "measured the screen",
  ),
  saint_computer_list_windows: presentComputerTool("listing windows", "listed the windows"),
  saint_computer_list_apps: presentComputerTool("listing apps", "listed the apps"),
  saint_computer_verify_state: presentComputerTool(
    "checking desktop state",
    "checked desktop state",
  ),
  saint_computer_zoom: presentComputerTool("zooming into a window", "zoomed into a window"),
  saint_computer_get_accessibility_tree: presentComputerTool(
    "listing apps and windows",
    "listed apps and windows",
  ),
  saint_computer_get_cursor_position: presentComputerTool(
    "reading the cursor position",
    "read the cursor position",
  ),
  saint_computer_help: presentComputerTool(
    "reading the Computer playbook",
    "read the Computer playbook",
  ),
  saint_computer_click: presentComputerTool("clicking the desktop", "clicked the desktop"),
  saint_computer_move_cursor: presentComputerTool("moving the cursor", "moved the cursor"),
  saint_computer_drag: presentComputerTool("dragging on the desktop", "dragged on the desktop"),
  saint_computer_scroll: presentComputerTool("scrolling the desktop", "scrolled the desktop"),
  saint_computer_type_text: presentComputerTool("typing on the desktop", "typed on the desktop"),
  saint_computer_press_key: presentComputerTool("pressing a key", "pressed a key"),
  saint_computer_set_value: presentComputerTool("setting a field", "set a field"),
  saint_computer_select_text: presentComputerTool("selecting text", "selected text"),
  saint_computer_perform_action: presentComputerTool("activating a control", "activated a control"),
  saint_computer_launch_app: presentComputerTool("opening an app", "opened an app"),
  saint_computer_activate_window: presentComputerTool("activating a window", "activated a window"),
  saint_computer_set_window_frame: presentComputerTool(
    "moving or resizing a window",
    "moved or resized a window",
  ),
  saint_computer_invoke_menu: presentComputerTool("invoking a menu item", "invoked a menu item"),
  saint_computer_kill_app: presentComputerTool("force-quitting an app", "force-quit an app"),
  saint_computer_set_window_minimized: presentComputerTool(
    "changing a window's visibility",
    "changed a window's visibility",
  ),
  saint_computer_set_app_visibility: presentComputerTool(
    "changing an app's visibility",
    "changed an app's visibility",
  ),
  saint_computer_wait: presentComputerTool("waiting for the desktop", "waited for the desktop"),
  saint_computer_read_clipboard: presentComputerTool("reading the clipboard", "read the clipboard"),
  saint_computer_write_clipboard: presentComputerTool(
    "writing to the clipboard",
    "wrote to the clipboard",
  ),
  saint_computer_paste: presentComputerTool("pasting text", "pasted text"),
  saint_computer_run: presentComputerTool("running a desktop sequence", "ran a desktop sequence"),
  saint_computer_inspect: presentComputerTool("inspecting the computer", "inspected the computer"),
  saint_computer_spaces: presentComputerTool(
    "inspecting desktop Spaces",
    "inspected desktop Spaces",
  ),
  saint_computer_browser_state: presentComputerTool(
    "reading the browser page",
    "read the browser page",
  ),
  saint_computer_browser_prepare: presentComputerTool("preparing a browser", "prepared a browser"),
  saint_computer_browser_navigate: presentComputerTool(
    "opening a browser page",
    "opened a browser page",
  ),
  saint_computer_browser_click: presentComputerTool(
    "clicking in the browser",
    "clicked in the browser",
  ),
  saint_computer_browser_type: presentComputerTool(
    "typing in a browser field",
    "typed in a browser field",
  ),
  saint_computer_browser_dialog: presentComputerTool(
    "handling a browser dialog",
    "handled a browser dialog",
  ),
  saint_computer_browser_upload: presentComputerTool(
    "attaching files in the browser",
    "attached files in the browser",
  ),
  saint_computer_browser_download: presentComputerTool("downloading a file", "downloaded a file"),
  saint_computer_browser_pointer: presentComputerTool(
    "using the pointer in the browser",
    "used the pointer in the browser",
  ),
  saint_computer_browser_press: presentComputerTool(
    "pressing Enter in the browser",
    "pressed Enter in the browser",
  ),
} as const satisfies Record<`saint_${ComputerToolName}`, SaintMcpToolPresentation>;

function presentComputerTool(present: string, past: string): SaintMcpToolPresentation {
  return {
    running: `Saint is ${present}`,
    completed: `Saint ${past}`,
    failed: `Saint couldn't finish ${present}`,
  };
}

const SAINT_MCP_TOOL_PRESENTATIONS = {
  saint_context: {
    running: "Saint is checking its context",
    completed: "Saint checked its context",
    failed: "Saint couldn't check its context",
  },
  saint_capabilities: {
    running: "Saint is checking available agents",
    completed: "Saint checked available agents",
    failed: "Saint couldn't check available agents",
  },
  saint_overview: {
    running: "Saint is gathering an overview",
    completed: "Saint gathered an overview",
    failed: "Saint couldn't gather an overview",
  },
  saint_list_allowed_projects: {
    running: "Saint is listing allowed projects",
    completed: "Saint listed allowed projects",
    failed: "Saint couldn't list allowed projects",
  },
  saint_create_task: {
    running: "Saint is creating a task",
    completed: "Saint created a task",
    failed: "Saint couldn't create a task",
  },
  saint_wait_for_task: {
    running: "Saint is waiting for a task",
    completed: "Saint finished waiting for a task",
    failed: "Saint couldn't wait for a task",
  },
  saint_read_task: {
    running: "Saint is reading a task",
    completed: "Saint read a task",
    failed: "Saint couldn't read a task",
  },
  saint_list_projects: {
    running: "Saint is listing projects",
    completed: "Saint listed projects",
    failed: "Saint couldn't list projects",
  },
  saint_list_threads: {
    running: "Saint is listing threads",
    completed: "Saint listed threads",
    failed: "Saint couldn't list threads",
  },
  saint_read_thread: {
    running: "Saint is reading a thread",
    completed: "Saint read a thread",
    failed: "Saint couldn't read a thread",
  },
  saint_read_thread_activity: {
    running: "Saint is reading thread activity",
    completed: "Saint read thread activity",
    failed: "Saint couldn't read thread activity",
  },
  saint_read_thread_events: {
    running: "Saint is reading thread events",
    completed: "Saint read thread events",
    failed: "Saint couldn't read thread events",
  },
  saint_read_thread_runtime_events: {
    running: "Saint is reading thread runtime events",
    completed: "Saint read thread runtime events",
    failed: "Saint couldn't read thread runtime events",
  },
  saint_diagnose_thread: {
    running: "Saint is diagnosing a thread",
    completed: "Saint diagnosed a thread",
    failed: "Saint couldn't diagnose a thread",
  },
  saint_create_thread: {
    running: "Saint is creating a thread",
    completed: "Saint created a thread",
    failed: "Saint couldn't create a thread",
  },
  saint_create_threads: {
    running: "Saint is creating threads",
    completed: "Saint created threads",
    failed: "Saint couldn't create threads",
  },
  saint_wait_for_threads: {
    running: "Saint is waiting for threads",
    completed: "Saint finished waiting for threads",
    failed: "Saint couldn't wait for threads",
  },
  saint_send_message: {
    running: "Saint is sending a message",
    completed: "Saint sent a message",
    failed: "Saint couldn't send a message",
  },
  saint_read_kanban_board: {
    running: "Saint is reading the board",
    completed: "Saint read the board",
    failed: "Saint couldn't read the board",
  },
  saint_read_kanban_card: {
    running: "Saint is reading a board card",
    completed: "Saint read a board card",
    failed: "Saint couldn't read a board card",
  },
  saint_create_kanban_task: {
    running: "Saint is creating a board task",
    completed: "Saint created a board task",
    failed: "Saint couldn't create a board task",
  },
  saint_move_kanban_card: {
    running: "Saint is moving a board card",
    completed: "Saint moved a board card",
    failed: "Saint couldn't move a board card",
  },
  saint_show_visual: {
    running: "Saint is showing a visual",
    completed: "Saint showed a visual",
    failed: "Saint couldn't show a visual",
  },
  saint_create_todo: {
    running: "Saint is adding a to-do",
    completed: "Saint added a to-do",
    failed: "Saint couldn't add a to-do",
  },
  saint_list_todos: {
    running: "Saint is reading your to-dos",
    completed: "Saint read your to-dos",
    failed: "Saint couldn't read your to-dos",
  },
  saint_update_todo: {
    running: "Saint is updating a to-do",
    completed: "Saint updated a to-do",
    failed: "Saint couldn't update a to-do",
  },
  saint_interrupt_thread: {
    running: "Saint is interrupting a thread",
    completed: "Saint interrupted a thread",
    failed: "Saint couldn't interrupt a thread",
  },
  saint_set_thread_title: {
    running: "Saint is renaming a thread",
    completed: "Saint renamed a thread",
    failed: "Saint couldn't rename a thread",
  },
  saint_set_thread_archived: {
    running: "Saint is updating a thread",
    completed: "Saint updated a thread",
    failed: "Saint couldn't update a thread",
  },
  saint_create_automation: {
    running: "Saint is creating an automation",
    completed: "Saint created an automation",
    failed: "Saint couldn't create an automation",
  },
  saint_list_automations: {
    running: "Saint is listing automations",
    completed: "Saint listed automations",
    failed: "Saint couldn't list automations",
  },
  saint_view_automation: {
    running: "Saint is viewing an automation",
    completed: "Saint viewed an automation",
    failed: "Saint couldn't view an automation",
  },
  saint_update_automation: {
    running: "Saint is updating an automation",
    completed: "Saint updated an automation",
    failed: "Saint couldn't update an automation",
  },
  saint_update_automation_memory: {
    running: "Saint is updating automation memory",
    completed: "Saint updated automation memory",
    failed: "Saint couldn't update automation memory",
  },
  saint_report_automation_result: {
    running: "Saint is reporting an automation result",
    completed: "Saint reported an automation result",
    failed: "Saint couldn't report an automation result",
  },
  saint_cancel_automation: {
    running: "Saint is stopping an automation",
    completed: "Saint stopped an automation",
    failed: "Saint couldn't stop an automation",
  },
  ...SAINT_BROWSER_TOOL_PRESENTATIONS,
  ...SAINT_COMPUTER_TOOL_PRESENTATIONS,
} as const satisfies Record<string, SaintMcpToolPresentation>;

function normalizeSaintMcpIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const SAINT_BROWSER_TOOL_NAME_BY_PRESENTATION = new Map<string, SaintBrowserToolName>(
  BROWSER_HISTORY_TOOL_NAMES.map((toolName) => [
    normalizeSaintMcpIdentifier(BROWSER_HISTORY_TITLES[toolName]),
    `saint_${toolName}`,
  ]),
);

const SAINT_MCP_TOOL_PRESENTATION_ENTRIES = Object.entries(SAINT_MCP_TOOL_PRESENTATIONS).map(
  ([toolName, presentation]) => ({
    toolName,
    presentation,
    normalizedRunning: normalizeSaintMcpIdentifier(presentation.running),
    normalizedCompleted: normalizeSaintMcpIdentifier(presentation.completed),
    normalizedFailed: normalizeSaintMcpIdentifier(presentation.failed),
  }),
);

function extractSaintMcpToolName(normalizedCandidate: string): string | null {
  if (BROWSER_TOOL_NAME_SET.has(normalizedCandidate)) {
    return `saint_${normalizedCandidate}`;
  }
  if (normalizedCandidate.startsWith("mcp_saint_saint_")) {
    return normalizedCandidate.slice("mcp_saint_".length);
  }
  if (normalizedCandidate.startsWith("mcp_saint_")) {
    return `saint_${normalizedCandidate.slice("mcp_saint_".length)}`;
  }
  if (normalizedCandidate.startsWith("saint_saint_")) {
    return normalizedCandidate.slice("saint_".length);
  }
  if (normalizedCandidate.startsWith("saint_")) {
    return normalizedCandidate;
  }
  return null;
}

function resolveSaintBrowserToolName(
  candidates: ReadonlyArray<string | null | undefined>,
): SaintBrowserToolName | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalizedCandidate = normalizeSaintMcpIdentifier(candidate);
    const extractedToolName = extractSaintMcpToolName(normalizedCandidate);
    const candidateToolName =
      extractedToolName ??
      SAINT_BROWSER_TOOL_NAME_BY_PRESENTATION.get(normalizedCandidate) ??
      normalizedCandidate;
    if (candidateToolName in SAINT_BROWSER_TOOL_PRESENTATIONS) {
      return candidateToolName as SaintBrowserToolName;
    }
  }
  return null;
}

function fallbackSaintMcpToolPresentation(toolName: string): SaintMcpToolPresentation {
  const action =
    toolName
      .replace(/^saint_/, "")
      .replace(/_+/g, " ")
      .trim() || "an action";
  return {
    running: `Saint is handling ${action}`,
    completed: `Saint handled ${action}`,
    failed: `Saint couldn't handle ${action}`,
  };
}

function resolveSaintMcpToolPresentation(
  candidates: ReadonlyArray<string | null | undefined>,
): SaintMcpToolPresentation | null {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalizedCandidate = normalizeSaintMcpIdentifier(candidate);
    for (const entry of SAINT_MCP_TOOL_PRESENTATION_ENTRIES) {
      if (
        normalizedCandidate === entry.normalizedRunning ||
        normalizedCandidate === entry.normalizedCompleted ||
        normalizedCandidate === entry.normalizedFailed
      ) {
        return entry.presentation;
      }
    }
    const toolName = extractSaintMcpToolName(normalizedCandidate);
    const knownPresentation = toolName
      ? (SAINT_MCP_TOOL_PRESENTATIONS[toolName as keyof typeof SAINT_MCP_TOOL_PRESENTATIONS] as
          | SaintMcpToolPresentation
          | undefined)
      : undefined;
    if (knownPresentation) {
      return knownPresentation;
    }
    // Free-text summaries (e.g. reconciler activity lines) can begin with the
    // word "Saint" and normalize into a fake tool identifier; only
    // identifier-shaped candidates may take an invented fallback presentation.
    if (/\s/.test(candidate.trim())) {
      continue;
    }
    if (normalizedCandidate.startsWith("saint_is_handling_")) {
      return fallbackSaintMcpToolPresentation(
        `saint_${normalizedCandidate.slice("saint_is_handling_".length)}`,
      );
    }
    if (normalizedCandidate.startsWith("saint_handled_")) {
      return fallbackSaintMcpToolPresentation(
        `saint_${normalizedCandidate.slice("saint_handled_".length)}`,
      );
    }
    if (normalizedCandidate.startsWith("saint_couldn_t_handle_")) {
      return fallbackSaintMcpToolPresentation(
        `saint_${normalizedCandidate.slice("saint_couldn_t_handle_".length)}`,
      );
    }
    if (!toolName) {
      continue;
    }
    return fallbackSaintMcpToolPresentation(toolName);
  }
  return null;
}

export type SaintMcpToolStatus = "running" | "completed" | "failed" | "cancelled";

export interface SaintMcpToolTitleInput {
  readonly toolName?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly fallbackLabel?: string | null | undefined;
  readonly status?: SaintMcpToolStatus | undefined;
}

export function isSaintBrowserToolCall(input: SaintMcpToolTitleInput): boolean {
  return resolveSaintBrowserToolName([input.toolName, input.title, input.fallbackLabel]) !== null;
}

// Every provider exposes Saint's MCP tools differently: MCP, dynamic, and even
// file-change rows can all represent the same gateway action. Normalize by tool
// identity instead of provider item type so transport details never reach the UI.
export function deriveSaintMcpToolTitle(input: SaintMcpToolTitleInput): string | null {
  const presentation = resolveSaintMcpToolPresentation([
    input.toolName,
    input.title,
    input.fallbackLabel,
  ]);
  if (!presentation) {
    return null;
  }
  switch (input.status ?? "completed") {
    case "running":
      return presentation.running;
    case "completed":
      return presentation.completed;
    case "failed":
      return presentation.failed;
    case "cancelled":
      return presentation.running.startsWith("Saint is ")
        ? `Saint stopped ${presentation.running.slice("Saint is ".length)}`
        : `Cancelled ${presentation.running}`;
  }
}

export function sanitizeSaintMcpToolPreview(input: {
  readonly preview?: string | null | undefined;
  readonly heading: string;
  readonly status?: SaintMcpToolStatus | undefined;
}): string | null {
  const preview = input.preview?.trim();
  if (!preview) return null;
  const previewTitle = deriveSaintMcpToolTitle({ title: preview, status: input.status });
  if (
    previewTitle &&
    normalizeSaintMcpIdentifier(previewTitle) === normalizeSaintMcpIdentifier(input.heading)
  ) {
    return null;
  }
  return preview;
}

export function deriveReadableToolTitle(input: ReadableToolTitleInput): string | null {
  const normalizedTitle = normalizeCompactToolLabel(input.title ?? "");
  const normalizedFallback = normalizeCompactToolLabel(input.fallbackLabel);
  const commandLabel = input.command
    ? deriveReadableCommandDisplay(input.command, input.isRunning).verb
    : null;
  const commandLike = input.itemType === "command_execution" || input.requestKind === "command";

  // Derive a verbal label from requestKind when the title is generic
  const requestKindLabel = humanizeRequestKind(input.requestKind, input.itemType);

  if (normalizedTitle.length > 0 && !isGenericToolTitle(normalizedTitle)) {
    return (input.itemType === "mcp_tool_call" || input.itemType === "dynamic_tool_call") &&
      /[_-]/.test(normalizedTitle)
      ? (normalizeToolDescriptor(normalizedTitle) ?? normalizedTitle)
      : normalizedTitle;
  }

  if (commandLike && commandLabel) {
    return commandLabel;
  }

  const descriptor = normalizeToolDescriptor(extractToolDescriptorFromPayload(input.payload));
  if (descriptor && !isGenericToolTitle(descriptor)) {
    return descriptor;
  }

  // A generic request kind describes the transport, while the payload can name
  // the actual tool. Only use it after the provider metadata has been checked.
  if (requestKindLabel) {
    return requestKindLabel;
  }

  if (normalizedFallback.length > 0 && !isGenericToolTitle(normalizedFallback)) {
    return normalizedFallback;
  }
  if (normalizedTitle.length > 0) {
    return normalizedTitle;
  }
  if (normalizedFallback.length > 0) {
    return normalizedFallback;
  }
  return null;
}

export interface ReadableCommandDisplay {
  readonly verb: string;
  readonly target: string;
  readonly fullCommand: string;
}

// "read" and "search" split the read-only inspections so a file read and a
// pattern search wear different glyphs; listings (`ls`) are plain commands.
export type CommandVisualKind = "read" | "search" | "git" | "github" | "terminal";

function humanizeRequestKind(
  requestKind: ReadableToolTitleInput["requestKind"],
  itemType: ReadableToolTitleInput["itemType"],
): string | null {
  if (requestKind === "file-read") return "Read";
  if (requestKind === "file-change" || itemType === "file_change") return "Edited";
  if (requestKind === "tool") return "Tool";
  // Don't handle command types here — let humanizeCommandToolLabel produce more specific labels
  if (itemType === "web_search") return "Searched the web";
  if (itemType === "image_generation") return "Generated image";
  if (itemType === "image_view") return "Viewed image";
  if (itemType === "collab_agent_tool_call") return "Agent task";
  return null;
}

export function isGenericToolTitle(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalized === "tool" ||
    normalized === "tool call" ||
    normalized === "dynamic tool call" ||
    normalized === "mcp tool call" ||
    normalized === "agent task" ||
    normalized === "subagent task" ||
    normalized === "task" ||
    normalized === "command run" ||
    normalized === "ran command" ||
    normalized === "running command" ||
    normalized === "command execution" ||
    normalized === "file change" ||
    normalized === "find" ||
    normalized === "read file"
  );
}

function normalizeToolDescriptor(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const computerTool = computerToolName(value);
  if (computerTool) {
    return COMPUTER_TOOL_TITLES[computerTool];
  }
  const mcpIdentifier = humanizeMcpToolIdentifier(value);
  if (mcpIdentifier) {
    return mcpIdentifier;
  }
  const normalized = value.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const dedupedTokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (dedupedTokens.at(-1)?.toLowerCase() === token.toLowerCase()) {
      continue;
    }
    dedupedTokens.push(token);
  }
  const collapsed = dedupedTokens.join(" ").trim();
  if (!collapsed) {
    return null;
  }
  const lowerCollapsed = collapsed.toLowerCase();
  if (lowerCollapsed === "read") {
    return "Read";
  }
  if (lowerCollapsed === "search" || lowerCollapsed === "find" || lowerCollapsed === "searched") {
    return "Search";
  }
  const readable = /[_-]/.test(value) ? humanizeMcpToken(collapsed) : collapsed;
  return readable.length > 64 ? `${readable.slice(0, 61).trimEnd()}...` : readable;
}

function humanizeMcpToken(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .split(" ")
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === "mcp") return "MCP";
      if (token.toUpperCase() === token && token.length <= 5) return token;
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function extractToolDescriptorFromPayload(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) {
    return null;
  }
  const mcpServerTool = extractMcpServerToolDescriptor(payload, 0);
  if (mcpServerTool) {
    return mcpServerTool;
  }
  const descriptorKeys = ["kind", "name", "tool", "tool_name", "toolName", "title"];
  const candidates: string[] = [];
  collectDescriptorCandidates(payload, descriptorKeys, candidates, 0);
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized) {
      continue;
    }
    if (isGenericToolTitle(normalizeCompactToolLabel(normalized))) {
      continue;
    }
    return normalized;
  }
  return null;
}

function extractMcpServerToolDescriptor(value: unknown, depth: number): string | null {
  const pair = findMcpServerToolPair(value, depth);
  return pair ? humanizeMcpServerTool(pair.server, pair.tool) : null;
}

// Codex reports MCP calls as `{ server, tool }` somewhere inside the payload.
function findMcpServerToolPair(
  value: unknown,
  depth: number,
): { readonly server: string; readonly tool: string } | null {
  if (depth > 4 || !value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findMcpServerToolPair(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.server === "string" && typeof record.tool === "string") {
    return { server: record.server, tool: record.tool };
  }
  for (const nestedKey of [
    "item",
    "data",
    "event",
    "payload",
    "result",
    "input",
    "call",
    "invocation",
    "source",
  ]) {
    const nested = findMcpServerToolPair(record[nestedKey], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

/**
 * The MCP server behind a tool call: Claude names tools `mcp__<server>__<tool>`,
 * Codex reports a `{ server, tool }` pair in the payload. Null for other tools.
 */
export function extractMcpServerName(
  toolName: string | null | undefined,
  payload: unknown,
): string | null {
  const trimmed = toolName?.trim() ?? "";
  if (trimmed.startsWith("mcp__")) {
    const server = trimmed.split("__")[1]?.trim();
    if (server) return server;
  }
  const server = findMcpServerToolPair(payload, 0)?.server.trim();
  return server ? server : null;
}

function collectDescriptorCandidates(
  value: unknown,
  keys: ReadonlyArray<string>,
  target: string[],
  depth: number,
) {
  if (depth > 4 || target.length >= 24) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      target.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDescriptorCandidates(entry, keys, target, depth + 1);
      if (target.length >= 24) {
        return;
      }
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      const trimmed = (record[key] as string).trim();
      if (trimmed) {
        target.push(trimmed);
      }
    }
  }
  for (const nestedKey of ["item", "data", "event", "payload", "result", "input", "tool", "call"]) {
    if (nestedKey in record) {
      collectDescriptorCandidates(record[nestedKey], keys, target, depth + 1);
      if (target.length >= 24) {
        return;
      }
    }
  }
}

// Read-only inspection commands: file reads wear the file glyph, searches and
// finds the magnifier; listings and everything else keep the terminal icon.
// These sets are the single source of truth for both the command labels below
// and the icon decision.
const READ_FILE_COMMAND_TOOLS = new Set(["cat", "nl", "head", "tail", "sed", "less", "more"]);
const SEARCH_COMMAND_TOOLS = new Set(["rg", "grep", "ag", "ack"]);
const FIND_COMMAND_TOOLS = new Set(["find", "fd"]);
const LIST_COMMAND_TOOLS = new Set(["ls"]);

// Derives the compact command sentence shown inline while preserving the full command for hover/detail UI.
export function deriveReadableCommandDisplay(
  rawCommand: string,
  isRunning = false,
): ReadableCommandDisplay {
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const primaryCommand = firstShellCommandSegment(command);
  const [tool, args] = splitToolAndArgs(primaryCommand);

  if (READ_FILE_COMMAND_TOOLS.has(tool)) {
    return {
      verb: isRunning ? "Reading" : "Read",
      target: lastPathComponents(args, "file"),
      fullCommand: rawCommand,
    };
  }
  if (SEARCH_COMMAND_TOOLS.has(tool)) {
    return {
      verb: isRunning ? "Searching" : "Searched",
      target: searchSummary(args),
      fullCommand: rawCommand,
    };
  }
  if (LIST_COMMAND_TOOLS.has(tool)) {
    return {
      verb: isRunning ? "Listing" : "Listed",
      target: lastPathComponents(args, "directory"),
      fullCommand: rawCommand,
    };
  }
  if (FIND_COMMAND_TOOLS.has(tool)) {
    return {
      verb: isRunning ? "Finding" : "Found",
      target: findTarget(args, "files"),
      fullCommand: rawCommand,
    };
  }

  switch (tool) {
    case "mkdir":
      return {
        verb: isRunning ? "Creating" : "Created",
        target: lastPathComponents(args, "directory"),
        fullCommand: rawCommand,
      };
    case "rm":
      return {
        verb: isRunning ? "Removing" : "Removed",
        target: lastPathComponents(args, "file"),
        fullCommand: rawCommand,
      };
    case "cp":
    case "mv":
      return {
        verb: isRunning
          ? tool === "cp"
            ? "Copying"
            : "Moving"
          : tool === "cp"
            ? "Copied"
            : "Moved",
        target: lastPathComponents(args, "file"),
        fullCommand: rawCommand,
      };
    case "git":
      return humanizeGitCommand(args, rawCommand, isRunning);
    case "node":
    case "bun":
    case "deno":
    case "python":
    case "python3":
    case "ruby":
    case "perl":
      return {
        verb: isRunning ? "Running" : "Ran",
        target: inlineScriptTarget(tool, command, args) ?? compactInlineCommand(command),
        fullCommand: rawCommand,
      };
    case "osascript":
      return {
        verb: isRunning ? "Running" : "Ran",
        target: "AppleScript",
        fullCommand: rawCommand,
      };
    default:
      return {
        verb: isRunning ? "Running" : "Ran",
        target: compactInlineCommand(command),
        fullCommand: rawCommand,
      };
  }
}

function firstCommandExecutable(rawCommand: string): string {
  const trimmed = rawCommand.trim();
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(trimmed);
  const executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return executable.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

// The object half of a command row's sentence ("Searched <for foo in src>"),
// kept short enough to read inline. Shell wrappers that carry no meaning for a
// human (a full pwsh.exe path) collapse to the shell's friendly name.
export function deriveFriendlyCommandTarget(rawCommand: string): string {
  const executable = firstCommandExecutable(rawCommand);
  if (
    executable === "pwsh" ||
    executable === "pwsh.exe" ||
    executable === "powershell" ||
    executable === "powershell.exe"
  ) {
    return "PowerShell";
  }
  if (executable === "cmd" || executable === "cmd.exe") {
    return "Command Prompt";
  }

  const target = deriveReadableCommandDisplay(rawCommand).target.trim();
  return target.length <= 72 ? target : `${target.slice(0, 69).trimEnd()}…`;
}

// Classifies command rows for transcript glyphs after peeling away shell/env wrappers.
// This keeps `git -C`, `env ... gh`, and `/bin/zsh -lc "cd ... && git ..."` visually branded.
export function resolveCommandVisualKind(rawCommand: string): CommandVisualKind {
  if (deriveCommandReadTargets(rawCommand) !== null) {
    return "read";
  }
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const [tool] = splitToolAndArgs(firstShellCommandSegment(command));
  if (SEARCH_COMMAND_TOOLS.has(tool) || FIND_COMMAND_TOOLS.has(tool)) {
    return "search";
  }
  if (tool === "git") {
    return "git";
  }
  if (tool === "gh" || tool === "hub") {
    return "github";
  }
  return "terminal";
}

export function deriveInlineCommandCall(rawCommand: string): string {
  return stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
}

// The command a row shows: what actually ran, minus the shell wrapper
// (`/bin/zsh -lc "…"`) and leading `cd <dir> &&` preambles. Pipes, chains and
// quoting stay verbatim, unlike `deriveInlineCommandCall`, which keeps only the
// first pipeline stage for classification.
export function deriveLiteralCommand(rawCommand: string): string {
  let value = rawCommand.trim();
  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    break;
  }
  return stripLeadingShellPreambles(value).replace(/\s+/g, " ").trim();
}

// Files a command only reads, or null when the command does anything else.
// A row may say "Read <file>" instead of the literal command only when that
// is the whole story: no pipes, chains, redirects or substitutions, and no
// in-place edit (`sed -i`).
export function deriveCommandReadTargets(rawCommand: string): string[] | null {
  const literal = deriveLiteralCommand(rawCommand);
  if (literal.length === 0 || hasUnquotedShellOperator(literal)) {
    return null;
  }
  const [tool, args] = splitToolAndArgs(stripCommandDisplayWrappers(literal));
  if (!READ_FILE_COMMAND_TOOLS.has(tool)) {
    return null;
  }
  const tokens = tokenizeCommandArgs(args);
  const files: string[] = [];
  let skipNext = false;
  let sedScriptPending = tool === "sed";
  let sedPrintOnly = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (tool === "sed") {
        if (token === "-i" || token.startsWith("-i") || token.startsWith("--in-place")) {
          return null;
        }
        if (token === "-n" || token === "--quiet" || token === "--silent") {
          sedPrintOnly = true;
        }
        if (token === "-e" || token === "--expression") {
          sedScriptPending = false;
          skipNext = true;
        }
      }
      if ((tool === "head" || tool === "tail") && (token === "-n" || token === "-c")) {
        skipNext = true;
      }
      continue;
    }
    if (sedScriptPending) {
      sedScriptPending = false;
      continue;
    }
    files.push(compactPath(token));
  }
  if (tool === "sed" && !sedPrintOnly) {
    return null;
  }
  return files.length > 0 ? files : null;
}

const SHELL_WRAPPER_PREFIXES = [
  "/usr/bin/bash -lc ",
  "/usr/bin/bash -c ",
  "/bin/bash -lc ",
  "/bin/bash -c ",
  "/usr/bin/zsh -lc ",
  "/usr/bin/zsh -c ",
  "/bin/zsh -lc ",
  "/bin/zsh -c ",
  "/bin/sh -lc ",
  "/bin/sh -c ",
  "bash -lc ",
  "bash -c ",
  "zsh -lc ",
  "zsh -c ",
  "sh -lc ",
  "sh -c ",
];

// Pipes, chains, redirects, background jobs and substitutions outside quotes.
function hasUnquotedShellOperator(value: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (
      char === "|" ||
      char === "&" ||
      char === ";" ||
      char === ">" ||
      char === "<" ||
      char === "`" ||
      (char === "$" && value[index + 1] === "(")
    ) {
      return true;
    }
  }
  return false;
}

function humanizeGitCommand(
  args: string,
  rawCommand: string,
  isRunning: boolean,
): ReadableCommandDisplay {
  const normalizedArgs = stripGitGlobalOptions(args);
  const subcommand = normalizedArgs.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  switch (subcommand) {
    case "status":
      return {
        verb: isRunning ? "Checking" : "Checked",
        target: "git status",
        fullCommand: rawCommand,
      };
    case "diff":
      return {
        verb: isRunning ? "Comparing" : "Compared",
        target: "changes",
        fullCommand: rawCommand,
      };
    case "show":
      return {
        verb: isRunning ? "Inspecting" : "Inspected",
        target: "commit",
        fullCommand: rawCommand,
      };
    case "log":
      return {
        verb: isRunning ? "Reviewing" : "Reviewed",
        target: "git history",
        fullCommand: rawCommand,
      };
    case "add":
      return {
        verb: isRunning ? "Staging" : "Staged",
        target: "changes",
        fullCommand: rawCommand,
      };
    case "commit":
      return {
        verb: isRunning ? "Committing" : "Committed",
        target: "changes",
        fullCommand: rawCommand,
      };
    case "push":
      return {
        verb: isRunning ? "Pushing" : "Pushed",
        target: "to remote",
        fullCommand: rawCommand,
      };
    case "pull":
      return {
        verb: isRunning ? "Pulling" : "Pulled",
        target: "from remote",
        fullCommand: rawCommand,
      };
    case "checkout":
    case "switch":
      return {
        verb: isRunning ? "Switching to" : "Switched to",
        target: checkoutTarget(args),
        fullCommand: rawCommand,
      };
    default:
      return {
        verb: isRunning ? "Running" : "Ran",
        target: compactInlineCommand(`git ${normalizedArgs}`.trim()),
        fullCommand: rawCommand,
      };
  }
}

function stripGitGlobalOptions(args: string): string {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 2;
      continue;
    }
    if (
      token.startsWith("-C") ||
      token.startsWith("-c") ||
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=")
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index).join(" ");
}

function checkoutTarget(args: string): string {
  const branch = tokenizeCommandArgs(args).at(-1)?.trim();
  return branch ? branch : "branch";
}

function lastPathComponents(args: string, fallback: string): string {
  const tokens = tokenizeCommandArgs(args);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!.replace(/^['"]|['"]$/g, "");
    if (!token || token.startsWith("-")) {
      continue;
    }
    return compactPath(token);
  }
  return fallback;
}

function findTarget(args: string, fallback: string): string {
  const tokens = tokenizeCommandArgs(args);
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      if (
        token === "-maxdepth" ||
        token === "-mindepth" ||
        token === "-name" ||
        token === "-type" ||
        token === "-path"
      ) {
        skipNext = true;
      }
      continue;
    }
    return compactPath(token);
  }
  return fallback;
}

function compactPath(path: string): string {
  if (path === ".") {
    return "current directory";
  }
  if (path === "..") {
    return "parent directory";
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }
  return parts.slice(-2).join("/");
}

function compactInlineCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137).trimEnd()}...`;
}

function firstShellCommandSegment(command: string): string {
  const chain = findShellChain(command);
  return chain ? command.slice(0, chain.operatorStart).trim() : command;
}

function inlineScriptTarget(tool: string, command: string, args: string): string | null {
  const normalizedTool = tool === "python3" ? "python" : tool;
  if (containsHeredoc(command) || hasInlineScriptFlag(args)) {
    return `${normalizedTool} script`;
  }
  return null;
}

function containsHeredoc(command: string): boolean {
  return /(^|\s)<<-?\s*['"]?[A-Za-z0-9_]+/.test(command);
}

function hasInlineScriptFlag(args: string): boolean {
  const tokens = tokenizeCommandArgs(args);
  return tokens.some((token) => token === "-e" || token === "-c" || token.startsWith("-e="));
}

function searchSummary(args: string): string {
  const { pattern, path } = extractSearchPatternAndPath(args);
  if (pattern && path) {
    return `for ${pattern} in ${path}`;
  }
  if (pattern) {
    return `for ${pattern}`;
  }
  if (path) {
    return `in ${path}`;
  }
  return "files";
}

function extractSearchPatternAndPath(args: string): {
  pattern: string | null;
  path: string | null;
} {
  const tokens = tokenizeCommandArgs(args);
  let pattern: string | null = null;
  let path: string | null = null;
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      if (
        token === "-t" ||
        token === "-g" ||
        token === "--type" ||
        token === "--glob" ||
        token === "--max-count"
      ) {
        skipNext = true;
      }
      continue;
    }
    if (!pattern) {
      const normalizedPattern = normalizeSearchPatternToken(token);
      if (!normalizedPattern) {
        const normalizedPath = normalizeSearchPathToken(token);
        if (normalizedPath && (!path || path === "current directory")) {
          path = normalizedPath;
        }
        continue;
      }
      pattern = normalizedPattern;
      continue;
    }
    if (!path || path === "current directory") {
      path = normalizeSearchPathToken(token) ?? path;
      continue;
    }
  }

  if (pattern && path === "current directory" && looksLikeSearchPath(pattern)) {
    path = normalizeSearchPathToken(pattern);
    pattern = null;
  }

  return { pattern, path };
}

function normalizeSearchPatternToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return null;
  }
  if (!/[a-z0-9]/i.test(trimmed)) {
    return null;
  }
  return trimmed.length > 30 ? `${trimmed.slice(0, 27)}...` : trimmed;
}

function normalizeSearchPathToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  return compactPath(trimmed);
}

function looksLikeSearchPath(token: string): boolean {
  return token.includes("/") || token.startsWith(".") || token.includes("\\");
}

function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < args.length) {
    while (args[index] === " ") {
      index += 1;
    }
    if (index >= args.length) {
      break;
    }

    const quote = args[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let token = "";
      while (index < args.length && args[index] !== quote) {
        if (args[index] === "\\" && index + 1 < args.length) {
          token += args[index + 1];
          index += 2;
          continue;
        }
        token += args[index];
        index += 1;
      }
      if (args[index] === quote) {
        index += 1;
      }
      tokens.push(token);
      continue;
    }

    let token = "";
    while (index < args.length && args[index] !== " ") {
      token += args[index];
      index += 1;
    }
    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
}

function splitToolAndArgs(command: string): [tool: string, args: string] {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return ["", ""];
  }
  const separator = normalized.indexOf(" ");
  if (separator === -1) {
    return [basenameOfPath(normalized).toLowerCase(), ""];
  }
  const tool = basenameOfPath(normalized.slice(0, separator)).toLowerCase();
  const args = normalized.slice(separator + 1).trim();
  return [tool, args];
}

function unwrapShellCommandIfPresent(rawCommand: string): string {
  let value = rawCommand.trim();
  if (!value) {
    return value;
  }

  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    value = stripLeadingShellPreambles(value);
    break;
  }

  const pipeIndex = value.indexOf("|");
  if (pipeIndex > 0) {
    value = value.slice(0, pipeIndex).trim();
  }

  return value;
}

function stripLeadingShellPreambles(value: string): string {
  let current = value.trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const chain = findShellChain(current);
    if (!chain) {
      return current;
    }
    const head = current.slice(0, chain.operatorStart).trim();
    if (!isShellSetupPreamble(head)) {
      return current;
    }
    current = current.slice(chain.commandStart).trim();
  }
  return current;
}

function isShellSetupPreamble(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (/^(?:builtin\s+)?cd\s+/.test(normalized)) {
    return true;
  }
  if (/^(?:source|\.)\s+/.test(normalized)) {
    return true;
  }
  if (/^set\s+[-+][A-Za-z]/.test(normalized)) {
    return true;
  }
  if (
    /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=[^\s]+(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function findShellChain(value: string): { operatorStart: number; commandStart: number } | null {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const next = value[index + 1];
    if (char === "&" && next === "&") {
      return { operatorStart: index, commandStart: index + 2 };
    }
    if (char === ";") {
      return { operatorStart: index, commandStart: index + 1 };
    }
  }

  return null;
}

function stripCommandDisplayWrappers(command: string): string {
  let current = command.replace(/\s+/g, " ").trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const [tool, args] = splitToolAndArgs(current);
    const next =
      tool === "env"
        ? stripEnvCommand(args)
        : tool === "timeout" || tool === "gtimeout"
          ? stripTimeoutCommand(args)
          : tool === "nice"
            ? stripNiceCommand(args)
            : tool === "arch"
              ? stripArchCommand(args)
              : tool === "command"
                ? args
                : null;
    if (!next || next === current) {
      return current;
    }
    current = next.trim();
  }
  return current;
}

function stripEnvCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
      index += 2;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=")) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripTimeoutCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length && tokens[index]?.startsWith("-")) {
    index += tokens[index] === "-s" || tokens[index] === "-k" ? 2 : 1;
  }
  if (index < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index]!)) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripNiceCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  if (tokens[index] === "-n") {
    index += 2;
  } else {
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripArchCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}
