import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeOffice3dRequestHandler,
  OFFICE_3D_ROUTE_PREFIX,
  resolveOffice3dServerEntry,
} from "./office3dHttpHandler";

const requireCjs = createRequire(import.meta.url);

describe("office3dHttpHandler", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips Antigravity envelope tags from user input", () => {
    const mod = requireCjs(resolveOffice3dServerEntry()) as {
      stripAntigravityEnvelope: (raw: string) => string;
    };
    const raw =
      "<CONTEXT_SUMMARY>old</CONTEXT_SUMMARY>\n<USER_REQUEST>\nTích hợp văn phòng 3D vào Saint\n</USER_REQUEST>\n<ADDITIONAL_METADATA>now</ADDITIONAL_METADATA>";
    expect(mod.stripAntigravityEnvelope(raw)).toBe("Tích hợp văn phòng 3D vào Saint");
  });

  it("serves the 3D office index, state, and discovers Antigravity sessions", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saint-office3d-test-"));
    tempDirs.push(tempRoot);

    const stateDir = path.join(tempRoot, "state");
    const homeDir = path.join(tempRoot, "home");
    const convId = "641ce293-1b2f-4959-a505-547da06a8ff1";
    const logsDir = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      convId,
      ".system_generated",
      "logs",
    );
    fs.mkdirSync(logsDir, { recursive: true });

    const transcriptPath = path.join(logsDir, "transcript_full.jsonl");
    const nowIso = new Date().toISOString();
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          created_at: nowIso,
          content: "<USER_REQUEST>\nKiểm tra khu Antigravity 3D\n</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: nowIso,
          content: "Đang xử lý yêu cầu kiểm tra.",
          tool_calls: [{ id: "1", name: "read_file", args: { Path: "/workspace/demo/index.ts" } }],
          token_usage: {
            model: "MODEL_PLACEHOLDER_M47",
            input_tokens: 1200,
            cache_read_tokens: 400,
            output_tokens: 300,
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const handler = makeOffice3dRequestHandler({ stateDir, homeDir });
    const server = http.createServer((req, res) => {
      if (!handler.handle(req, res)) {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const redirectRes = await fetch(`${baseUrl}${OFFICE_3D_ROUTE_PREFIX}`, {
        redirect: "manual",
      });
      expect(redirectRes.status).toBe(302);
      expect(redirectRes.headers.get("location")).toBe(`${OFFICE_3D_ROUTE_PREFIX}/`);

      const indexRes = await fetch(`${baseUrl}${OFFICE_3D_ROUTE_PREFIX}/index.html`);
      expect(indexRes.status).toBe(200);
      const html = await indexRes.text();
      expect(html).toContain("Khu Antigravity");
      expect(html).toContain("antigravity: 0xa87ffb");

      const stateRes = await fetch(`${baseUrl}${OFFICE_3D_ROUTE_PREFIX}/state`);
      expect(stateRes.status).toBe(200);
      const stateJson = (await stateRes.json()) as {
        agents: Array<{
          key: string;
          platform: string;
          room: string;
          lastText: string;
        }>;
      };
      const antigravityAgent = stateJson.agents.find((agent) => agent.key === "a-641ce293");
      expect(antigravityAgent).toBeDefined();
      expect(antigravityAgent?.platform).toBe("antigravity");
      expect(antigravityAgent?.room).toBe("antigravity");
      expect(antigravityAgent?.lastText).toContain("Đang xử lý yêu cầu kiểm tra.");
    } finally {
      handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
