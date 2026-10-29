import { ProjectId, ThreadId } from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { describe, expect, it } from "vitest";

import { collectHostSearchThreads } from "./hostSearchThreads";

const hostId = sshHostId("0123abcd");
const projectId = ProjectId.makeUnsafe("p1");

function summary(id: string, extra: Record<string, unknown> = {}) {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    createdAt: "2026-10-29T00:00:00.000Z",
    ...extra,
  };
}

describe("collectHostSearchThreads", () => {
  it("lists a host's open top-level threads under its route id and host name", () => {
    const rows = collectHostSearchThreads([
      {
        hostId,
        host: "devbox",
        state: {
          projects: [{ id: projectId, name: "api" }],
          sidebarThreadSummaryById: {
            t1: summary("t1"),
            t2: summary("t2", { archivedAt: "2026-10-29T01:00:00.000Z" }),
            child: summary("child", { parentThreadId: "t1" }),
          },
        } as never,
      },
    ]);
    expect(rows.map((row) => [row.id, row.projectName])).toEqual([
      [`${hostId}~t1`, "api · devbox"],
    ]);
  });
});
