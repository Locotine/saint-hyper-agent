// FILE: editorTools.ts
// Purpose: Exposes Saint's workspace-confined TypeScript Language Service (LSP)
//          and JavaScript/Node.js DAP Debugger as Agent Gateway MCP tools.
// Layer: Agent gateway tools

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  EditorDebugBreakpoint,
  EditorDiagnostic,
  EditorFileEdits,
  EditorLocation,
} from "@saint/contracts";
import { isPathInside } from "@saint/shared/pathContainment";
import { Effect } from "effect";

import type { EditorDebugShape } from "../editor/Services/EditorDebug.ts";
import type { EditorLanguageShape } from "../editor/Services/EditorLanguage.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readBooleanArg, readStringArg } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

const MAX_SOURCE_FILE_BYTES = 2_000_000;
const MAX_DEBUG_POLL_WAIT_MS = 5_000;
const DEBUG_POLL_STEP_MS = 100;

export interface EditorToolsInput {
  readonly editorLanguage?: EditorLanguageShape | undefined;
  readonly editorDebug?: EditorDebugShape | undefined;
  readonly resolveWorkspaceRoot: (context: ToolContext) => Effect.Effect<string | null>;
}

const toToolError = (error: unknown) =>
  error instanceof ToolInputError ? error : new ToolInputError(errorText(error));

const readArgs = <A>(read: () => A): Effect.Effect<A, ToolInputError> =>
  Effect.try({ try: read, catch: toToolError });

const asToolResult = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.map(mcpToolResultJson),
    Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
  );

function readIntArg(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: boolean; readonly min?: number; readonly max?: number },
): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (options?.required) {
      throw new ToolInputError(`Missing required argument "${name}".`);
    }
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolInputError(`Argument "${name}" must be an integer.`);
  }
  if (options?.min !== undefined && value < options.min) {
    throw new ToolInputError(`Argument "${name}" must be >= ${options.min}.`);
  }
  if (options?.max !== undefined && value > options.max) {
    throw new ToolInputError(`Argument "${name}" must be <= ${options.max}.`);
  }
  return value;
}

function readStringArrayArg(
  args: Record<string, unknown>,
  name: string,
  maxItems = 64,
): ReadonlyArray<string> {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ToolInputError(`Argument "${name}" must be an array of at most ${maxItems} strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new ToolInputError(`Argument "${name}[${index}]" must be a string.`);
    }
    return item;
  });
}

function normalizeRelativeWorkspacePath(raw: string): string {
  const trimmed = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    trimmed.length === 0 ||
    path.isAbsolute(trimmed) ||
    trimmed.includes("\0") ||
    trimmed.split("/").some((part) => part === ".." || part === ".git")
  ) {
    throw new ToolInputError(`Expected a workspace-relative file path, received "${raw}".`);
  }
  return trimmed;
}

function parseBreakpointsArg(
  args: Record<string, unknown>,
  defaultRelativePath?: string,
): ReadonlyArray<EditorDebugBreakpoint> {
  const raw = args.breakpoints;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 1_000) {
    throw new ToolInputError('Argument "breakpoints" must be an array of at most 1000 items.');
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolInputError(`Argument "breakpoints[${index}]" must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const rawPath =
      typeof record.relativePath === "string" ? record.relativePath : defaultRelativePath;
    if (!rawPath) {
      throw new ToolInputError(`Argument "breakpoints[${index}].relativePath" is required.`);
    }
    const relativePath = normalizeRelativeWorkspacePath(rawPath);
    const line = record.line;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      throw new ToolInputError(`Argument "breakpoints[${index}].line" must be an integer >= 1.`);
    }
    const condition =
      typeof record.condition === "string" && record.condition.length > 0
        ? record.condition
        : undefined;
    const hitCondition =
      typeof record.hitCondition === "string" && record.hitCondition.length > 0
        ? record.hitCondition
        : undefined;
    const logMessage =
      typeof record.logMessage === "string" && record.logMessage.length > 0
        ? record.logMessage
        : undefined;
    return {
      relativePath,
      line,
      ...(condition !== undefined ? { condition } : {}),
      ...(hitCondition !== undefined ? { hitCondition } : {}),
      ...(logMessage !== undefined ? { logMessage } : {}),
    };
  });
}

