# Multi-host P0 inventory

Companion to [multi-host-plan.md](multi-host-plan.md). Counts taken on `main` @ `21c3d7732` (grep, `apps/web/src`).

## Status

| P0 item                                                       | State                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HostId` / `ScopedThreadId` / `ScopedProjectId` types + tests | Done: `packages/shared/src/hostId.ts` (subpath `@saint/shared/hostId`)                                                                                                                                              |
| Characterization tests for the local path                     | Existing suites already cover it: `wsNativeApi.test.ts`, `storeProjection.test.ts`, `storeEventReducer.test.ts`, `storePersistence.test.ts`, `components/EventRouter.browser.tsx`. Gaps are listed per phase below. |
| Loopback second-host harness (dev-only)                       | Not started (needs a design call: second `saint` server on another port + home vs. fake transport; plan §6 favours the fake-transport route for unit and browser tests)                                             |
| Call-site inventory                                           | Below                                                                                                                                                                                                               |

## Call-site counts

| Symbol                              | Count                                        |
| ----------------------------------- | -------------------------------------------- |
| `readNativeApi` / `ensureNativeApi` | 648 uses in 217 files (P4 rename target)     |
| `remoteWindowHost`                  | 26 uses (P4/P6 replace with `hostIdOf(ref)`) |

## Persisted client stores that mention thread or project (P3 migration candidates)

Keys found in `apps/web/src` (non-test). Each needs a per-store check in P3: does it key by thread/project ID or by `cwd`, and what is the `local~<raw>` migration. Stores not keyed by either (settings, onboarding, profile, theme) are out of scope.

| Key                                                    | File                              | Likely keyed by                      |
| ------------------------------------------------------ | --------------------------------- | ------------------------------------ |
| `saint:renderer-state:v8`                              | `storePersistence.ts`             | project `cwd` (needs `hostId + cwd`) |
| `saint:composer-drafts:v1`                             | `composerDraftDomain.ts`          | thread                               |
| `saint:diff-render-mode-by-thread:v1`                  | `diffRenderModeStore.ts`          | thread                               |
| `saint:pinned-threads:v1`                              | `pinnedThreadsStore.ts`           | thread                               |
| `saint:pinned-projects:v1`                             | `pinnedProjectsStore.ts`          | project                              |
| `saint:pinned-project-agents:v1`                       | `pinnedProjectAgentsStore.ts`     | project                              |
| `saint:open-thread-tabs:v1`                            | `openThreadTabsStore.ts`          | thread                               |
| `saint:split-view-state:v1`                            | `splitViewStore.ts`               | thread                               |
| `saint:recent-views:v1`                                | `recentViewsStore.ts`             | thread/project                       |
| `saint:thread-visited:v1`                              | `threadVisitedPersistence.ts`     | thread                               |
| `saint:terminal-state:v1`                              | `terminalStateStore.ts`           | thread                               |
| `saint:browser-state:v1`                               | `browserStateStore.ts`            | thread (local-only feature)          |
| `saint:claude-compaction-requests`                     | `lib/claudeCompactionRequests.ts` | thread                               |
| `saint:latest-project:v1`                              | `latestProjectStore.ts`           | project                              |
| `saint:project-instructions:v1`                        | `projectInstructionsStore.ts`     | project                              |
| `saint:project-environment:v1`                         | `projectEnvironmentStore.ts`      | project                              |
| `saint:repo-diff-scope:v1`                             | `repoDiffScopeStore.ts`           | project/cwd                          |
| `saint:workspace-paths:v1`, `saint:workspace-pages:v2` | `workspacePathsStore.ts`          | project/cwd                          |
| `saint:kanban-ui:v1`                                   | `kanbanUiStore.ts`                | project                              |
| `saint:workflow-run-ui:v1`                             | `workflowRunUiStore.ts`           | project/thread                       |
| `saint:group-panel-closed:v1`                          | `groupPanelClosedStore.ts`        | thread (hub)                         |
| `saint:last-invoked-script-by-project`                 | `components/ChatView.logic.ts`    | project                              |
| `saint:dismissed-provider-health-banners`              | `components/ChatView.logic.ts`    | provider (check)                     |

The plan's "~80 files touch localStorage" figure is broader than this list; the P3 sweep must also grep `localStorage` / `useLocalStorage` usages with computed keys.

## P3 status

Pattern for every migrated store: ids in the store are `ScopedThreadId`/`ScopedProjectId`; the key moves to the next version and reads the old key once through `withLegacyKeyFallback` (`lib/storage.ts`), re-keying raw ids as local (`scopeThreadKeyedRecord`/`scopeProjectKeyedRecord` in `persistedRecord.ts`). The old key is never written, so a rollback finds its own state. Snapshot GC (`prune*`, `removeOrphaned*`, `removeThreadFromSplitViews`) takes a `hostId` and only drops that host's entries. Forgetting a host clears its entries everywhere (`hosts/forgetHostClientState.ts`).

| Store                                                                                                                                   | State                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| composer drafts, open tabs, terminal state                                                                                              | Scoped, `v2` key                                                                                                                                                                |
| pinned threads, recent views, diff render mode, workflow-run UI, Claude compaction requests (session storage)                           | Scoped, `v2` key                                                                                                                                                                |
| split views                                                                                                                             | Each split has a `hostId`; leaves keep raw ids of that host (cross-host split is open decision D5). Schema 3 under `v2` key; source map keyed by scoped thread id               |
| pinned projects, latest project, project environment, project instructions, group panel closed, kanban draft order, last-invoked script | Scoped, `v2` key (last-invoked script keeps its key; rows are re-keyed on read and on the next write)                                                                           |
| browser state, pinned project agents                                                                                                    | Unchanged: local-only features (plan §2.3, §2.6)                                                                                                                                |
| renderer state (`v8`, project by cwd), thread visited                                                                                   | Unchanged: only the local host store persists (`createHostStore` returns early for remote hosts), so a host key has nothing to separate yet. Revisit when remote stores persist |
| repo diff scope, workspace paths                                                                                                        | Unchanged: keyed by `cwd`, no thread/project ids. Two hosts with the same path would share an entry; revisit with the remote diff/explorer surfaces (P5)                        |
| dismissed provider-health banners                                                                                                       | Unchanged: keyed by provider                                                                                                                                                    |
| Route `/$threadId`                                                                                                                      | Parses and stringifies host-qualified ids (a local scoped id is shortened to the bare id); consumers still address local threads                                                |
| React Query keys                                                                                                                        | Deferred to P4: every query function still calls the local API, so a host in the key would not match the data it caches. Add the host with `useHostApi`                         |

## Not verified here

- Per-store keying column above is inferred from the key name; confirm when each store is migrated.
- No tests were added for the existing suites; no gap analysis run beyond file presence.
