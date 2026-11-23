import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorLanguageService } from "../editor/languageService.ts";
import type { EditorDebugShape } from "../editor/Services/EditorDebug.ts";
import {
  lineCharacterToUtf16Offset,
  makeAgentGatewayEditorTools,
  utf16OffsetToLineCharacter,
} from "./editorTools.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const cleanupDirs: string[] = [];
const cleanupServices: EditorLanguageService[] = [];

afterEach(async () => {
  for (const service of cleanupServices.splice(0)) {
    service.dispose();
  }
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeToolContext(threadId = "thread-editor-1"): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: `session:${threadId}`,
      threadId,
      provider: "antigravity",
      turnId: "turn-1",
    },
    callerThreadId: threadId,
    callerThreadLabel: "Editor Test",
    callerSessionKey: `session:${threadId}`,
    callerProvider: "antigravity",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    callerTurnId: "turn-1",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function callTool(
  tools: ReadonlyArray<ToolEntry>,
  name: string,
  args: Record<string, unknown>,
  context = makeToolContext(),
): Promise<{ readonly isError: boolean; readonly payload: Record<string, unknown> }> {
  const tool = tools.find((entry) => entry.definition.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  const result = await Effect.runPromise(tool.handler(args, context));
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "{}";
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = { text };
  }
  return { isError: result.isError === true, payload };
}

describe("editorTools coordinate helpers", () => {
  it("round-trips 1-based line/character positions and UTF-16 offsets", () => {
    const sample = "const a = 1;\nconst b = a + 2;\nexport { b };";
    const offset = lineCharacterToUtf16Offset(sample, 2, 11);
    expect(sample.slice(offset, offset + 1)).toBe("a");
    expect(utf16OffsetToLineCharacter(sample, offset)).toEqual({ line: 2, character: 11 });
  });
});

describe("makeAgentGatewayEditorTools (LSP)", () => {
  it("runs real TypeScript diagnostics, definition, hover, references, symbols, and rename preview", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "saint-editor-tools-"));
    cleanupDirs.push(workspace);
    await writeFile(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
        },
        include: ["*.ts"],
      }),
    );
    await writeFile(
      path.join(workspace, "math.ts"),
      "export function computeTotal(price: number, qty: number): number {\n  return price * qty;\n}\n",
    );
    await writeFile(
      path.join(workspace, "main.ts"),
      [
        'import { computeTotal } from "./math";',
        "export const total = computeTotal(10, 3);",
        'export const bad: number = "oops";',
        "",
      ].join("\n"),
    );

    const languageService = new EditorLanguageService();
    cleanupServices.push(languageService);
    const tools = makeAgentGatewayEditorTools({
      editorLanguage: languageService,
      resolveWorkspaceRoot: () => Effect.succeed(workspace),
    });

    // 1. Diagnostics finds the exact TS2322 type error on line 3
    const diags = await callTool(tools, "saint_lsp_diagnostics", { relativePath: "main.ts" });
    expect(diags.isError).toBe(false);
    expect(diags.payload.count).toBeGreaterThanOrEqual(1);
    const diagnostics = diags.payload.diagnostics as Array<{
      severity: string;
      code: number;
      line: number;
    }>;
    expect(diagnostics.some((d) => d.severity === "error" && d.code === 2322 && d.line === 3)).toBe(
      true,
    );

    // 2. Definition + hover resolves computeTotal call on line 2 col 22 -> math.ts line 1
    const def = await callTool(tools, "saint_lsp_definition", {
      relativePath: "main.ts",
      line: 2,
      character: 22,
    });
    expect(def.isError).toBe(false);
    const locations = def.payload.locations as Array<{ relativePath: string; line: number }>;
    expect(locations.some((loc) => loc.relativePath === "math.ts" && loc.line === 1)).toBe(true);
    expect(String(def.payload.hover)).toContain("computeTotal");

    // 3. References across workspace finds both math.ts and main.ts
    const refs = await callTool(tools, "saint_lsp_references", {
      relativePath: "math.ts",
      line: 1,
      character: 17,
    });
    expect(refs.isError).toBe(false);
    const refPaths = (refs.payload.locations as Array<{ relativePath: string }>).map(
      (loc) => loc.relativePath,
    );
    expect(refPaths).toContain("math.ts");
    expect(refPaths).toContain("main.ts");

    // 4. Document symbols
    const symbols = await callTool(tools, "saint_lsp_symbols", { relativePath: "math.ts" });
    expect(symbols.isError).toBe(false);
    const symbolNames = (symbols.payload.symbols as Array<{ name: string }>).map((s) => s.name);
    expect(symbolNames).toContain("computeTotal");

    // 5. Read-only rename preview returns edits across both files without writing disk
    const rename = await callTool(tools, "saint_lsp_refactor", {
      relativePath: "math.ts",
      operation: "rename",
      line: 1,
      character: 17,
      newName: "calculateTotal",
    });
    expect(rename.isError).toBe(false);
    const editFiles = (rename.payload.edits as Array<{ relativePath: string }>).map(
      (e) => e.relativePath,
    );
    expect(editFiles).toContain("math.ts");
    expect(editFiles).toContain("main.ts");
  });

  it("blocks path traversal and symlink escapes outside the workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "saint-editor-escape-ws-"));
    const outside = await mkdtemp(path.join(tmpdir(), "saint-editor-escape-out-"));
    cleanupDirs.push(workspace, outside);
    const secretFile = path.join(outside, "secret.ts");
    await writeFile(secretFile, "export const secret = 42;\n");
    await symlink(secretFile, path.join(workspace, "leak.ts"));

    const languageService = new EditorLanguageService();
    cleanupServices.push(languageService);
    const tools = makeAgentGatewayEditorTools({
      editorLanguage: languageService,
      resolveWorkspaceRoot: () => Effect.succeed(workspace),
    });

    const traversal = await callTool(tools, "saint_lsp_diagnostics", {
      relativePath: "../secret.ts",
    });
    expect(traversal.isError).toBe(true);

    const symEscape = await callTool(tools, "saint_lsp_diagnostics", {
      relativePath: "leak.ts",
    });
    expect(symEscape.isError).toBe(true);
  });
});

