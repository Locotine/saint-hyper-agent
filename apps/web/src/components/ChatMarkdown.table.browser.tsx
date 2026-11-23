import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import ChatMarkdown from "./ChatMarkdown";

const SAMPLE_TABLES_MARKDOWN = [
  "| Kiểm tra | Kết quả | Chi tiết |",
  "| --- | --- | --- |",
  "| `bunx vitest run scripts/sync-tauri-release-version.test.ts apps/web/src/whatsNew/ apps/web/src/hasSelectorVariants.test.ts apps/web/src/uiFontSize.test.ts` | **PASS** | 4 files, 15/15 passed |",
  "| `bun run fmt:check` | **PASS** | 0 lỗi trên 4523 files |",
  "",
  "| Nhóm | File | Nội dung |",
  "| --- | --- | --- |",
  "| **Hotfix & test** | `lan_relay.rs` | Đổi `Referrer-Policy: no-referrer` sang `same-origin` cho phản hồi `/pair` để trình duyệt gửi `Origin` hợp lệ thay vì `Origin: null`. |",
].join("\n");

describe("ChatMarkdown table layout", () => {
  it("keeps short columns readable on desktop without breaking headers mid-word", async () => {
    await page.viewport(1000, 900);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mounted = await render(
      <QueryClientProvider client={queryClient}>
        <div data-testid="pane" style={{ width: 648, overflowX: "hidden" }}>
          <ChatMarkdown text={SAMPLE_TABLES_MARKDOWN} cwd={undefined} />
        </div>
      </QueryClientProvider>,
    );

    try {
      const wrappers = Array.from(
        document.querySelectorAll<HTMLElement>(".chat-markdown-table-scroll"),
      );
      expect(wrappers).toHaveLength(2);

      const firstTable = wrappers[0]!.querySelector("table")!;
      const tableStyle = window.getComputedStyle(firstTable);
      expect(tableStyle.overflowWrap).toBe("break-word");
      expect(tableStyle.wordBreak).toBe("normal");

      const firstTd = firstTable.querySelector("tbody td")!;
      expect(window.getComputedStyle(firstTd).verticalAlign).toBe("top");

      // Short columns must not be crushed below readable word widths even beside
      // a very long command cell.
      const firstHeaders = Array.from(firstTable.querySelectorAll("thead th"));
      const statusHeaderWidth = firstHeaders[1]!.getBoundingClientRect().width;
      const detailsHeaderWidth = firstHeaders[2]!.getBoundingClientRect().width;
      expect(statusHeaderWidth).toBeGreaterThanOrEqual(60);
      expect(detailsHeaderWidth).toBeGreaterThanOrEqual(80);

      // Wrapper stays bounded inside the desktop pane with no clipping.
      expect(wrappers[0]!.getBoundingClientRect().width).toBeLessThanOrEqual(649);
      expect(wrappers[1]!.getBoundingClientRect().width).toBeLessThanOrEqual(649);
    } finally {
      await mounted.unmount();
    }
  });

  it("scrolls wide tables horizontally on mobile instead of crushing columns", async () => {
    await page.viewport(375, 900);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mounted = await render(
      <QueryClientProvider client={queryClient}>
        <div data-testid="pane" style={{ width: 343, overflowX: "hidden" }}>
          <ChatMarkdown text={SAMPLE_TABLES_MARKDOWN} cwd={undefined} />
        </div>
      </QueryClientProvider>,
    );

    try {
      const wrappers = Array.from(
        document.querySelectorAll<HTMLElement>(".chat-markdown-table-scroll"),
      );
      expect(wrappers).toHaveLength(2);

      for (const wrapper of wrappers) {
        expect(wrapper.getBoundingClientRect().width).toBeLessThanOrEqual(344);
        expect(wrapper.scrollWidth).toBeGreaterThan(wrapper.clientWidth);
      }

      const firstHeaders = Array.from(wrappers[0]!.querySelectorAll("thead th"));
      // Previously "Kết quả" was crushed to ~36px (100px tall, letter-by-letter).
      expect(firstHeaders[1]!.getBoundingClientRect().width).toBeGreaterThanOrEqual(70);
      expect(firstHeaders[1]!.getBoundingClientRect().height).toBeLessThanOrEqual(48);

      const secondHeaders = Array.from(wrappers[1]!.querySelectorAll("thead th"));
      expect(secondHeaders[0]!.getBoundingClientRect().width).toBeGreaterThanOrEqual(90);
      expect(secondHeaders[2]!.getBoundingClientRect().width).toBeGreaterThanOrEqual(180);
    } finally {
      await mounted.unmount();
    }
  });
});
