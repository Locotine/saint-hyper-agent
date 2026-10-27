import {
  BROWSER_TOOL_NAMES,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@saint/contracts";

/** Exact tool names owned by Saint's capability-gated Computer gateway. */
export const SAINT_COMPUTER_TOOL_NAMES = [
  "computer_activate_window",
  "computer_click",
  "computer_drag",
  "computer_get_accessibility_tree",
  "computer_get_cursor_position",
  "computer_get_screen_size",
  "computer_get_state",
  "computer_help",
  "computer_inspect",
  "computer_spaces",
  "computer_invoke_menu",
  "computer_kill_app",
  "computer_launch_app",
  "computer_list_apps",
  "computer_list_windows",
  "computer_move_cursor",
  "computer_paste",
  "computer_perform_action",
  "computer_press_key",
  "computer_read_clipboard",
  "computer_run",
  "computer_screenshot",
  "computer_scroll",
  "computer_select_text",
  "computer_set_app_visibility",
  "computer_set_value",
  "computer_set_window_frame",
  "computer_set_window_minimized",
  "computer_type_text",
  "computer_verify_state",
  "computer_wait",
  "computer_write_clipboard",
  "computer_zoom",
  // The cua-driver CDP browser family. Deliberately inside the Computer
  // namespace: these are the same capability (computer:control), the same
  // approval gate, and the same denial-card path as the desktop tools — they
  // merely dispatch over CDP rather than OS events. They must never collide
  // with the integrated `browser_*` surface, which is a different host.
  "computer_browser_state",
  "computer_browser_prepare",
  "computer_browser_navigate",
  "computer_browser_click",
  "computer_browser_type",
  "computer_browser_dialog",
  "computer_browser_upload",
  "computer_browser_download",
  "computer_browser_pointer",
  "computer_browser_press",
] as const;

export type SaintComputerToolName = (typeof SAINT_COMPUTER_TOOL_NAMES)[number];

const SAINT_COMPUTER_TOOL_NAME_SET = new Set<string>(SAINT_COMPUTER_TOOL_NAMES);

function recordString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Accept only the canonical gateway name or the exact provider qualifications
 * used for Saint's reserved MCP server. A similarly named tool from another
 * MCP server must continue through the provider's ordinary permission policy.
 */
export function canonicalSaintComputerToolName(value: unknown): SaintComputerToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const canonical = normalized.startsWith("mcp__saint__")
    ? normalized.slice("mcp__saint__".length)
    : normalized.startsWith("saint_")
      ? normalized.slice("saint_".length)
      : normalized;
  return SAINT_COMPUTER_TOOL_NAME_SET.has(canonical)
    ? (canonical as SaintComputerToolName)
    : undefined;
}

/**
 * Provider callbacks must carry Saint's namespace themselves. Bare canonical
 * names are safe only after a separate protocol field has proved the server
 * identity (for example Codex's `serverName`).
 */
export function qualifiedSaintComputerToolName(value: unknown): SaintComputerToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("mcp__saint__") && !normalized.startsWith("saint_")) {
    return undefined;
  }
  return canonicalSaintComputerToolName(normalized);
}

/**
 * Namespace-insensitive matcher for Computer calls at the gateway boundary.
 *
 * A session that was never granted computer control must still surface the
 * denial card path when the model reaches for a Computer tool, or the attempt
 * dies as a silent tool error and the user never learns control is off.
 *
 * Gateway transport (all MCP providers): `makeAgentGatewayMcpTransport`
 * (`apps/server/src/agentGateway/mcpTransport.ts`) denies an unknown tool
 * name with `capability_denied` plus the denial hook only when
 * `isComputerToolName` matches. Wired in
 * `apps/server/src/agentGateway/Layers/AgentGateway.ts` as the catalog
 * membership test OR this family matcher, so a prefixed spelling from a
 * session that never saw the catalog —
 * `saint_computer_click`, `mcp__saint__computer_click` — still reaches
 * the denial hook and the card.
 *
 * Pi's native projection adds specialist forwarders only when its leased
 * catalog advertises Computer control. Disabled sessions carry no Computer
 * fallback schemas; stale calls reaching this boundary still receive the same
 * capability denial as other MCP clients.
 *
 * Entirely-unknown names (`computer_future_tool`, another server's
 * `mcp__other__computer_click`) must keep their current behavior — unknown
 * tools stay INVALID_PARAMS and foreign tools keep the provider's ordinary
 * permission policy — so this matcher accepts only exact owned names in any
 * of the three spellings, never prose around them.
 */
