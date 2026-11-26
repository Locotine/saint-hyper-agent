// FILE: InlineLinkChip.test.tsx
// Purpose: Guards InlineLinkChip, SiteFavicon, and react-icons wrappers against
//          emitting nested ARIA link/img objects inside contenteditable composers,
//          which trigger WebKitGTK AT-SPI textInserted SIGABRT on non-ASCII typing.
// Layer: Component rendering tests

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { AppsIcon, GitHubIcon, McpIcon } from "~/lib/icons";
import { resolveSiteFaviconUrl, siteFaviconStatusCache } from "~/lib/siteFavicon";
import { InlineLinkChip } from "./InlineLinkChip";
import { SiteFavicon } from "./SiteFavicon";

describe("InlineLinkChip and decorative icon ARIA", () => {
  const cachedFaviconSrc = resolveSiteFaviconUrl("example.com", { fallback: "none" });

  afterEach(() => {
    siteFaviconStatusCache.delete(cachedFaviconSrc);
  });

  it("omits role=link and strips svg role=img for non-interactive composer GitHub chips", () => {
    const markup = renderToStaticMarkup(
      <InlineLinkChip url="https://github.com/Locotine/saint-hyper-agent/pull/97" />,
    );

    expect(markup).toContain("Locotine/saint-hyper-agent#97");
    expect(markup).not.toContain('role="link"');
    expect(markup).not.toContain('role="img"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("keeps timeline interactive link chips as buttons while keeping the icon decorative", () => {
    const markup = renderToStaticMarkup(
      <InlineLinkChip url="https://github.com/Locotine/saint-hyper-agent/pull/97" interactive />,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
  });

  it("forwards aria props on react-icons wrappers and clears role=img only when aria-hidden", () => {
    const hiddenGitHub = renderToStaticMarkup(<GitHubIcon aria-hidden="true" />);
    expect(hiddenGitHub).toContain('aria-hidden="true"');
    expect(hiddenGitHub).not.toContain('role="img"');

    const labeledGitHub = renderToStaticMarkup(<GitHubIcon aria-label="GitHub repository" />);
    expect(labeledGitHub).toContain('aria-label="GitHub repository"');
    expect(labeledGitHub).toContain('role="img"');

    const hiddenApps = renderToStaticMarkup(<AppsIcon aria-hidden="true" />);
    expect(hiddenApps).toContain('aria-hidden="true"');
    expect(hiddenApps).not.toContain('role="img"');

    const hiddenMcp = renderToStaticMarkup(<McpIcon aria-hidden="true" />);
    expect(hiddenMcp).toContain('aria-hidden="true"');
    expect(hiddenMcp).not.toContain('role="img"');
  });

  it("renders non-interactive composer non-GitHub favicons as background spans instead of img elements", () => {
    siteFaviconStatusCache.set(cachedFaviconSrc, "ok");
    const composerMarkup = renderToStaticMarkup(<InlineLinkChip url="https://example.com/docs" />);

    expect(composerMarkup).toContain("example.com/docs");
    expect(composerMarkup).not.toContain("<img");
    expect(composerMarkup).not.toContain('role="link"');
    expect(composerMarkup).toContain('data-slot="site-favicon"');
    expect(composerMarkup).toContain("background-image:url(");

    const timelineMarkup = renderToStaticMarkup(
      <InlineLinkChip url="https://example.com/docs" interactive />,
    );
    expect(timelineMarkup).toContain("<button");
    expect(timelineMarkup).toContain("<img");
    expect(timelineMarkup).toContain('role="presentation"');
  });

  it("marks loaded SiteFavicon img elements as decorative presentation images", () => {
    siteFaviconStatusCache.set(cachedFaviconSrc, "ok");
    const markup = renderToStaticMarkup(<SiteFavicon url="https://example.com/docs" />);

    expect(markup).toContain("<img");
    expect(markup).toContain('alt=""');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('role="presentation"');
  });
});
