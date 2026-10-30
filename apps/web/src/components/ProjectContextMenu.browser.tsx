import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProjectContextMenu, type LocalProjectMenuRows } from "./ProjectContextMenu";

const LOCAL_ROWS: LocalProjectMenuRows = {
  isRunning: false,
  hasOpenServer: false,
  moveToSpace: <div role="menuitem">Move to space</div>,
  coordinator: null,
  hasArchivableThreads: true,
  hasAnyThreads: true,
};

const screens: Awaited<ReturnType<typeof render>>[] = [];

async function mountMenu(local?: LocalProjectMenuRows) {
  const onAction = vi.fn();
  screens.push(
    await render(
      <ProjectContextMenu
        position={{ x: 40, y: 40 }}
        onClose={() => undefined}
        onAction={onAction}
        pinLabel="Pin project"
        {...(local ? { local } : {})}
      />,
    ),
  );
  return onAction;
}

afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
});

describe("ProjectContextMenu", () => {
  it("gives a remote host's project the rows that work on the host, ending in Remove", async () => {
    const onAction = await mountMenu();
    const items = page.getByRole("menuitem");
    await expect.element(items.first()).toBeVisible();
    const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Copy Path",
      "Edit project",
      "Change project path…",
      "Pin project",
      "Remove",
    ]);
    await page.getByRole("menuitem", { name: "Remove" }).click();
    expect(onAction).toHaveBeenCalledWith("delete");
  });

  it("keeps Finder, Kanban, dev runs and spaces for this computer's projects", async () => {
    await mountMenu(LOCAL_ROWS);
    await expect.element(page.getByRole("menuitem", { name: "Open in Finder" })).toBeVisible();
    const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Open in Finder",
      "Open in Kanban",
      "Copy Path",
      "Start dev",
      "Move to space",
      "Edit project",
      "Change project path…",
      "Pin project",
      "Archive threads",
      "Delete threads",
      "Remove",
    ]);
  });
});