export function isSaintComputerToolFamilyName(value: unknown): boolean {
  return canonicalSaintComputerToolName(value) !== undefined;
}

function firstRecordString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const candidate = recordString(value, key);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

export function computerToolNameFromProviderPermission(input: {
  readonly name?: unknown;
  readonly title?: unknown;
  readonly rawInput?: unknown;
  readonly metadata?: unknown;
}): SaintComputerToolName | undefined {
  const explicitName = typeof input.name === "string" ? input.name : undefined;
  if (explicitName !== undefined) return qualifiedSaintComputerToolName(explicitName);

  const rawToolName = firstRecordString(input.rawInput, ["_toolName", "toolName", "tool_name"]);
  if (rawToolName !== undefined) return qualifiedSaintComputerToolName(rawToolName);

  const metadataToolName = firstRecordString(input.metadata, [
    "_toolName",
    "toolName",
    "tool_name",
  ]);
  if (metadataToolName !== undefined) return qualifiedSaintComputerToolName(metadataToolName);

  // The display `title` is provider-composed text, not a tool name — a
  // request that only *renders* as a Saint computer call names no such tool
  // and must keep the ordinary permission path.
  return undefined;
}

/**
 * The `saint_*` catalog served by Saint's agent gateway: thread read/write,
 * project agent, automation, diagnostics, and review tools. Kept exact — a
 * look-alike MCP server (`saint_fs`, `saint_tools`) must never inherit the
 * auto-approve path the reserved `saint` server gets.
 */
const SAINT_GATEWAY_OWNED_TOOL_NAMES = [
  // Thread read tools (threadReadTools.ts)
  "saint_context",
  "saint_capabilities",
  "saint_list_projects",
  "saint_list_threads",
  "saint_read_thread",
  "saint_wait_for_threads",
  // Kanban tools (kanbanTools.ts)
  "saint_read_kanban_board",
  "saint_read_kanban_card",
  "saint_create_kanban_task",
  "saint_create_kanban_draft",
  "saint_move_kanban_card",
  "saint_update_kanban_card",
  "saint_set_kanban_goal",
  "saint_delete_kanban_card",
  // To-do tools (todoTools.ts)
  "saint_create_todo",
  "saint_list_todos",
  "saint_update_todo",
  // Inline visuals (inlineVisualTools.ts; available in Stable and Beta)
  "saint_show_visual",
  // Thread write tools (Layers/AgentGateway.ts)
  "saint_create_threads",
  "saint_create_thread",
  "saint_send_message",
  "saint_interrupt_thread",
  "saint_set_thread_title",
  "saint_set_thread_pull_request",
  "saint_set_thread_archived",
  "saint_set_thread_goal",
  // Thread diagnostics (threadDiagnosticTools.ts)
  "saint_read_thread_activity",
  "saint_diagnose_thread",
  "saint_read_thread_events",
  "saint_read_thread_runtime_events",
  // Automations (automationTools.ts)
  "saint_create_automation",
  "saint_list_automations",
  "saint_view_automation",
  "saint_update_automation",
  "saint_update_automation_memory",
  "saint_cancel_automation",
  "saint_report_automation_result",
  // Project agent tools (projectAgentTools.ts)
  "saint_project_context",
  "saint_project_forget",
  "saint_project_get_overview",
  "saint_project_library_add",
  "saint_project_library_list",
  "saint_project_link_repository",
  "saint_project_list_tasks",
  "saint_project_list_threads",
  "saint_project_read_document",
  "saint_project_remember",
  "saint_project_report_result",
  "saint_project_write_document",
  // Browser review tool (browserTools.ts)
  "saint_e2e_review",
  // Capability-gated device tools (deviceTools.ts — not in contracts)
  "device_boot",
  "device_configure",
  "device_describe_ui",
  "device_install",
  "device_launch",
  "device_list",
  "device_logs",
  "device_open_url",
  "device_press_button",
  "device_screenshot",
  "device_scroll_to_element",
  "device_swipe",
  "device_tap",
  "device_type",
  "device_wait",
] as const;

