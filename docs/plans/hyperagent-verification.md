# HyperAgent — what to test and verify (single final pass)

Per the operator's instruction, nothing is verified on a live instance phase by phase. Implementation runs P1 → P12 first, then this whole file runs in one pass. Each phase appends its items here as it lands. Tick a row only after the final pass actually runs it.

Plan: `~/.claude/plans/l-y-plan-cho-v-ng-tingly-nygaard.md` · Branch: `feat/hyperagent-p1-ledger` (and its successors)

## 1. Repository checks (run once, at the end)

| Check                                                     | Command                                                                           | Status |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| Format                                                    | `bun run fmt:check`                                                               | ☐      |
| Lint                                                      | `bun run lint`                                                                    | ☐      |
| Typecheck (all workspaces)                                | `bun run typecheck`                                                               | ☐      |
| Full test suite                                           | `bun run test` (never `bun test`)                                                 | ☐      |
| Migration lineage                                         | `bun run migrations:check`                                                        | ☐      |
| Windows process boundary (P8 sandbox)                     | `bun run windows-runtime:check`                                                   | ☐      |
| UI font sizes / `has-*` guard (P10–P12)                   | `uiFontSize.test.ts`, `hasSelectorVariants.test.ts`                               | ☐      |
| Browser tests (P10–P12)                                   | `*.browser.tsx` for Canvas, Mission Control, Kanban cards, Security, Host Economy | ☐      |
| Desktop bundle size after `@cedar-policy/cedar-wasm` (P8) | Compare packaged size with v1.0.16                                                | ☐      |

## 2. Unit and integration tests by phase

| Phase   | What the tests must prove                                                                                                                                                     | File                                             | Written | Passing    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------- | ---------- |
| P1      | Ledger chains (genesis → prev hash), signs with Ed25519, `verify` reports intact, tampering a payload breaks it at the right `seq`, export carries the public key             | `apps/server/src/ledger/Layers/Ledger.test.ts`   | ✅      | ✅ (local) |
| P1      | Handles: same content → same handle, line ranges, unknown handle → null                                                                                                       | same                                             | ✅      | ✅ (local) |
| P1      | Migration 136 replays with every legacy lineage                                                                                                                               | `apps/server/src/persistence/Migrations.test.ts` | ✅      | ✅ (local) |
| P2      | Spec: valid DAG + depths; rejects cycle, unknown endpoint, self edge, duplicate edge, depth over budget, bad schema, bad YAML; YAML round trip                                | `apps/server/src/flow/flowSpec.test.ts`          | ✅      | ✅ (local) |
| P2      | Scheduler: root first, siblings promoted together but started up to `maxParallel`, hold edge waits for approval, complete, breaker, stuck behind failure, paused does nothing | `apps/server/src/flow/flowDecision.test.ts`      | ✅      | ✅ (local) |
| P2      | Flow repository: create run, node rows, revision conflict rejected, list active runs                                                                                          | `persistence/Layers/FlowRepository.test.ts`      | ☐       | ☐          |
| P2      | Flow service: start spawns root node threads, settled node promotes children, cancel stops nodes, recovery resumes running flows after restart                                | `flow/Layers/FlowService.test.ts`                | ☐       | ☐          |
| P3      | Gate runner: exit 0 / non-zero / timeout, protected path edit forces `gate_hold`, evidence stored as handle                                                                   | —                                                | ☐       | ☐          |
| P3      | Modes: manual, gate_hold, auto_refix up to `maxRefix` then needs_you, autopilot; breaker; Kill < 2 s                                                                          | —                                                | ☐       | ☐          |
| P4      | Gateway tools `saint_flow_start/status/done`; handoff with a missing field is rejected; child capabilities ⊆ parent                                                           | —                                                | ☐       | ☐          |
| P5      | SAP: act schema, deterministic resolver answers without the receiver, `max_hops`, loop hash stop, CLAIM without handle → unverified                                           | —                                                | ☐       | ☐          |
| P6      | Fork & Continue: deterministic snapshot, no summary of a summary, lineage recorded                                                                                            | —                                                | ☐       | ☐          |
| P7      | Quota: switch / ask / wait; never downgrades `dataTerms`                                                                                                                      | —                                                | ☐       | ☐          |
| P8      | Sandbox blocks `~/.ssh` (macOS-only test), egress proxy allow/deny on a real socket, Cedar decisions, taint + Rule of Two, tripwire canary → Kill                             | —                                                | ☐       | ☐          |
| P9      | Host metrics sampling, hibernate/resume, admission thresholds, MCP Hub shares one server                                                                                      | —                                                | ☐       | ☐          |
| P10–P12 | Canvas layout (diamond, parallel branches, orphan), Kanban flow cards, Security alerts, Host Economy rows                                                                     | —                                                | ☐       | ☐          |

## 3. Live verification on an isolated instance (`/verify`, run once at the end)

Use a separate `SAINT_HOME` and free ports (see `.claude/skills/verify/SKILL.md`). Never use `~/.saint` or reset the user's database.

| #   | Scenario                                                   | Expected                                                                                           | Status |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| L1  | Server starts on a fresh home                              | Migrations through the last new one apply; no startup errors                                       | ☐      |
| L2  | Server starts on a copy of an existing v1.0.16 database    | New migrations apply; existing threads, Kanban, Hubs unchanged                                     | ☐      |
| L3  | Run the 3-node template flow with gate `bun run typecheck` | Node 2 starts only after gate 1 is green                                                           | ☐      |
| L4  | Make gate 2 fail                                           | auto_refix sends the failure back; after `maxRefix` the node is "needs you"                        | ☐      |
| L5  | Hold edge                                                  | Flow waits; Approve on the card or Canvas moves it on                                              | ☐      |
| L6  | Agent edits a protected test file                          | Node held at gate_hold; Security alert "Gate file edited"                                          | ☐      |
| L7  | `saint_ask` a deterministic question                       | Answered by Saint with 0 tokens on the receiver                                                    | ☐      |
| L8  | Context ≥ 70% or manual Fork                               | New clean session with snapshot; lineage visible                                                   | ☐      |
| L9  | Simulated rate limit                                       | `on_quota` behaviour matches the node setting                                                      | ☐      |
| L10 | Agent reads the decoy credentials                          | Flow killed in < 2 s, tokens revoked, worktree frozen, alert raised                                | ☐      |
| L11 | Agent reaches an unlisted domain                           | "New domain" Allow/Deny card; default deny                                                         | ☐      |
| L12 | Idle agent > threshold                                     | Hibernated; a new message wakes it and resumes the session                                         | ☐      |
| L13 | Ledger                                                     | Security shows "chain intact · N events"; Export downloads JSONL                                   | ☐      |
| L14 | Screens S4–S8 in light and dark                            | Match the authorized layout, built from existing components; screenshots in the PR                 | ☐      |
| L15 | Stable and Beta builds                                     | Same behaviour; with no flow and sandbox off, existing threads and Kanban behave exactly as before | ☐      |

## 4. Known gaps to report

- Windows has no OS sandbox: L2+ autonomy and auto-approve stay locked there.
- macOS sandbox tests cannot run on the Linux dev machine; they run on macOS CI or a Mac.
- Provider resume after hibernation must be confirmed per provider; providers that cannot resume are excluded.
