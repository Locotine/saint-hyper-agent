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

## P4–P5 status

Decisions (asked 2026-10-29): D1 flat list with a host label, D2 offline hosts dimmed and read-only, D3 remote projects in every Space, D5 no cross-host split.

| Item                                                      | State                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `readNativeApi` → `readLocalNativeApi`                    | Done (mechanical rename, 218 files)                                                                                                                                                                                                              |
| Per-host API                                              | Done: `createHostNativeApi(transport)`, `apiFor(hostId)`, `hostHandle`/`useHostHandle` (`hosts/hostScope.tsx`)                                                                                                                                   |
| Host-scoped store reads                                   | Done: `useStore`'s hook form reads the enclosing `HostScope`; `useStore.getState()` stays local                                                                                                                                                  |
| Lint rule against bare local API in thread code           | Not done; the chat hooks use `useHostHandle`                                                                                                                                                                                                     |
| `remoteWindowHost`, per-host `betaFeatures` providers     | Removed with the window switch (P6). Provider lists per host are not done: a host's server refuses providers it does not run                                                                                                                     |
| React Query keys with host                                | Done where a remote surface reads: git status/branches/GitHub repository go to the chat's host and add the host to the key (`gitReactQuery.ts`); local keys unchanged. Explorer/diff stay local-only (the remote surface has no right dock)      |
| Flag `multi-host`                                         | Promoted (2026-10-29): removed from `BETA_ONLY_FEATURES`, no off path left                                                                                                                                                                       |
| Sidebar rows, host label, status, offline dim (U1–U3, U5) | Done (`RemoteHostProjects`); local rows carry no "Local" label                                                                                                                                                                                   |
| Remote chat in the window                                 | Done: read, send, stream, approvals/user input through the host API; offline read-only                                                                                                                                                           |
| New thread on a host (U7)                                 | Done from the project row and from the new-chat folder picker (a connected host's projects under its name, plus "Add new project on <host>"); Add project asks "This computer" or a connected host, and the host's folders open in `RemoteFolderPickerDialog`                                                                                                       |
| Settings: no "Open" for connected hosts (U10)             | Done                                                                                                                                                                                                                                             |
| Disabled state for local-only panels (U6)                 | Done by hiding: in a host's chat ChatView drops the Environment card, project/library panels, Open in, git actions, branch toolbar, project scripts, handoff, the right-dock toggle and the tab strip's New thread. No "Open on <host>" fallback |
| Dev loopback host                                         | Done: `lib/devLoopbackHosts.ts`                                                                                                                                                                                                                  |

## P6 status

| Item                  | State                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host store sync       | Moved to the root (`RemoteHostStoreSync`): hosts stay live whichever sidebar view shows; before, leaving the Projects view dropped their connections                                                                                                                                                                                                         |
| Search palette        | Connected hosts' threads join the results (title only; `hosts/hostSearchThreads.ts`) and open by host-qualified route id                                                                                                                                                                                                                                     |
| Activity / Priority   | Hosts' running and waiting chats list under the Activity view, waiting first; a host chat other than the open one waiting on an answer lights the bell dot                                                                                                                                                                                                   |
| Task notifications    | One runtime per host in its `HostScope` (completion and input-needed); terminals, snooze reminders and the desktop menu action stay local                                                                                                                                                                                                                    |
| Quit (U9)             | The dialog lists hosts' running chats with "Keeps running on <host>"; only this computer's chats are interrupted or resumed                                                                                                                                                                                                                                  |
| Title (U8)            | Desktop main drops "— host" from the window title when the flag is on                                                                                                                                                                                                                                                                                        |
| Cross-host split (D5) | Not done by decision                                                                                                                                                                                                                                                                                                                                         |
| Legacy cleanup        | Done: `remoteSsh.activate`, `remoteWindow` bridge, `mainWindowHost`, title suffix, per-window host IPC (editor over SSH, downloads, window host), `remoteWindowHost`, `PendingRemoteThreadOpener`, the old **Remote hosts** section and the polled catalog are gone. The Explorer download plumbing is inert (no surface offers it) and left for a follow-up |

## Not verified here

- Per-store keying column above is inferred from the key name; confirm when each store is migrated.
- No tests were added for the existing suites; no gap analysis run beyond file presence.
