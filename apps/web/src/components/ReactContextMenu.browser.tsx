import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ReactContextMenuHost, showReactContextMenu } from "./ReactContextMenu";

const screens: Awaited<ReturnType<typeof render>>[] = [];

async function mountHost() {
  screens.push(await render(<ReactContextMenuHost />));
}

afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
});

describe("showReactContextMenu", () => {
  it("resolves with the chosen row, including one inside a submenu", async () => {
    await mountHost();
    const chosen = showReactContextMenu(
      [
        { id: "rename", label: "Rename thread" },
        {
          id: "fork",
          label: "Fork",
          separatorBefore: true,
          children: [
            { id: "fork:local", label: "Fork locally" },
            { id: "fork:worktree", label: "Fork into worktree" },
          ],
        },
        { id: "delete", label: "Delete", destructive: true, separatorBefore: true },
      ],
      { x: 40, y: 40 },
    );
    await expect.element(page.getByRole("menuitem", { name: "Rename thread" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Fork" }).hover();
    await page.getByRole("menuitem", { name: "Fork into worktree" }).click();
    await expect(chosen).resolves.toBe("fork:worktree");
    await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
  });

  it("resolves null when dismissed, and when a newer menu replaces it", async () => {
    await mountHost();
    const first = showReactContextMenu([{ id: "a", label: "First" }], { x: 10, y: 10 });
    await expect.element(page.getByRole("menuitem", { name: "First" })).toBeVisible();
    const second = showReactContextMenu([{ id: "b", label: "Second" }], { x: 10, y: 10 });
    await expect(first).resolves.toBeNull();
    await expect.element(page.getByRole("menuitem", { name: "Second" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Second" }).click();
    await expect(second).resolves.toBe("b");
  });
});
