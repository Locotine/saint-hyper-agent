// Resolves project-owned image files for the favicon route without following
// repository declarations or symlinks outside the canonical project root.
import { isSupportedLocalImagePath } from "@saint/shared/localPreviewFiles";
import { Effect, FileSystem, Layer, Path } from "effect";

import { isContainedPath } from "../../workspace/realPathContainment";

import {
  ProjectFaviconResolver,
  type ProjectFaviconResolverShape,
} from "../Services/ProjectFaviconResolver";

const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
] as const;

const NESTED_FAVICON_CANDIDATES = [
  "apps/web/public/favicon.svg",
  "apps/web/public/favicon.ico",
  "apps/web/public/favicon.png",
  "web/public/favicon.svg",
  "web/public/favicon.ico",
  "web/public/favicon.png",
] as const;

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Icon declarations sit in a page head or near the top of a root route, so only
// this much of each source file is read: a generated multi-megabyte page costs
// the same bounded read and scan as a small one.
const MAX_ICON_SOURCE_BYTES = 512 * 1024;

// Every pattern here runs in linear time: each `<link` tag ends at the next
// `<` or `>`, and object literals are cut at `}` before their keys are matched.
// The earlier single-regex form backtracked quadratically: an 11 MB
// index.html would have held the server's event loop for hours.
const LINK_TAG_RE = /<link\b[^<>]*>/gi;
const LINK_REL_ICON_HTML_RE = /\brel=["'](?:icon|shortcut icon)["']/i;
const LINK_HREF_HTML_RE = /\bhref=["']([^"'?]+)/i;
const LINK_REL_ICON_OBJ_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const LINK_HREF_OBJ_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

export function extractIconHref(source: string): string | null {
  for (const [tag] of source.matchAll(LINK_TAG_RE)) {
    if (!LINK_REL_ICON_HTML_RE.test(tag)) continue;
    const href = LINK_HREF_HTML_RE.exec(tag)?.[1];
    if (href) return href;
  }
  for (const segment of source.split("}")) {
    if (!LINK_REL_ICON_OBJ_RE.test(segment)) continue;
    const href = LINK_HREF_OBJ_RE.exec(segment)?.[1];
    if (href) return href;
  }
  return null;
}

export const makeProjectFaviconResolver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveIconHref = (projectCwd: string, href: string): string[] => {
    const clean = href.replace(/^\//, "");
    return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
  };

  // Return canonical paths so later reads do not follow the discovered symlink.
  const resolveContainedPath = Effect.fn(function* (projectCwd: string, candidate: string) {
    if (!isContainedPath(projectCwd, path.resolve(candidate))) return null;
    const canonicalPath = yield* fileSystem
      .realPath(candidate)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return canonicalPath && isContainedPath(projectCwd, canonicalPath) ? canonicalPath : null;
  });

  const findExistingFile = Effect.fn(function* (
    projectCwd: string,
    candidates: ReadonlyArray<string>,
  ) {
    for (const candidate of candidates) {
      if (!isSupportedLocalImagePath(candidate)) continue;
      const canonicalPath = yield* resolveContainedPath(projectCwd, candidate);
      if (!canonicalPath || !isSupportedLocalImagePath(canonicalPath)) continue;
      const stats = yield* fileSystem
        .stat(canonicalPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (stats?.type === "File") {
        return canonicalPath;
      }
    }
    return null;
  });

  const readSourceHead = (sourcePath: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(sourcePath);
        if ((yield* file.stat).type !== "File") return null;
        const bytes = yield* file.readAlloc(MAX_ICON_SOURCE_BYTES);
        return bytes ? new TextDecoder().decode(bytes) : null;
      }),
    ).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolvePath: ProjectFaviconResolverShape["resolvePath"] = Effect.fn(function* (projectCwd) {
    const cwd = yield* fileSystem
      .realPath(projectCwd)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!cwd) return null;

    for (const candidate of FAVICON_CANDIDATES) {
      const existing = yield* findExistingFile(cwd, [path.join(cwd, candidate)]);
      if (existing) {
        return existing;
      }
    }

    for (const sourceFile of ICON_SOURCE_FILES) {
      const sourcePath = yield* resolveContainedPath(cwd, path.join(cwd, sourceFile));
      if (!sourcePath) continue;
      const source = yield* readSourceHead(sourcePath);
      if (!source) {
        continue;
      }
      const href = extractIconHref(source);
      if (!href) {
        continue;
      }
      const existing = yield* findExistingFile(cwd, resolveIconHref(cwd, href));
      if (existing) {
        return existing;
      }
    }

    // Nested app discovery is a fallback to the project's own icon and declaration.
    for (const candidate of NESTED_FAVICON_CANDIDATES) {
      const existing = yield* findExistingFile(cwd, [path.join(cwd, candidate)]);
      if (existing) {
        return existing;
      }
    }

    // Some repositories keep the web app one directory below the project root.
    // Limit discovery to app-like first-level folders so a sidebar refresh does
    // not scan unrelated source trees or dependency directories.
    const children = yield* fileSystem
      .readDirectory(cwd)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    const appFolders = children
      .filter((name) => !name.startsWith(".") && /(?:web|front|dash|app|client|site)/i.test(name))
      .toSorted()
      .slice(0, 16);
    for (const folder of appFolders) {
      const existing = yield* findExistingFile(
        cwd,
        ["favicon.svg", "favicon.ico", "favicon.png"].map((name) =>
          path.join(cwd, folder, "public", name),
        ),
      );
      if (existing) return existing;
    }

    return null;
  });

  return { resolvePath } satisfies ProjectFaviconResolverShape;
});

export const ProjectFaviconResolverLive = Layer.effect(
  ProjectFaviconResolver,
  makeProjectFaviconResolver,
);
