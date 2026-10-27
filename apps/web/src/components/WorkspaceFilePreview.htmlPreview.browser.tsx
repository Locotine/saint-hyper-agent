// FILE: WorkspaceFilePreview.htmlPreview.browser.tsx
// Purpose: Browser regression for rendered HTML previews — HTML opens in a
//          sandboxed frame served by the server's preview route, without the
//          size-capped text read, and Source still shows the markup.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@saint/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const WORKSPACE_ROOT = "/Users/tester/project";
const FILE = "out/report page.html";

function installNativeApi(api: NativeApi): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", { configurable: true, value: api });
  return () => {
    if (previousDescriptor) Object.defineProperty(window, "nativeApi", previousDescriptor);
    else Reflect.deleteProperty(window, "nativeApi");
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("renders HTML in a sandboxed preview frame and keeps Source one click away", async () => {
  const readFile = vi.fn(
    async (input: { relativePath: string }): Promise<ProjectReadFileResult> => ({
      relativePath: input.relativePath,
      contents: "<h1>Report</h1>\n",
      truncated: false,
      version: `sha256:${"1".repeat(64)}`,
      encoding: "utf8",
      lineEnding: "lf",
    }),
  );
  const createHtmlPreviewGrant = vi.fn(async () => ({
    grant: "grant-123",
    entryName: "report page.html",
  }));
  const restoreNativeApi = installNativeApi({
    projects: { readFile, createHtmlPreviewGrant },
  } as unknown as NativeApi);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE} />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = document.querySelector("iframe")!;
    expect(iframe.title).toBe("report page.html");
    expect(iframe.getAttribute("src")).toContain("/api/html-preview/grant-123/report%20page.html");
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(createHtmlPreviewGrant).toHaveBeenCalledWith({
      path: `${WORKSPACE_ROOT}/${FILE}`,
    });
    expect(readFile).not.toHaveBeenCalled();

    await page.getByRole("radio", { name: "Source" }).click();
    await expect.element(page.getByText("<h1>Report</h1>")).toBeVisible();
    expect(readFile).toHaveBeenCalled();
  } finally {
    restoreNativeApi();
  }
});
