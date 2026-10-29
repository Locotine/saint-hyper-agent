import type { AegisAlert, AegisStatus } from "@saint/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../index.css";

const fixture = vi.hoisted(() => ({
  resolve: vi.fn(),
  update: vi.fn(),
  unfreeze: vi.fn(),
  exportLedger: vi.fn(),
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

const alert = (id: string, severity: AegisAlert["severity"], title: string): AegisAlert => ({
  id,
  kind: "new_domain",
  severity,
  title,
  detail: `${title} detail`,
  why: ["egress proxy", "no allow entry", "default deny"],
  flowId: null,
  nodeId: null,
  threadId: null,
  domain: "example.com",
  state: "open",
  decidedBy: null,
  createdAt: "2026-10-29T01:00:00.000Z",
  updatedAt: "2026-10-29T01:00:00.000Z",
});

const status = {
  settings: {
    autonomy: "L1",
    unattendedSignedOffBy: null,
    policy: {
      version: 1,
      cedar: "",
      egressAllowlist: ["api.github.com"],
      egressDenylist: [],
      protectedZones: ["tests/**"],
    },
    unsandboxedThreads: ["thread-raw"],
  },
  frozen: [
    {
      id: "fz-1",
      path: "/work/flow-1",
      threadId: null,
      flowId: null,
      files: 12,
      frozenAt: "2026-10-29T01:00:00.000Z",
    },
  ],
  layers: [
    { id: "sandbox", enabled: false, available: true, detail: "bwrap wraps flow gates from L2." },
    { id: "ledger", enabled: true, available: true, detail: "Hash-chained, signed flow ledger." },
  ],
  locked: { L3: "Needs a sign-off.", L4: "Needs AP-03 (loop 7)." },
  openAlerts: 2,
} as unknown as AegisStatus;

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureLocalNativeApi: () => ({
    aegis: {
      status: async () => status,
      alerts: async () => ({
        alerts: [alert("a-low", "low", "Low thing"), alert("a-crit", "critical", "Decoy used")],
      }),
      resolve: fixture.resolve,
      update: fixture.update,
      unfreeze: fixture.unfreeze,
    },
    ledger: {
      verify: async () => ({ intact: true, count: 42, brokenAtSeq: null }),
      export: fixture.exportLedger,
    },
  }),
}));

import { SecurityView } from "./SecurityView";

it("lists alerts riskiest first, decides them in a batch, and shows the ladder and the chain", async () => {
  fixture.resolve.mockResolvedValue({ alerts: [] });
  fixture.update.mockResolvedValue(status);
  const view = await render(
    <QueryClientProvider client={new QueryClient()}>
      <SecurityView />
    </QueryClientProvider>,
  );
  await expect.element(view.getByText("Decoy used", { exact: true })).toBeVisible();
  const titles = [...document.querySelectorAll('[aria-label="Alert feed"] [role="listitem"]')].map(
    (row) => row.textContent ?? "",
  );
  expect(titles[0]).toContain("Decoy used");

  await view.getByRole("button", { name: "Decoy used" }).click();
  await expect.element(view.getByText("Decoy used detail")).toBeVisible();
  await expect
    .element(view.getByRole("button", { name: "Decoy used" }))
    .toHaveAttribute("aria-expanded", "true");

  await view.getByRole("button", { name: "Select all open" }).click();
  await view.getByRole("button", { name: "Approve 2" }).click();
  expect(fixture.resolve).toHaveBeenCalledWith({ ids: ["a-crit", "a-low"], decision: "allow" });

  await expect.element(view.getByRole("button", { name: "L3 Unattended" })).toBeDisabled();
  await view.getByRole("button", { name: "L2 Allowlist" }).click();
  expect(fixture.update).toHaveBeenCalledWith({ autonomy: "L2" });
  await expect.element(view.getByText("intact · 42 events")).toBeVisible();
  await expect.element(view.getByText(/Off · bwrap/)).toBeVisible();
  view.unmount();
});

it("saves the Cedar policy and zones, unfreezes a worktree and turns the sandbox back on", async () => {
  fixture.update.mockResolvedValue(status);
  fixture.unfreeze.mockResolvedValue(status);
  const view = await render(
    <QueryClientProvider client={new QueryClient()}>
      <SecurityView />
    </QueryClientProvider>,
  );
  await view.getByRole("button", { name: "Unfreeze" }).click();
  expect(fixture.unfreeze).toHaveBeenCalledWith({ id: "fz-1" });

  await view.getByRole("switch", { name: "Turn the sandbox back on" }).click();
  expect(fixture.update).toHaveBeenCalledWith({
    runWithoutSandbox: { threadId: "thread-raw", enabled: false },
  });

  await view
    .getByRole("textbox", { name: "Cedar policies" })
    .fill("forbid (principal, action, resource);");
  await view
    .getByRole("textbox", { name: "Protected zones (one glob per line)" })
    .fill("tests/**\nflows/**");
  await view.getByRole("button", { name: "Save policy" }).click();
  expect(fixture.update).toHaveBeenCalledWith({
    policy: {
      cedar: "forbid (principal, action, resource);",
      protectedZones: ["tests/**", "flows/**"],
      egressAllowlist: ["api.github.com"],
      egressDenylist: [],
    },
  });
  view.unmount();
});
