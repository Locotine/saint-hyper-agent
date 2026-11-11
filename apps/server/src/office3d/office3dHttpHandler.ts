import type http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { ServerConfigShape } from "../config";

export const OFFICE_3D_ROUTE_PREFIX = "/office-3d-app";

interface Office3dAppInstance {
  readonly ensureStarted: () => void;
  readonly close: () => void;
  readonly handleRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    subUrl?: URL,
  ) => void;
  readonly snapshot: () => unknown;
  readonly perfNow: () => unknown;
}

interface Office3dServerModule {
  readonly createOffice3dApp: (overrides?: Record<string, unknown>) => Office3dAppInstance | null;
  readonly stripAntigravityEnvelope: (raw: string) => string;
}

const requireOffice3d = createRequire(import.meta.url);

export function resolveOffice3dServerEntry(
  moduleDirectory: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  const execDirectory = path.dirname(process.execPath);
  const cwd = process.cwd();
  const candidates = [
    path.resolve(moduleDirectory, "server.js"),
    path.resolve(moduleDirectory, "office3d", "server.js"),
    path.resolve(moduleDirectory, "..", "src", "office3d", "server.js"),
    path.resolve(execDirectory, "office3d", "server.js"),
    path.resolve(execDirectory, "..", "Resources", "office3d", "server.js"),
    path.resolve(execDirectory, "..", "..", "apps", "server", "src", "office3d", "server.js"),
    path.resolve(execDirectory, "..", "..", "..", "apps", "server", "src", "office3d", "server.js"),
    path.resolve(cwd, "apps", "server", "src", "office3d", "server.js"),
    path.resolve(cwd, "src", "office3d", "server.js"),
  ];
  for (const candidate of candidates) {
    try {
      return requireOffice3d.resolve(candidate);
    } catch {
      // try next candidate
    }
  }
  return candidates[0]!;
}

export interface Office3dRequestHandler {
  readonly handle: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  readonly close: () => void;
}

export function makeOffice3dRequestHandler(
  config: Pick<ServerConfigShape, "stateDir" | "homeDir">,
): Office3dRequestHandler {
  let app: Office3dAppInstance | null = null;

  const getApp = (): Office3dAppInstance | null => {
    if (app) return app;
    const mod = requireOffice3d(resolveOffice3dServerEntry()) as Office3dServerModule;
    const baseDir = path.join(config.stateDir, "van-phong-ao");
    app = mod.createOffice3dApp({
      dataDir: path.join(baseDir, "data"),
      pinFile: path.join(baseDir, "pin.txt"),
      claudeDir: path.join(config.homeDir, ".claude"),
      codexDir: path.join(config.homeDir, ".codex"),
      antigravityDir: path.join(config.homeDir, ".gemini", "antigravity-cli"),
    });
    return app;
  };

  return {
    handle(req, res) {
      const rawUrl = req.url ?? "/";
      let parsed: URL;
      try {
        parsed = new URL(rawUrl, "http://127.0.0.1");
      } catch {
        return false;
      }

      if (parsed.pathname === OFFICE_3D_ROUTE_PREFIX) {
        res.writeHead(302, {
          Location: `${OFFICE_3D_ROUTE_PREFIX}/${parsed.search}`,
        });
        res.end();
        return true;
      }

      if (!parsed.pathname.startsWith(`${OFFICE_3D_ROUTE_PREFIX}/`)) {
        return false;
      }

      const instance = getApp();
      if (!instance) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Office 3D unavailable");
        return true;
      }

      const subPath = parsed.pathname.slice(OFFICE_3D_ROUTE_PREFIX.length) || "/";
      const subUrl = new URL(`${subPath}${parsed.search}`, "http://127.0.0.1");
      instance.handleRequest(req, res, subUrl);
      return true;
    },
    close() {
      if (app) {
        app.close();
        app = null;
      }
    },
  };
}
