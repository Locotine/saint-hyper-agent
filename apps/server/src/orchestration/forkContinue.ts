// FILE: forkContinue.ts
// Purpose: Fork & Continue — carries a thread's work into a clean session. The new session gets a
//          deterministic snapshot (goal, latest request, where it stood, changed files, handles)
//          plus an optional short summary written by the thread's own model, instead of the
//          whole transcript. A fork of a fork carries the earlier goal verbatim, so summaries
//          never summarize summaries.
// Layer: Server orchestration helper

import { LEDGER_HANDLE_PATTERN, type OrchestrationMessage } from "@saint/contracts";

export const FORK_CONTINUE_MARKER = "Saint Fork & Continue";
/** A provider that does not compact by itself is moved to a clean session at this fill level. */
export const FORK_CONTINUE_CONTEXT_THRESHOLD = 0.7;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const GOAL_LINE = /^Goal: (.*)$/m;
const HANDLE_IN_TEXT = new RegExp(LEDGER_HANDLE_PATTERN.source.slice(1, -1), "g");

export interface ForkSnapshotInput {
  readonly title: string;
  readonly reason: string;
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text">>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly summary?: string | null;
}

/** The first user message of a Fork & Continue thread is its snapshot; its goal carries over. */
export function carriedGoal(messages: ForkSnapshotInput["messages"]): string | null {
  const first = messages.find((message) => message.role === "user")?.text ?? "";
  if (!first.startsWith(FORK_CONTINUE_MARKER)) return null;
  return GOAL_LINE.exec(first)?.[1] ?? null;
}

/** The messages a summary may read: never an earlier snapshot. */
export function summarizableMessages(messages: ForkSnapshotInput["messages"]) {
  return messages.filter(
    (message) => !(message.role === "user" && message.text.startsWith(FORK_CONTINUE_MARKER)),
  );
}

export function buildForkSnapshot(input: ForkSnapshotInput): string {
  const own = summarizableMessages(input.messages);
  const users = own.filter((message) => message.role === "user");
  const lastAssistant = own.findLast((message) => message.role === "assistant");
  const goal =
    carriedGoal(input.messages) ?? clip((users[0]?.text ?? input.title).replace(/\s+/g, " "), 600);
  const latest = users.length > 1 ? users.at(-1)!.text : null;
  const handles = [
    ...new Set(input.messages.flatMap((message) => message.text.match(HANDLE_IN_TEXT) ?? [])),
  ].slice(0, 32);
  return [
    `${FORK_CONTINUE_MARKER}: a fresh session continuing "${input.title}" (${input.reason}). The earlier transcript is not loaded; this snapshot is what carried over. Check the working tree before relying on it.`,
    `Goal: ${goal}`,
    ...(latest ? [`Latest request:\n${clip(latest, 2_000)}`] : []),
    ...(lastAssistant
      ? [`Where it stood (last reply, trimmed):\n${clip(lastAssistant.text, 2_000)}`]
      : []),
    ...(input.summary ? [`Summary:\n${clip(input.summary, 2_400)}`] : []),
    `Changed files:\n${input.changedFiles.length > 0 ? input.changedFiles.slice(0, 80).join("\n") : "(none)"}`,
    ...(handles.length > 0 ? [`Saint handles (read with saint_get): ${handles.join(" ")}`] : []),
    "Continue the work from here.",
  ].join("\n\n");
}

/** Fraction of the context window a `context-window.updated` activity reports, if known. */
export function contextUsedFraction(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = payload as Record<string, unknown>;
  if (usage.compactsAutomatically === true) return null;
  if (typeof usage.usedPercent === "number") return usage.usedPercent / 100;
  return typeof usage.usedTokens === "number" &&
    typeof usage.maxTokens === "number" &&
    usage.maxTokens > 0
    ? usage.usedTokens / usage.maxTokens
    : null;
}

/** `git status --porcelain` lines → paths. */
export function parsePorcelainPaths(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim());
}
