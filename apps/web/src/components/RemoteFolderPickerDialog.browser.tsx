import "../index.css";

import type { FilesystemBrowseInput, FilesystemBrowseResult } from "@saint/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { pickRemoteFolder, useRemoteFolderPickerStore } from "../remoteFolderPickerStore";
import { RemoteFolderPickerDialog } from "./RemoteFolderPickerDialog";

const LISTINGS: Record<string, FilesystemBrowseResult> = {
  "~/": {
    parentPath: "/home/pt",
    entries: [
      { name: ".cache", fullPath: "/home/pt/.cache", isGitRepository: false },
      { name: "app", fullPath: "/home/pt/app", isGitRepository: true },
      { name: "notes", fullPath: "/home/pt/notes", isGitRepository: false },
    ],
  },
  "/home/pt/app/": {
    parentPath: "/home/pt/app",
    entries: [{ name: "src", fullPath: "/home/pt/app/src", isGitRepository: false }],
  },
};

function installBrowse() {
  const browse = vi.fn(async (input: FilesystemBrowseInput) => {
    const listing = LISTINGS[input.partialPath];
    if (!listing) throw new Error(`ENOENT: ${input.partialPath}`);
    return listing;
  });
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { filesystem: { browse } },
  });
  return browse;
}

async function mountDialog() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <RemoteFolderPickerDialog />
    </QueryClientProvider>,
  );
}

describe("RemoteFolderPickerDialog", () => {
  afterEach(() => {
    useRemoteFolderPickerStore.getState().settle(null);
    Reflect.deleteProperty(window, "nativeApi");
  });

  it("browses the host's folders and resolves the chosen one", async () => {
    const browse = installBrowse();
    await mountDialog();

    const picked = pickRemoteFolder();
    await expect.element(page.getByRole("button", { name: "app git" })).toBeVisible();
    await expect.element(page.getByText("notes")).toBeVisible();
    await expect.element(page.getByText(".cache")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "app git" }).click();
    await expect.element(page.getByText("src")).toBeVisible();
    expect(browse).toHaveBeenLastCalledWith({ partialPath: "/home/pt/app/" });
    await expect
      .element(page.getByLabelText("Folder path on the remote host"))
      .toHaveValue("/home/pt/app");

    await page.getByRole("button", { name: "Open" }).click();
    await expect(picked).resolves.toBe("/home/pt/app");
  });

  it("shows hidden folders on request and reports unreadable paths", async () => {
    installBrowse();
    await mountDialog();

    const picked = pickRemoteFolder();
    // The picker reopens at the last pick (/home/pt/app); go back home.
    await expect
      .element(page.getByLabelText("Folder path on the remote host"))
      .toHaveValue("/home/pt/app");
    await page.getByRole("button", { name: "Home folder" }).click();
    await page.getByRole("button", { name: "Show hidden folders" }).click();
    await expect.element(page.getByText(".cache")).toBeVisible();

    const pathInput = page.getByLabelText("Folder path on the remote host");
    await pathInput.fill("/missing");
    await pathInput
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await expect.element(page.getByText("ENOENT: /missing/")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Open" })).toBeDisabled();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(picked).resolves.toBeNull();
  });
});