/** Every tool name the agent gateway serves, from the shared catalogs. */
const SAINT_GATEWAY_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>([
  ...SAINT_GATEWAY_OWNED_TOOL_NAMES,
  ...SAINT_COMPUTER_TOOL_NAMES,
  ...BROWSER_TOOL_NAMES,
]);

const SAINT_MCP_QUALIFIED_PREFIX = "mcp__saint__";
const SAINT_MCP_SERVER_PREFIX = "saint_";

/**
 * Any tool Saint's agent gateway serves under its reserved MCP server name —
 * the whole gateway catalog (thread, project, automation, diagnostics,
 * computer, browser, device). The session token is what authorizes each call
 * server-side, so providers that were granted the gateway may let these names
 * skip their own interactive permission prompt when the start input opts in
 * (`ProviderSessionStartInput.autoApproveSaintTools`).
 *
 * Providers report MCP calls two ways, and both must pin the server identity:
 * Claude-style `mcp__saint__<tool>` matches on the exact `mcp__saint__`
 * prefix (a `saint_fs` server produces `mcp__saint_fs__*`, which fails it);
 * `<server>_<tool>` reports like OpenCode's `saint_computer_click` match only
 * when the name — or the part after the `saint_` server prefix — is in the
 * served catalog. A bare `saint_*` catalog name (`saint_list_threads`) also
 * matches because the name itself carries the namespace; capability families
 * (`computer_*`, `browser_*`, `device_*`) must arrive server-qualified.
 * Everything else keeps the ordinary permission path.
 */
export function isSaintGatewayToolName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith(SAINT_MCP_QUALIFIED_PREFIX)) {
    // The `mcp__saint__` prefix pins the server, not the tool — only a real
    // catalog name after the prefix may take the auto-approve path, so a
    // look-alike tool name on the same server cannot ride it.
    return SAINT_GATEWAY_TOOL_NAME_SET.has(normalized.slice(SAINT_MCP_QUALIFIED_PREFIX.length));
  }
  if (SAINT_GATEWAY_TOOL_NAME_SET.has(normalized)) {
    return normalized.startsWith(SAINT_MCP_SERVER_PREFIX);
  }
  return (
    normalized.startsWith(SAINT_MCP_SERVER_PREFIX) &&
    SAINT_GATEWAY_TOOL_NAME_SET.has(normalized.slice(SAINT_MCP_SERVER_PREFIX.length))
  );
}

/**
 * Namespace-insensitive matcher across the fields a provider permission
 * prompt may report a tool name through — the direct name, or a tool-name
 * field nested in raw input / metadata the way some adapters deliver MCP
 * calls. The display `title` is deliberately not consulted: it is
 * presentational text the provider composes, so it can look like a gateway
 * name without one ever being called.
 */
export function isSaintGatewayToolCall(input: {
  readonly name?: unknown;
  // Accepted for call-site shape compatibility but never consulted.
  readonly title?: unknown;
  readonly rawInput?: unknown;
  readonly metadata?: unknown;
}): boolean {
  const explicitName = typeof input.name === "string" ? input.name : undefined;
  if (explicitName !== undefined) return isSaintGatewayToolName(explicitName);

  const rawToolName = firstRecordString(input.rawInput, ["_toolName", "toolName", "tool_name"]);
  if (rawToolName !== undefined) return isSaintGatewayToolName(rawToolName);

  const metadataToolName = firstRecordString(input.metadata, [
    "_toolName",
    "toolName",
    "tool_name",
  ]);
  if (metadataToolName !== undefined) return isSaintGatewayToolName(metadataToolName);

  return false;
}

/**
 * Provider permission prompts are redundant for an active Saint Computer
 * capability: the gateway performs the authoritative task-scoped approval.
 * Plan mode and requests outside an active turn remain fail-closed.
 */
export function shouldAllowSaintComputerProviderTool(input: {
  readonly computerControlEnabled: boolean;
  readonly activeTurn: boolean;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly permission: Parameters<typeof computerToolNameFromProviderPermission>[0];
}): boolean {
  return (
    input.computerControlEnabled &&
    input.activeTurn &&
    input.runtimeMode === "approval-required" &&
    input.interactionMode === "default" &&
    computerToolNameFromProviderPermission(input.permission) !== undefined
  );
}
