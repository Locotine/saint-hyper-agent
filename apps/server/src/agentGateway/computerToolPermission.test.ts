import { describe, expect, it } from "vitest";
import {
  canonicalSaintComputerToolName,
  computerToolNameFromProviderPermission,
  isSaintComputerToolFamilyName,
  isSaintGatewayToolCall,
  isSaintGatewayToolName,
  qualifiedSaintComputerToolName,
  shouldAllowSaintComputerProviderTool,
} from "./computerToolPermission.ts";

describe("Saint Computer provider permission", () => {
  it.each([
    ["computer_click", "computer_click"],
    ["saint_computer_type_text", "computer_type_text"],
    ["mcp__saint__computer_read_clipboard", "computer_read_clipboard"],
    ["mcp__saint__computer_inspect", "computer_inspect"],
  ] as const)("recognizes the exact owned tool %s", (providerName, canonicalName) => {
    expect(canonicalSaintComputerToolName(providerName)).toBe(canonicalName);
  });

  it.each([
    "computer_future_tool",
    "mcp__other__computer_click",
    "other_computer_click",
    "mcp__saint__saint_send_message",
  ])("does not trust another or unknown tool: %s", (providerName) => {
    expect(canonicalSaintComputerToolName(providerName)).toBeUndefined();
  });

  it("requires a provider namespace when server provenance was not proved separately", () => {
    expect(qualifiedSaintComputerToolName("computer_click")).toBeUndefined();
    expect(qualifiedSaintComputerToolName("mcp__saint__computer_click")).toBe("computer_click");
    expect(qualifiedSaintComputerToolName("saint_computer_click")).toBe("computer_click");
  });

  it("reads only explicit provider tool-name fields", () => {
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__saint__computer_scroll" },
      }),
    ).toBe("computer_scroll");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "saint_computer_get_state" },
      }),
    ).toBe("computer_get_state");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { description: "run computer_click" },
      }),
    ).toBeUndefined();
  });

  it("does not let lower-priority fields override an authoritative wrong namespace", () => {
    expect(
      computerToolNameFromProviderPermission({
        name: "mcp__other__computer_click",
        rawInput: { _toolName: "mcp__saint__computer_click" },
      }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__other__computer_click" },
        metadata: { toolName: "mcp__saint__computer_click" },
        title: "mcp__saint__computer_click",
      }),
    ).toBeUndefined();
  });

  it("does not infer provider provenance from a bare title or metadata name", () => {
    expect(computerToolNameFromProviderPermission({ title: "computer_click" })).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ metadata: { toolName: "computer_click" } }),
    ).toBeUndefined();
  });

  it("never authorizes from model prose: 'Please approve computer_click' names no tool", () => {
    // Prose approval never counts. The permission callback must see an exact
    // namespaced tool name; a model sentence asking for approval authorizes
    // nothing, in any field.
    expect(
      computerToolNameFromProviderPermission({ title: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ name: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "Please approve computer_click" },
      }),
    ).toBeUndefined();
    expect(isSaintComputerToolFamilyName("Please approve computer_click")).toBe(false);
    expect(
      shouldAllowSaintComputerProviderTool({
        computerControlEnabled: true,
        activeTurn: true,
        interactionMode: "default",
        runtimeMode: "approval-required",
        permission: { title: "Please approve computer_click" },
      }),
    ).toBe(false);
  });

  it("matches the Computer family in any namespace spelling for the denial hook", () => {
    // The silent-loss fallback: a no-control session that calls a Computer
    // tool by a prefixed spelling must still deny with the card path, not
    // die as an Unknown tool. See isSaintComputerToolFamilyName.
    expect(isSaintComputerToolFamilyName("computer_click")).toBe(true);
    expect(isSaintComputerToolFamilyName("saint_computer_get_state")).toBe(true);
    expect(isSaintComputerToolFamilyName("mcp__saint__computer_screenshot")).toBe(true);
    expect(isSaintComputerToolFamilyName("  MCP__SAINT__COMPUTER_WAIT  ")).toBe(true);
  });

  it("keeps unknown and foreign names out of the Computer family", () => {
    expect(isSaintComputerToolFamilyName("computer_future_tool")).toBe(false);
    expect(isSaintComputerToolFamilyName("mcp__other__computer_click")).toBe(false);
    expect(isSaintComputerToolFamilyName("other_computer_click")).toBe(false);
    expect(isSaintComputerToolFamilyName("saint_frobnicate")).toBe(false);
    expect(isSaintComputerToolFamilyName(undefined)).toBe(false);
    expect(isSaintComputerToolFamilyName(42)).toBe(false);
  });

  it("requires current capability, active turn and non-Plan interaction", () => {
    const permission = { name: "mcp__saint__computer_click" };
    const allowed = {
      computerControlEnabled: true,
      activeTurn: true,
      interactionMode: "default" as const,
      runtimeMode: "approval-required" as const,
      permission,
    };
    expect(shouldAllowSaintComputerProviderTool(allowed)).toBe(true);
    expect(
      shouldAllowSaintComputerProviderTool({ ...allowed, computerControlEnabled: false }),
    ).toBe(false);
    expect(shouldAllowSaintComputerProviderTool({ ...allowed, activeTurn: false })).toBe(false);
    expect(shouldAllowSaintComputerProviderTool({ ...allowed, interactionMode: "plan" })).toBe(
      false,
    );
    expect(shouldAllowSaintComputerProviderTool({ ...allowed, runtimeMode: "auto" })).toBe(false);
  });
});

