// FILE: exportThreadArchive.ts
// Purpose: Build a ZIP archive that exports a single Saint thread so a user
//          can download the conversation as a portable, compressed package —
//          mirroring the `/export` affordance of agent CLIs.
// Layer: Orchestration utility (plain async module; HTTP composes it through
//          Stream.fromAsyncIterable). The ZIP itself streams through
//          `zipArchiveChunks` (../zipArchive.ts); entries are produced as
//          per-message chunks, so no full entry string is materialized.
// Exports: threadArchiveChunks, threadArchiveFileName.
// The export-eligibility guard lives in @saint/shared/threadExport so the
// web composer and the HTTP route share one predicate.

import type { OrchestrationMessage, OrchestrationThread } from "@saint/contracts";

import { type ZipArchiveEntry, zipArchiveChunks } from "../zipArchive.ts";

const MESSAGE_ROLE_HEADING: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

// One chunk for the header, then one chunk per message; nothing accumulates.
function* transcriptMarkdownChunks(thread: OrchestrationThread): Generator<string> {
  yield `# ${thread.title}\n\n> Exported from Saint.\n`;
  for (const message of thread.messages) {
    const heading = MESSAGE_ROLE_HEADING[message.role] ?? "Message";
    yield `\n## ${heading} \`${message.createdAt}\`\n\n${message.text}\n`;
  }
}

function exportMessageProjection(message: OrchestrationMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    source: message.source,
    // Attachment/skill/mention references are part of the user's input for a
    // turn; keep them in the structured export (metadata only — the archive
    // does not bundle the referenced files).
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.skills?.length ? { skills: message.skills } : {}),
    ...(message.mentions?.length ? { mentions: message.mentions } : {}),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

// Emits the thread metadata object once, then appends the messages array one
// serialized message at a time so the full JSON document never exists as a
// single string.
function* threadJsonChunks(thread: OrchestrationThread): Generator<string> {
  const metadata = JSON.stringify(
    {
      threadId: thread.id,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    },
    null,
    2,
  );
  // Drop the closing "\n}" so the messages array can be appended incrementally.
  yield `${metadata.slice(0, -2)},\n  "messages": [`;

  let first = true;
  for (const message of thread.messages) {
    const messageJson = JSON.stringify(exportMessageProjection(message), null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    yield `${first ? "" : ","}\n${messageJson}`;
    first = false;
  }

  yield "\n  ]\n}";
}

function threadArchiveEntries(thread: OrchestrationThread): ZipArchiveEntry[] {
  return [
    { name: "thread.json", chunks: threadJsonChunks(thread) },
    { name: "transcript.md", chunks: transcriptMarkdownChunks(thread) },
  ];
}

export function threadArchiveChunks(thread: OrchestrationThread): AsyncGenerator<Buffer> {
  return zipArchiveChunks(threadArchiveEntries(thread));
}

const FILENAME_SAFE_REPLACE = /[^a-z0-9-]+/g;

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(FILENAME_SAFE_REPLACE, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 48) : "thread";
}

// Stable date bucket derived from the ISO timestamp keeps filenames sortable
// without pulling in a date library for formatting.
export function threadArchiveFileName(input: {
  readonly title: string;
  readonly isoTimestamp: string;
}): string {
  const dateBucket = input.isoTimestamp.slice(0, 10).replaceAll("-", "");
  return `saint-thread-${slugifyTitle(input.title)}-${dateBucket}.zip`;
}
