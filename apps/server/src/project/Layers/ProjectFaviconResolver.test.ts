import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ProjectFaviconResolver } from "../Services/ProjectFaviconResolver";
import { extractIconHref, ProjectFaviconResolverLive } from "./ProjectFaviconResolver";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "saint-project-favicon-",
  });
  return yield* fileSystem.realPath(directory);
});

const writeTextFile = Effect.fn(function* (cwd: string, relativePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  describe("resolvePath", () => {
    it.effect("prefers well-known favicon files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("finds favicons in a workspace web app", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "apps/web/public/favicon.png", "icon");

        expect(yield* resolver.resolvePath(cwd)).toContain("apps/web/public/favicon.png");
      }),
    );

    it.effect("finds favicons in a named dashboard app", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "vatrium-dashboard/public/favicon.png", "icon");

        expect(yield* resolver.resolvePath(cwd)).toContain("vatrium-dashboard/public/favicon.png");
      }),
    );

    const nestedIcons = [
      "apps/web/public/favicon.png",
      "web/public/favicon.png",
      "project-dashboard/public/favicon.png",
    ];

    it.effect.each(nestedIcons)("prefers the declared project icon over $0", (nestedIcon) =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>project brand</svg>");
        yield* writeTextFile(cwd, nestedIcon, "nested icon");

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "public/brand/logo.svg"));
      }),
    );

    it.effect.each(nestedIcons)("prefers the root app icon over $0", (nestedIcon) =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "app/icon.svg", "<svg>project icon</svg>");
        yield* writeTextFile(cwd, nestedIcon, "nested icon");

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "app/icon.svg"));
      }),
    );

    it.effect("resolves icon hrefs below dot-prefixed child directories", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="..assets/logo.svg">');
        yield* writeTextFile(cwd, "..assets/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("..assets/logo.svg");
      }),
    );

    it.effect("returns null when no icon is present", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("reads only the head of a large icon source file", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        // An 11 MB generated page with no `}`: the old resolver hung on this shape.
        const filler = "<p>row</p>".repeat(1_100_000);
        yield* writeTextFile(
          cwd,
          "index.html",
          `<link rel="icon" href="/brand/logo.svg">${filler}`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");
        yield* writeTextFile(cwd, "src/index.html", `${filler}<link rel="icon" href="/late.svg">`);
        yield* writeTextFile(cwd, "public/late.svg", "<svg>late</svg>");

        const startedAt = performance.now();
        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "public/brand/logo.svg"));
        expect(performance.now() - startedAt).toBeLessThan(1_000);

        yield* writeTextFile(cwd, "index.html", filler);
        // `src/index.html` declares its icon past the bytes that are read.
        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }),
    );
  });
});

describe("extractIconHref", () => {
  it("reads link tags and route objects", () => {
    expect(extractIconHref('<link href="/a.svg" rel="icon">')).toBe("/a.svg");
    expect(
      extractIconHref(
        '<link rel="stylesheet" href="/s.css"><link rel="shortcut icon" href="/b.ico?v=2">',
      ),
    ).toBe("/b.ico");
    expect(extractIconHref('links: () => [{ rel: "icon", href: "/c.png" }]')).toBe("/c.png");
    expect(
      extractIconHref('[{ rel: "stylesheet", href: "/s.css" }, { href: "/d.svg", rel: "icon" }]'),
    ).toBe("/d.svg");
    expect(extractIconHref("<p>no icon</p>")).toBeNull();
  });

  it("scans large inputs without backtracking", () => {
    // The old single-regex form was quadratic: about 17 s on the 200 000-character input.
    const inputs = [
      `rel: "icon" ${"href ".repeat(40_000)}`,
      `${"<link rel='icon' ".repeat(20_000)}`,
      `${"a".repeat(200_000)}`,
    ];
    const startedAt = performance.now();
    for (const input of inputs) expect(extractIconHref(input)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