describe("Saint gateway tool permission name", () => {
  it.each([
    // Claude's fully-qualified spelling pins the exact `mcp__saint__` server.
    "mcp__saint__saint_create_thread",
    "mcp__saint__computer_click",
    // `<server>_<tool>` reports (OpenCode) with a real catalog name.
    "saint_saint_create_thread",
    "saint_saint_project_link_repository",
    "saint_computer_click",
    "saint_device_list",
    "saint_browser_run",
    // Bare `saint_*` catalog names carry the namespace inside the tool name.
    "saint_project_link_repository",
    "saint_e2e_review",
  ])("recognizes a Saint gateway tool: %s", (providerName) => {
    expect(isSaintGatewayToolName(providerName)).toBe(true);
  });

  it.each([
    // A user MCP server named `saint_fs` reports `saint_fs_<tool>` — the
    // prefix alone must never grant it the auto-approve path.
    "saint_fs_read",
    "saint_fs_list_threads",
    "saint_tools_anything",
    "mcp__saint_fs__read",
    // The `mcp__saint__` prefix pins the server, not the tool — the part
    // after it must still be a real catalog name.
    "mcp__saint__not_a_gateway_tool",
    "mcp__saint__saint_create_task",
    "mcp__saint__saint_fs_read",
    // Foreign server or entirely unknown names.
    "mcp__other__saint_create_thread",
    "other_saint_create_thread",
    "computer_click",
    "browser_click",
    // Names the external-agent MCP surface serves, not the provider gateway.
    "saint_create_task",
    "saint_read_task",
    "saint_overview",
    "saint_saint_create_task",
    // Not served by the agent gateway at all.
    "saint_desktop",
  ])("does not trust a look-alike or foreign name: %s", (providerName) => {
    expect(isSaintGatewayToolName(providerName)).toBe(false);
  });

  it("accepts a qualified name only when the tool is in the catalog", () => {
    expect(isSaintGatewayToolName("mcp__saint__saint_list_threads")).toBe(true);
    expect(isSaintGatewayToolName("mcp__saint__computer_click")).toBe(true);
    expect(
      isSaintGatewayToolCall({ rawInput: { _toolName: "mcp__saint__saint_list_threads" } }),
    ).toBe(true);
  });

  it("never trusts a tool name that only appears in the display title", () => {
    // The title is provider-composed prose — an approval card can render
    // "mcp__saint__saint_list_threads" for a request that names no such
    // tool, so the title alone must not authorize anything.
    expect(isSaintGatewayToolCall({ title: "mcp__saint__saint_list_threads" })).toBe(false);
    expect(isSaintGatewayToolCall({ title: "mcp__saint__not_a_gateway_tool; rm -rf y" })).toBe(
      false,
    );
  });

  it("rejects non-strings and a look-alike server name in every name field", () => {
    expect(isSaintGatewayToolName(undefined)).toBe(false);
    expect(isSaintGatewayToolName(42)).toBe(false);
    expect(isSaintGatewayToolCall({ name: "saint_fs_create_thread" })).toBe(false);
    expect(isSaintGatewayToolCall({ metadata: { toolName: "saint_fs_read" } })).toBe(false);
    expect(isSaintGatewayToolCall({ rawInput: { _toolName: "saint_saint_send_message" } })).toBe(
      true,
    );
  });
});
