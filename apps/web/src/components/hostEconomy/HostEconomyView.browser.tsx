import type { EconomyStatus, ThreadId } from "@saint/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../index.css";

const fixture = vi.hoisted(() => ({ agent: vi.fn(), update: vi.fn(), dispatch: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: import("react").ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../RouteSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../RouteSurface")>()),
  RouteSurfaceHeader: () => null,
}));

const at = (minute: number) => new Date(Date.UTC(2026, 9, 29, 0, minute)).toISOString();
const status: EconomyStatus = {
  settings: { idleMinutes: 10, warnUsedPct: 85, criticalUsedPct: 95, seatCap: 4, hubShared: [] },
  latest: { at: at(2), totalMb: 16384, usedMb: 8192, stallPct: 2, agentRssMb: 900, level: "ok" },
  samples: [0, 1, 2].map((minute) => ({
    at: at(minute),
    totalMb: 16384,
    usedMb: 6000 + minute * 1000,
    stallPct: minute,
    agentRssMb: 900,
    level: "ok" as const,
  })),
  seatsUsed: 2,
  admission: null,
  agents: [
    {
      threadId: "t-active" as ThreadId,
      provider: "claudeAgent",
      state: "active",
      lastSeenAt: at(2),
      hibernatedAt: null,
      resumable: true,
      rssMb: 420,
      cpuPct: 12.5,
    },
    {
      threadId: "t-sleep" as ThreadId,
      provider: "codex",
      state: "hibernated",
      lastSeenAt: null,
      hibernatedAt: at(1),
      resumable: true,
      rssMb: null,
      cpuPct: null,
    },
  ],
  processes: [],
  hub: [
    {
      command: "npx mcp-server-git",
      name: "mcp_server_git_hub",
      instances: 2,
      rssMb: 120,
      shared: false,
      sessions: 0,
    },
  ],
};

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureLocalNativeApi: () => ({
    economy: { status: async () => status, agent: fixture.agent, update: fixture.update },
    orchestration: { dispatchCommand: fixture.dispatch },
  }),
}));

import { HostEconomyView } from "./HostEconomyView";

it("shows figures, the chart, agents and the MCP Hub, and sends their actions", async () => {
  fixture.agent.mockResolvedValue(status);
  fixture.update.mockResolvedValue(status);
  fixture.dispatch.mockResolvedValue({ sequence: 1 });
  const view = await render(
    <QueryClientProvider client={new QueryClient()}>
      <HostEconomyView />
    </QueryClientProvider>,
  );
  await expect.element(view.getByText("8.0 GB / 16.0 GB")).toBeVisible();
  await expect.element(view.getByText("2 / 4")).toBeVisible();
  await expect.element(view.getByRole("img", { name: /Used memory/ })).toBeVisible();
  await expect.element(view.getByText(/420 MB · 12.5% CPU/)).toBeVisible();

  await view.getByRole("button", { name: "Hibernate" }).click();
  expect(fixture.agent).toHaveBeenCalledWith({ threadId: "t-active", action: "hibernate" });
  await view.getByRole("button", { name: "Wake" }).click();
  expect(fixture.agent).toHaveBeenCalledWith({ threadId: "t-sleep", action: "wake" });
  await view.getByRole("button", { name: "Stop" }).click();
  expect(fixture.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "thread.turn.interrupt", threadId: "t-active" }),
  );
  await view.getByRole("switch", { name: /Share npx mcp-server-git/ }).click();
  expect(fixture.update).toHaveBeenCalledWith({ hubShared: ["npx mcp-server-git"] });
  view.unmount();
});