describe("makeAgentGatewayEditorTools (DAP Debugger)", () => {
  it("scopes debug sessions to the caller thread owner and routes start/control/inspect/poll", async () => {
    const start = vi.fn(async () => ({ sessionId: "dbg-session-1" }));
    const action = vi.fn(async (_owner, input) => {
      if (input.action === "evaluate") {
        return {
          evaluation: { name: input.expression, value: "42", variablesReference: 0 },
        };
      }
      return { threads: [{ id: 1, name: "Main" }] };
    });
    let pollCount = 0;
    const poll = vi.fn((owner: string, id: string, after: number) => {
      pollCount += 1;
      if (owner !== "agent-debug:thread-a") {
        throw new Error("The debug session is not available to this connection.");
      }
      return {
        sessionId: id,
        sequence: pollCount >= 2 ? 1 : 0,
        terminated: false,
        connections: [{ id: "root", name: "Node.js", ready: true }],
        events:
          pollCount >= 2 && after < 1
            ? [
                {
                  id: 1,
                  connectionId: "root",
                  event: "stopped" as const,
                  text: "breakpoint",
                  threadId: 1,
                },
              ]
            : [],
      };
    });
    const fakeDebug: EditorDebugShape = {
      start,
      action,
      poll,
      dispose: async () => undefined,
    };

    const tools = makeAgentGatewayEditorTools({
      editorDebug: fakeDebug,
      resolveWorkspaceRoot: () => Effect.succeed("/tmp/workspace"),
    });

    const ctxA = makeToolContext("thread-a");
    const ctxB = makeToolContext("thread-b");

    const started = await callTool(
      tools,
      "saint_debug_start",
      {
        request: "launch",
        program: "src/app.ts",
        stopOnEntry: true,
        breakpoints: [{ relativePath: "src/app.ts", line: 12 }],
      },
      ctxA,
    );
    expect(started.isError).toBe(false);
    expect(started.payload).toEqual({ sessionId: "dbg-session-1" });
    expect(start).toHaveBeenCalledWith("agent-debug:thread-a", {
      cwd: "/tmp/workspace",
      request: "launch",
      program: "src/app.ts",
      args: [],
      port: 0,
      stopOnEntry: true,
      breakpoints: [{ relativePath: "src/app.ts", line: 12 }],
    });

    // Polling with waitMs waits until the stopped event arrives on poll #2
    const polled = await callTool(
      tools,
      "saint_debug_poll",
      { sessionId: "dbg-session-1", after: 0, waitMs: 500 },
      ctxA,
    );
    expect(polled.isError).toBe(false);
    expect((polled.payload.events as Array<{ event: string }>)[0]?.event).toBe("stopped");

    // Cross-thread poll is isolated by owner ID
    const crossThread = await callTool(
      tools,
      "saint_debug_poll",
      { sessionId: "dbg-session-1", after: 0 },
      ctxB,
    );
    expect(crossThread.isError).toBe(true);

    // Evaluate expression in frame
    const evalResult = await callTool(
      tools,
      "saint_debug_inspect",
      {
        sessionId: "dbg-session-1",
        action: "evaluate",
        frameId: 3,
        expression: "x + y",
      },
      ctxA,
    );
    expect(evalResult.isError).toBe(false);
    expect(evalResult.payload).toEqual({
      evaluation: { name: "x + y", value: "42", variablesReference: 0 },
    });

    // Disconnect
    const stopped = await callTool(
      tools,
      "saint_debug_control",
      { sessionId: "dbg-session-1", action: "disconnect" },
      ctxA,
    );
    expect(stopped.isError).toBe(false);
  });
});