/** Convert 1-based `(line, character)` coordinates to a UTF-16 code-unit offset. */
export function lineCharacterToUtf16Offset(
  contents: string,
  line: number,
  character: number,
): number {
  const targetLine = Math.max(1, line);
  const targetColumn = Math.max(1, character);
  let currentLine = 1;
  let index = 0;
  while (currentLine < targetLine && index < contents.length) {
    const newline = contents.indexOf("\n", index);
    if (newline < 0) {
      return contents.length;
    }
    index = newline + 1;
    currentLine += 1;
  }
  const lineEnd = contents.indexOf("\n", index);
  const effectiveEnd =
    lineEnd < 0
      ? contents.length
      : lineEnd > index && contents[lineEnd - 1] === "\r"
        ? lineEnd - 1
        : lineEnd;
  return Math.min(effectiveEnd, index + (targetColumn - 1));
}

/** Convert a UTF-16 code-unit offset to 1-based `{ line, character }`. */
export function utf16OffsetToLineCharacter(
  contents: string,
  offset: number,
): { readonly line: number; readonly character: number } {
  const clamped = Math.max(0, Math.min(offset, contents.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (contents.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, character: clamped - lineStart + 1 };
}

async function readWorkspaceFileContents(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  const canonicalRoot = await realpath(workspaceRoot);
  const candidate = path.resolve(canonicalRoot, relativePath);
  const realFile = await realpath(candidate);
  if (!isPathInside(canonicalRoot, realFile)) {
    throw new ToolInputError(`Path "${relativePath}" escapes the thread workspace.`);
  }
  const contents = await readFile(realFile, "utf8");
  if (contents.length > MAX_SOURCE_FILE_BYTES) {
    throw new ToolInputError(
      `File "${relativePath}" exceeds the ${MAX_SOURCE_FILE_BYTES}-character language service limit.`,
    );
  }
  return contents;
}

function formatLocationForAgent(location: EditorLocation) {
  return {
    relativePath: location.relativePath,
    line: location.line + 1,
    character: location.character + 1,
    endLine: location.endLine + 1,
    endCharacter: location.endCharacter + 1,
    startOffset: location.start,
    length: location.length,
  };
}

function formatDiagnosticForAgent(diagnostic: EditorDiagnostic, contents: string) {
  const start = utf16OffsetToLineCharacter(contents, diagnostic.start);
  const end = utf16OffsetToLineCharacter(contents, diagnostic.start + diagnostic.length);
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    line: start.line,
    character: start.character,
    endLine: end.line,
    endCharacter: end.character,
    unnecessary: diagnostic.unnecessary,
    deprecated: diagnostic.deprecated,
  };
}

function formatFileEditsForAgent(fileEdits: ReadonlyArray<EditorFileEdits>) {
  return fileEdits.map((entry) => ({
    relativePath: entry.relativePath,
    edits: entry.edits.map((edit) => {
      const start = utf16OffsetToLineCharacter(entry.expectedContents, edit.start);
      const end = utf16OffsetToLineCharacter(entry.expectedContents, edit.start + edit.length);
      return {
        line: start.line,
        character: start.character,
        endLine: end.line,
        endCharacter: end.character,
        startOffset: edit.start,
        length: edit.length,
        newText: edit.newText,
      };
    }),
  }));
}

export function makeAgentGatewayEditorTools(input: EditorToolsInput): ReadonlyArray<ToolEntry> {
  const { editorLanguage, editorDebug, resolveWorkspaceRoot } = input;
  const tools: ToolEntry[] = [];

  const requireWorkspaceCwd = (context: ToolContext) =>
    resolveWorkspaceRoot(context).pipe(
      Effect.flatMap((cwd) =>
        cwd
          ? Effect.succeed(cwd)
          : Effect.fail(new ToolInputError("This thread has no resolved project workspace.")),
      ),
    );

  const lspClientId = (context: ToolContext) => `agent-lsp:${context.callerThreadId}`;
  const debugOwnerId = (context: ToolContext) => `agent-debug:${context.callerThreadId}`;

  if (editorLanguage) {
    const lspDiagnostics: ToolEntry = {
      requiredCapability: "thread:read",
      definition: {
        name: "saint_lsp_diagnostics",
        description:
          "Run Saint's warm TypeScript/JavaScript language service on a workspace-relative file and return compiler-exact diagnostics (errors, warnings, unused, deprecated) with 1-based line and character positions. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            relativePath: {
              type: "string",
              description: "Workspace-relative path to a .ts/.tsx/.js/.jsx/.mts/.cts file.",
            },
          },
          required: ["relativePath"],
          additionalProperties: false,
        },
        annotations: { title: "LSP diagnostics", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const relativePath = yield* readArgs(() =>
              normalizeRelativeWorkspacePath(
                readStringArg(args, "relativePath", { required: true })!,
              ),
            );
            const cwd = yield* requireWorkspaceCwd(context);
            const contents = yield* Effect.tryPromise({
              try: () => readWorkspaceFileContents(cwd, relativePath),
              catch: toToolError,
            });
            const result = yield* Effect.tryPromise({
              try: () =>
                editorLanguage.request(lspClientId(context), {
                  cwd,
                  relativePath,
                  documents: [{ relativePath, contents, version: 1 }],
                  operation: "diagnostics",
                  offset: 0,
                  length: 0,
                }),
              catch: toToolError,
            });
            const diagnostics = (result.diagnostics ?? []).map((diag) =>
              formatDiagnosticForAgent(diag, contents),
            );
            return {
              relativePath,
              count: diagnostics.length,
              diagnostics,
            };
          }),
        ),
    };

    const lspDefinition: ToolEntry = {
      requiredCapability: "thread:read",
      definition: {
        name: "saint_lsp_definition",
        description:
          "Query Saint's TypeScript/JavaScript language service at a 1-based (line, character) position for go-to-definition, type definition, hover type/JSDoc, or call signature. When kind is omitted, returns both definition locations and hover info.",
        inputSchema: {
          type: "object",
          properties: {
            relativePath: {
              type: "string",
              description: "Workspace-relative file path.",
            },
            line: { type: "integer", minimum: 1, description: "1-based line number." },
            character: {
              type: "integer",
              minimum: 1,
              description: "1-based character column on the line.",
            },
            kind: {
              type: "string",
              enum: ["definition", "typeDefinition", "hover", "signature"],
              description: "Specific lookup kind; omit to return both definition and hover.",
            },
          },
          required: ["relativePath", "line", "character"],
          additionalProperties: false,
        },
        annotations: { title: "LSP definition & hover", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const parsed = yield* readArgs(() => {
              const relativePath = normalizeRelativeWorkspacePath(
                readStringArg(args, "relativePath", { required: true })!,
              );
              const line = readIntArg(args, "line", { required: true, min: 1 })!;
              const character = readIntArg(args, "character", { required: true, min: 1 })!;
              const kind = readStringArg(args, "kind") as
                | "definition"
                | "typeDefinition"
                | "hover"
                | "signature"
                | undefined;
              if (
                kind !== undefined &&
                kind !== "definition" &&
                kind !== "typeDefinition" &&
                kind !== "hover" &&
                kind !== "signature"
              ) {
                throw new ToolInputError(
                  'Argument "kind" must be one of "definition", "typeDefinition", "hover", "signature".',
                );
              }
              return { relativePath, line, character, kind };
            });
            const cwd = yield* requireWorkspaceCwd(context);
            const contents = yield* Effect.tryPromise({
              try: () => readWorkspaceFileContents(cwd, parsed.relativePath),
              catch: toToolError,
            });
            const offset = lineCharacterToUtf16Offset(contents, parsed.line, parsed.character);
            const clientId = lspClientId(context);
            const runOp = (operation: "definition" | "typeDefinition" | "hover" | "signature") =>
              Effect.tryPromise({
                try: () =>
                  editorLanguage.request(clientId, {
                    cwd,
                    relativePath: parsed.relativePath,
                    documents: [{ relativePath: parsed.relativePath, contents, version: 1 }],
                    operation,
                    offset,
                    length: 0,
                  }),
                catch: toToolError,
              });

            if (parsed.kind === "signature") {
              const res = yield* runOp("signature");
              return {
                relativePath: parsed.relativePath,
                line: parsed.line,
                character: parsed.character,
                signatures: res.signatures ?? [],
                ...(res.activeSignature !== undefined
                  ? { activeSignature: res.activeSignature }
                  : {}),
                ...(res.activeParameter !== undefined
                  ? { activeParameter: res.activeParameter }
                  : {}),
              };
            }
            if (parsed.kind === "hover") {
              const res = yield* runOp("hover");
              return {
                relativePath: parsed.relativePath,
                line: parsed.line,
                character: parsed.character,
                hover: res.text ?? null,
              };
            }
            if (parsed.kind === "definition" || parsed.kind === "typeDefinition") {
              const res = yield* runOp(parsed.kind);
              return {
                relativePath: parsed.relativePath,
                line: parsed.line,
                character: parsed.character,
                kind: parsed.kind,
                locations: (res.locations ?? []).map(formatLocationForAgent),
              };
            }

            const [defResult, hoverResult] = yield* Effect.all([
              runOp("definition"),
              runOp("hover"),
            ]);
            return {
              relativePath: parsed.relativePath,
              line: parsed.line,
              character: parsed.character,
              locations: (defResult.locations ?? []).map(formatLocationForAgent),
              hover: hoverResult.text ?? null,
            };
          }),
        ),
    };

    const lspReferences: ToolEntry = {
      requiredCapability: "thread:read",
      definition: {
        name: "saint_lsp_references",
        description:
          "Find all compiler-resolved references across the workspace to the symbol at a 1-based (line, character) position. More exact than text grep because it follows TypeScript bindings and imports.",
        inputSchema: {
          type: "object",
          properties: {
            relativePath: { type: "string", description: "Workspace-relative file path." },
            line: { type: "integer", minimum: 1, description: "1-based line number." },
            character: {
              type: "integer",
              minimum: 1,
              description: "1-based character column on the line.",
            },
          },
          required: ["relativePath", "line", "character"],
          additionalProperties: false,
        },
        annotations: { title: "LSP references", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const parsed = yield* readArgs(() => ({
              relativePath: normalizeRelativeWorkspacePath(
                readStringArg(args, "relativePath", { required: true })!,
              ),
              line: readIntArg(args, "line", { required: true, min: 1 })!,
              character: readIntArg(args, "character", { required: true, min: 1 })!,
            }));
            const cwd = yield* requireWorkspaceCwd(context);
            const contents = yield* Effect.tryPromise({
              try: () => readWorkspaceFileContents(cwd, parsed.relativePath),
              catch: toToolError,
            });
            const offset = lineCharacterToUtf16Offset(contents, parsed.line, parsed.character);
            const result = yield* Effect.tryPromise({
              try: () =>
                editorLanguage.request(lspClientId(context), {
                  cwd,
                  relativePath: parsed.relativePath,
                  documents: [{ relativePath: parsed.relativePath, contents, version: 1 }],
                  operation: "references",
                  offset,
                  length: 0,
                }),
              catch: toToolError,
            });
            const locations = (result.locations ?? []).map(formatLocationForAgent);
            return {
              relativePath: parsed.relativePath,
              line: parsed.line,
              character: parsed.character,
              count: locations.length,
              locations,
            };
          }),
        ),
    };

    const lspSymbols: ToolEntry = {
      requiredCapability: "thread:read",
      definition: {
        name: "saint_lsp_symbols",
        description:
          "List symbols in a file (documentSymbols when query is omitted) or search symbols across the TypeScript/JavaScript workspace (workspaceSymbols when query is provided). Pass relativePath to anchor the tsconfig project.",
        inputSchema: {
          type: "object",
          properties: {
            relativePath: {
              type: "string",
              description:
                "Workspace-relative file path (required for documentSymbols; also anchors tsconfig for workspaceSymbols).",
            },
            query: {
              type: "string",
              maxLength: 1_024,
              description:
                "Optional workspace symbol search query. When provided, searches across the workspace project.",
            },
          },
          required: ["relativePath"],
          additionalProperties: false,
        },
        annotations: { title: "LSP symbols", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const parsed = yield* readArgs(() => ({
              relativePath: normalizeRelativeWorkspacePath(
                readStringArg(args, "relativePath", { required: true })!,
              ),
              query: readStringArg(args, "query"),
            }));
            const cwd = yield* requireWorkspaceCwd(context);
            // Validate containment and provide the current snapshot before forwarding to the worker.
            const contents = yield* Effect.tryPromise({
              try: () => readWorkspaceFileContents(cwd, parsed.relativePath),
              catch: toToolError,
            });
            const operation = parsed.query !== undefined ? "workspaceSymbols" : "documentSymbols";
            const result = yield* Effect.tryPromise({
              try: () =>
                editorLanguage.request(lspClientId(context), {
                  cwd,
                  relativePath: parsed.relativePath,
                  documents: [{ relativePath: parsed.relativePath, contents, version: 1 }],
                  operation,
                  offset: 0,
                  length: 0,
                  ...(parsed.query !== undefined ? { query: parsed.query } : {}),
                }),
              catch: toToolError,
            });
            const symbols = (result.symbols ?? []).map((symbol) => ({
              name: symbol.name,
              kind: symbol.kind,
              containerName: symbol.containerName,
              location: formatLocationForAgent(symbol.location),
              ...(symbol.extent ? { extent: formatLocationForAgent(symbol.extent) } : {}),
            }));
            return {
              operation,
              relativePath: parsed.relativePath,
              ...(parsed.query !== undefined ? { query: parsed.query } : {}),
              count: symbols.length,
              symbols,
            };
          }),
        ),
    };

    const lspRefactor: ToolEntry = {
      requiredCapability: "thread:read",
      definition: {
        name: "saint_lsp_refactor",
        description:
          "Compute compiler-exact TypeScript/JavaScript refactoring edits without writing to disk: rename a symbol across files, list quick-fix code actions at a range, or organize imports. Apply returned edits with your file edit tool.",
        inputSchema: {
          type: "object",
          properties: {
            relativePath: { type: "string", description: "Workspace-relative file path." },
            operation: {
              type: "string",
              enum: ["rename", "codeActions", "organizeImports"],
              description: "Refactoring computation to perform.",
            },
            line: {
              type: "integer",
              minimum: 1,
              description: "1-based start line (required for rename and codeActions).",
            },
            character: {
              type: "integer",
              minimum: 1,
              description: "1-based start character column (required for rename and codeActions).",
            },
            endLine: {
              type: "integer",
              minimum: 1,
              description: "Optional 1-based end line for codeActions range.",
            },
            endCharacter: {
              type: "integer",
              minimum: 1,
              description: "Optional 1-based end character for codeActions range.",
            },
            newName: {
              type: "string",
              maxLength: 256,
              description: "New identifier name (required when operation is rename).",
            },
          },
          required: ["relativePath", "operation"],
          additionalProperties: false,
        },
        annotations: { title: "LSP refactor preview", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const parsed = yield* readArgs(() => {
              const relativePath = normalizeRelativeWorkspacePath(
                readStringArg(args, "relativePath", { required: true })!,
              );
              const operation = readStringArg(args, "operation", { required: true })!;
              if (
                operation !== "rename" &&
                operation !== "codeActions" &&
                operation !== "organizeImports"
              ) {
                throw new ToolInputError(
                  'Argument "operation" must be "rename", "codeActions", or "organizeImports".',
                );
              }
              const typedOperation: "rename" | "codeActions" | "organizeImports" = operation;
              const line = readIntArg(args, "line", {
                required: typedOperation !== "organizeImports",
                min: 1,
              });
              const character = readIntArg(args, "character", {
                required: typedOperation !== "organizeImports",
                min: 1,
              });
              const endLine = readIntArg(args, "endLine", { min: 1 });
              const endCharacter = readIntArg(args, "endCharacter", { min: 1 });
              const newName = readStringArg(args, "newName", {
                required: typedOperation === "rename",
              });
              return {
                relativePath,
                operation: typedOperation,
                line,
                character,
                endLine,
                endCharacter,
                newName,
              };
            });
            const cwd = yield* requireWorkspaceCwd(context);
            const contents = yield* Effect.tryPromise({
              try: () => readWorkspaceFileContents(cwd, parsed.relativePath),
              catch: toToolError,
            });
            const offset =
              parsed.line !== undefined && parsed.character !== undefined
                ? lineCharacterToUtf16Offset(contents, parsed.line, parsed.character)
                : 0;
            const endOffset =
              parsed.endLine !== undefined && parsed.endCharacter !== undefined
                ? lineCharacterToUtf16Offset(contents, parsed.endLine, parsed.endCharacter)
                : offset;
            const length = Math.max(0, endOffset - offset);
            const result = yield* Effect.tryPromise({
              try: () =>
                editorLanguage.request(lspClientId(context), {
                  cwd,
                  relativePath: parsed.relativePath,
                  documents: [{ relativePath: parsed.relativePath, contents, version: 1 }],
                  operation: parsed.operation,
                  offset,
                  length,
                  ...(parsed.newName !== undefined ? { newName: parsed.newName } : {}),
                }),
              catch: toToolError,
            });
            if (parsed.operation === "codeActions") {
              return {
                operation: parsed.operation,
                relativePath: parsed.relativePath,
                actions: (result.actions ?? []).map((action) => ({
                  title: action.title,
                  kind: action.kind,
                  edits: formatFileEditsForAgent(action.edits),
                })),
              };
            }
            return {
              operation: parsed.operation,
              relativePath: parsed.relativePath,
              edits: formatFileEditsForAgent(result.edits ?? []),
            };
          }),
        ),
    };

    tools.push(lspDiagnostics, lspDefinition, lspReferences, lspSymbols, lspRefactor);
  }

  if (editorDebug) {
    const debugStart: ToolEntry = {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "saint_debug_start",
        description:
          "Start a live JavaScript/TypeScript DAP debug session in this thread's workspace via js-debug (launch a workspace .js/.mjs/.cjs/.ts/.mts/.cts entry point, or attach to a loopback 127.0.0.1 Node inspector port). Owned exclusively by this thread; stop it with saint_debug_control action='disconnect'.",
        inputSchema: {
          type: "object",
          properties: {
            request: {
              type: "string",
              enum: ["launch", "attach"],
              description:
                "Whether to launch a script or attach to a loopback Node inspector port.",
            },
            program: {
              type: "string",
              description:
                "Workspace-relative JS/TS entry file (required for launch; optional label for attach).",
            },
            args: {
              type: "array",
              items: { type: "string" },
              maxItems: 64,
              description: "CLI arguments passed to the launched script.",
            },
            port: {
              type: "integer",
              minimum: 0,
              maximum: 65_535,
              description: "Loopback 127.0.0.1 inspector port (required when request is attach).",
            },
            stopOnEntry: {
              type: "boolean",
              description: "Pause on the first executable line after launch.",
            },
            breakpoints: {
              type: "array",
              maxItems: 1_000,
              description: "Initial line breakpoints.",
              items: {
                type: "object",
                properties: {
                  relativePath: { type: "string" },
                  line: { type: "integer", minimum: 1 },
                  condition: { type: "string" },
                  hitCondition: { type: "string" },
                  logMessage: { type: "string" },
                },
                required: ["relativePath", "line"],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        annotations: { title: "Start DAP debugger", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const parsed = yield* readArgs(() => {
              const request = (readStringArg(args, "request") ?? "launch") as "launch" | "attach";
              if (request !== "launch" && request !== "attach") {
                throw new ToolInputError('Argument "request" must be "launch" or "attach".');
              }
              const rawProgram = readStringArg(args, "program", {
                required: request === "launch",
              });
              const program =
                request === "launch"
                  ? normalizeRelativeWorkspacePath(rawProgram!)
                  : (rawProgram ?? "attach");
              const port = readIntArg(args, "port", {
                required: request === "attach",
                min: request === "attach" ? 1 : 0,
                max: 65_535,
              });
              const stopOnEntry = readBooleanArg(args, "stopOnEntry") ?? false;
              const cliArgs = readStringArrayArg(args, "args");
              const breakpoints = parseBreakpointsArg(args);
              return {
                request,
                program,
                args: [...cliArgs],
                port: port ?? 0,
                stopOnEntry,
                breakpoints: [...breakpoints],
              };
            });
            const cwd = yield* requireWorkspaceCwd(context);
            return yield* Effect.tryPromise({
              try: () =>
                editorDebug.start(debugOwnerId(context), {
                  cwd,
                  ...parsed,
                }),
              catch: toToolError,
            });
          }),
        ),
    };

    const debugControl: ToolEntry = {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "saint_debug_control",
        description:
          "Control execution or breakpoints of a live DAP debug session owned by this thread: continue, pause, next (step over), stepIn, stepOut, setBreakpoints, or disconnect.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Session ID returned by saint_debug_start." },
            action: {
              type: "string",
              enum: [
                "continue",
                "pause",
                "next",
                "stepIn",
                "stepOut",
                "setBreakpoints",
                "disconnect",
              ],
            },
            connectionId: { type: "string", description: "Optional child target connection ID." },
            threadId: {
              type: "integer",
              minimum: 0,
              description: "DAP thread ID (required for continue/pause/next/stepIn/stepOut).",
            },
            relativePath: {
              type: "string",
              description: "Workspace-relative source file (required for setBreakpoints).",
            },
            breakpoints: {
              type: "array",
              maxItems: 1_000,
              description: "Replacement breakpoints for relativePath (used with setBreakpoints).",
              items: {
                type: "object",
                properties: {
                  relativePath: { type: "string" },
                  line: { type: "integer", minimum: 1 },
                  condition: { type: "string" },
                  hitCondition: { type: "string" },
                  logMessage: { type: "string" },
                },
                required: ["line"],
                additionalProperties: false,
              },
            },
          },
          required: ["sessionId", "action"],
          additionalProperties: false,
        },
        annotations: { title: "Control DAP debugger", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const parsed = yield* readArgs(() => {
              const sessionId = readStringArg(args, "sessionId", { required: true })!;
              const action = readStringArg(args, "action", { required: true })!;
              const allowed = new Set([
                "continue",
                "pause",
                "next",
                "stepIn",
                "stepOut",
                "setBreakpoints",
                "disconnect",
              ]);
              if (!allowed.has(action)) {
                throw new ToolInputError(`Unsupported debug control action "${action}".`);
              }
              const connectionId = readStringArg(args, "connectionId");
              const threadId = readIntArg(args, "threadId", { min: 0 });
              const rawRelativePath = readStringArg(args, "relativePath", {
                required: action === "setBreakpoints",
              });
              const relativePath = rawRelativePath
                ? normalizeRelativeWorkspacePath(rawRelativePath)
                : undefined;
              const breakpoints =
                action === "setBreakpoints"
                  ? [...parseBreakpointsArg(args, relativePath)]
                  : undefined;
              return {
                sessionId,
                action: action as
                  | "continue"
                  | "pause"
                  | "next"
                  | "stepIn"
                  | "stepOut"
                  | "setBreakpoints"
                  | "disconnect",
                ...(connectionId !== undefined ? { connectionId } : {}),
                ...(threadId !== undefined ? { threadId } : {}),
                ...(relativePath !== undefined ? { relativePath } : {}),
                ...(breakpoints !== undefined ? { breakpoints } : {}),
              };
            });
            return yield* Effect.tryPromise({
              try: () => editorDebug.action(debugOwnerId(context), parsed),
              catch: toToolError,
            });
          }),
        ),
    };

    const debugInspect: ToolEntry = {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "saint_debug_inspect",
        description:
          "Inspect live runtime state of a paused DAP debug session owned by this thread: list threads, read stackTrace, read scopes, expand variables, or evaluate an expression in a frame.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Session ID returned by saint_debug_start." },
            action: {
              type: "string",
              enum: ["threads", "stackTrace", "scopes", "variables", "evaluate"],
            },
            connectionId: { type: "string" },
            threadId: {
              type: "integer",
              minimum: 0,
              description: "DAP thread ID (required for stackTrace).",
            },
            frameId: {
              type: "integer",
              minimum: 0,
              description: "Stack frame ID (required for scopes; optional for evaluate).",
            },
            variablesReference: {
              type: "integer",
              minimum: 0,
              description: "Variables handle from scopes/variables (required for variables).",
            },
            expression: {
              type: "string",
              maxLength: 16_384,
              description: "JS expression to evaluate (required for evaluate).",
            },
            context: {
              type: "string",
              enum: ["watch", "repl", "hover"],
              description: "Evaluation context (default: repl).",
            },
          },
          required: ["sessionId", "action"],
          additionalProperties: false,
        },
        annotations: { title: "Inspect DAP debugger", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const parsed = yield* readArgs(() => {
              const sessionId = readStringArg(args, "sessionId", { required: true })!;
              const action = readStringArg(args, "action", { required: true })!;
              const allowed = new Set(["threads", "stackTrace", "scopes", "variables", "evaluate"]);
              if (!allowed.has(action)) {
                throw new ToolInputError(`Unsupported debug inspect action "${action}".`);
              }
              const connectionId = readStringArg(args, "connectionId");
              const threadId = readIntArg(args, "threadId", { min: 0 });
              const frameId = readIntArg(args, "frameId", { min: 0 });
              const variablesReference = readIntArg(args, "variablesReference", { min: 0 });
              const expression = readStringArg(args, "expression", {
                required: action === "evaluate",
              });
              const evalContext = readStringArg(args, "context") as
                | "watch"
                | "repl"
                | "hover"
                | undefined;
              if (
                evalContext !== undefined &&
                evalContext !== "watch" &&
                evalContext !== "repl" &&
                evalContext !== "hover"
              ) {
                throw new ToolInputError('Argument "context" must be "watch", "repl", or "hover".');
              }
              return {
                sessionId,
                action: action as "threads" | "stackTrace" | "scopes" | "variables" | "evaluate",
                ...(connectionId !== undefined ? { connectionId } : {}),
                ...(threadId !== undefined ? { threadId } : {}),
                ...(frameId !== undefined ? { frameId } : {}),
                ...(variablesReference !== undefined ? { variablesReference } : {}),
                ...(expression !== undefined ? { expression } : {}),
                ...(evalContext !== undefined ? { context: evalContext } : {}),
              };
            });
            return yield* Effect.tryPromise({
              try: () => editorDebug.action(debugOwnerId(context), parsed),
              catch: toToolError,
            });
          }),
        ),
    };

    const debugPoll: ToolEntry = {
      requiredCapability: "thread:read",
      definition: {
        name: "saint_debug_poll",
        description:
          "Poll buffered events (stopped, output, breakpoint, exited, terminated, error) and active connections from a DAP debug session owned by this thread. Pass waitMs (up to 5000) to wait for the next event or breakpoint hit.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Session ID returned by saint_debug_start." },
            after: {
              type: "integer",
              minimum: 0,
              description: "Return events with id > after (default: 0).",
            },
            waitMs: {
              type: "integer",
              minimum: 0,
              maximum: MAX_DEBUG_POLL_WAIT_MS,
              description:
                "Optional max milliseconds (0-5000) to wait for new events or termination before returning.",
            },
          },
          required: ["sessionId"],
          additionalProperties: false,
        },
        annotations: { title: "Poll DAP debugger events", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        asToolResult(
          Effect.gen(function* () {
            const parsed = yield* readArgs(() => ({
              sessionId: readStringArg(args, "sessionId", { required: true })!,
              after: readIntArg(args, "after", { min: 0 }) ?? 0,
              waitMs: readIntArg(args, "waitMs", { min: 0, max: MAX_DEBUG_POLL_WAIT_MS }) ?? 0,
            }));
            const owner = debugOwnerId(context);
            const deadline = Date.now() + parsed.waitMs;
            while (true) {
              const snapshot = yield* Effect.try({
                try: () => editorDebug.poll(owner, parsed.sessionId, parsed.after),
                catch: toToolError,
              });
              if (snapshot.events.length > 0 || snapshot.terminated || Date.now() >= deadline) {
                return snapshot;
              }
              yield* Effect.sleep(DEBUG_POLL_STEP_MS);
            }
          }),
        ),
    };

    tools.push(debugStart, debugControl, debugInspect, debugPoll);
  }

  return tools;
}
