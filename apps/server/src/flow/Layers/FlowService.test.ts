import {
  ProjectId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type ThreadId,
} from "@saint/contracts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { afterAll } from "vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { LedgerLive } from "../../ledger/Layers/Ledger.ts";
import { Ledger } from "../../ledger/Services/Ledger.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { FlowRepositoryLive } from "../../persistence/Layers/FlowRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { Aegis, type AegisShape } from "../../aegis/Services/Aegis.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../../provider/Services/ProviderDiscoveryService.ts";
import { FlowService } from "../Services/FlowService.ts";
import { FlowServiceLive } from "./FlowService.ts";

const dispatched: OrchestrationCommand[] = [];
const turns = new Map<string, OrchestrationLatestTurn["state"]>();
const turnSeq = new Map<string, number>();
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "saint-flow-gate-"));
execFileSync("git", ["init", "-q"], { cwd: projectDir });
fs.mkdirSync(path.join(projectDir, "test"));
fs.writeFileSync(path.join(projectDir, "test", "a.spec.ts"), "expect(1)\n");
for (const args of [
  ["add", "."],
  ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"],
]) {
  execFileSync("git", args, { cwd: projectDir });
}
afterAll(() => fs.rmSync(projectDir, { recursive: true, force: true }));
/** A new turn on the thread finished in `state`. */
const finishTurn = (threadId: string, state: OrchestrationLatestTurn["state"]) => {
  turnSeq.set(threadId, (turnSeq.get(threadId) ?? 0) + 1);
  turns.set(threadId, state);
};

/** When set, the engine refuses every thread.create with this message. */
let refuseThreadCreate: string | null = null;
const engine = {
  dispatch: (command: OrchestrationCommand) =>
    command.type === "thread.create" && refuseThreadCreate
      ? Effect.fail(new Error(refuseThreadCreate))
      : Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
  streamDomainEvents: Stream.never,
  getReadModel: () => Effect.succeed({ threads: [] }),
} as unknown as OrchestrationEngineShape;

const snapshotQuery = {
  getThreadShellById: (threadId: ThreadId) =>
    Effect.succeed(
      turns.has(threadId)
        ? Option.some({
            latestTurn: {
              turnId: TurnId.makeUnsafe(`turn-${threadId}-${turnSeq.get(threadId) ?? 0}`),
              state: turns.get(threadId)!,
              requestedAt: "2026-10-29T10:00:00.000Z",
              startedAt: null,
              completedAt: null,
              assistantMessageId: null,
            },
          })
        : Option.none(),
    ),
  getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot: projectDir })),
} as unknown as ProjectionSnapshotQueryShape;

const discovery = {
  listModels: () =>
    Effect.succeed({
      models: [{ slug: "claude-sonnet-5", name: "Sonnet 5", supportsAutoMode: true }],
    }),
} as unknown as ProviderDiscoveryServiceShape;

const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
const layer = it.layer(
  FlowServiceLive.pipe(
    Layer.provideMerge(Layer.succeed(ProviderDiscoveryService, discovery)),
    Layer.provideMerge(FlowRepositoryLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    Layer.provideMerge(
      Layer.succeed(ServerSecretStore, {
        get: () => Effect.succeed(seed),
        set: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(seed),
        remove: () => Effect.void,
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const spec = `
version: flow-v1
name: Rate limit
nodes:
  - { id: architect, role: Architect, prompt: Plan it }
  - { id: coder, role: Coder, prompt: Build it }
  - { id: qa, role: QA, prompt: Check it }
edges:
  - { from: architect, to: coder }
  - { from: coder, to: qa, policy: hold }
`;

const startedThreads = () =>
  dispatched.flatMap((command) => (command.type === "thread.create" ? [command.threadId] : []));

layer("FlowService", (it) => {
  it.effect(
    "runs a chain: spawns, settles, holds, approves, completes, and logs to the ledger",
    () =>
      Effect.gen(function* () {
        const flows = yield* FlowService;
        const ledger = yield* Ledger;
        dispatched.length = 0;

        const started = yield* flows.start({
          projectId: ProjectId.makeUnsafe("project-1"),
          spec,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          startedBy: "user",
        });
        const flowId = started.run.id;
        const status = (id: string) =>
          flows
            .get(flowId)
            .pipe(Effect.map((view) => view!.nodes.find((n) => n.nodeId === id)!.status));

        assert.strictEqual(startedThreads().length, 1, "only the root starts");
        assert.strictEqual(yield* status("architect"), "running");
        const turnStart = dispatched.find((command) => command.type === "thread.turn.start");
        assert.include(
          turnStart?.type === "thread.turn.start" ? turnStart.message.text : "",
          'the "Architect" step',
        );

        // A running turn changes nothing; a completed one settles and starts the child.
        const architectThread = startedThreads()[0]!;
        turns.set(architectThread, "running");
        yield* flows.reconcileThread(architectThread);
        assert.strictEqual(yield* status("architect"), "running");
        turns.set(architectThread, "completed");
        yield* flows.reconcileThread(architectThread);
        yield* flows.reconcileThread(architectThread);
        assert.strictEqual(yield* status("architect"), "settled");
        assert.strictEqual(startedThreads().length, 2);

        // The coder settles; QA waits behind the hold edge until approved.
        turns.set(startedThreads()[1]!, "completed");
        yield* flows.reconcileThread(startedThreads()[1]!);
        assert.strictEqual(yield* status("qa"), "blocked");
        yield* flows.approveEdge({ flowId, from: "coder", to: "qa", by: "user" });
        assert.strictEqual(yield* status("qa"), "running");

        turns.set(startedThreads()[2]!, "completed");
        yield* flows.reconcileThread(startedThreads()[2]!);
        assert.strictEqual((yield* flows.get(flowId))!.run.status, "completed");

        const kinds = (yield* ledger.listByFlow(flowId)).map((event) => event.kind);
        assert.deepStrictEqual(kinds.slice(0, 3), ["flow.started", "node.started", "node.settled"]);
        assert.include(kinds, "edge.approved");
        assert.strictEqual(kinds.at(-1), "flow.completed");
        assert.isTrue((yield* ledger.verify()).intact);
      }),
  );

  it.effect("fails a node on an errored turn and cancels by interrupting running nodes", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      dispatched.length = 0;
      const { run } = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      const root = startedThreads()[0]!;
      turns.set(root, "error");
      yield* flows.reconcileThread(root);
      const failed = (yield* flows.get(run.id))!;
      assert.strictEqual(failed.nodes.find((n) => n.nodeId === "architect")!.status, "failed");
      assert.strictEqual(failed.run.status, "failed");

      dispatched.length = 0;
      const second = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      yield* flows.cancel(second.run.id, "user");
      assert.strictEqual((yield* flows.get(second.run.id))!.run.status, "cancelled");
      assert.isTrue(dispatched.some((command) => command.type === "thread.turn.interrupt"));
    }),
  );

  it.effect("rejects an invalid spec", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      const result = yield* flows
        .start({
          projectId: ProjectId.makeUnsafe("project-1"),
          spec: "version: flow-v1\nname: x\nnodes: [{ id: a, role: A, prompt: p }]\nedges: [{ from: a, to: a }]",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          startedBy: "user",
        })
        .pipe(Effect.flip);
      assert.include(result.message, "itself");
    }),
  );

  it.effect("gates a node: refix on the same thread, then settle, with evidence", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      const ledger = yield* Ledger;
      dispatched.length = 0;
      fs.rmSync(path.join(projectDir, "ok.txt"), { force: true });
      const { run } = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec: `
version: flow-v1
name: gated
nodes:
  - id: coder
    role: Coder
    prompt: Build it
    mode: auto_refix
    maxRefix: 1
    gate: { id: g1, cmd: "test -f ok.txt" }
edges: []
`,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      const thread = startedThreads()[0]!;
      const node = () => flows.get(run.id).pipe(Effect.map((view) => view!.nodes[0]!));

      finishTurn(thread, "completed");
      yield* flows.reconcileThread(thread);
      assert.strictEqual((yield* node()).status, "running", "refix keeps the node running");
      assert.strictEqual((yield* node()).attempts, 2);
      assert.strictEqual(startedThreads().length, 1, "refix reuses the thread");
      const refix = dispatched.at(-1);
      assert.include(refix?.type === "thread.turn.start" ? refix.message.text : "", "refix 1/1");
      const evidence = (yield* node()).lastGate!.evidence;
      assert.isFalse((yield* node()).lastGate!.passed);
      assert.isNotNull(yield* ledger.getHandle(evidence));

      // The same stale turn is ignored; the next turn passes once the file exists.
      yield* flows.reconcileThread(thread);
      assert.strictEqual((yield* node()).attempts, 2);
      fs.writeFileSync(path.join(projectDir, "ok.txt"), "ok");
      finishTurn(thread, "completed");
      yield* flows.reconcileThread(thread);
      assert.strictEqual((yield* node()).status, "settled");
      assert.strictEqual((yield* flows.get(run.id))!.run.status, "completed");
      const kinds = (yield* ledger.listByFlow(run.id)).map((event) => event.kind);
      assert.includeMembers(kinds, ["gate.started", "gate.finished", "node.refix", "node.settled"]);
    }),
  );

  it.effect("holds a protected test edit for review, then approve, retry and killAll", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      dispatched.length = 0;
      const { run } = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec: `
version: flow-v1
name: protected
nodes:
  - id: coder
    role: Coder
    prompt: Build it
    mode: auto_refix
    gate: { id: g1, cmd: "true", protectedPaths: ["test/**"] }
  - { id: docs, role: Docs, prompt: Write docs }
edges: [{ from: coder, to: docs }]
`,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      const thread = startedThreads()[0]!;
      fs.writeFileSync(path.join(projectDir, "test", "a.spec.ts"), "// skipped\n");
      finishTurn(thread, "completed");
      yield* flows.reconcileThread(thread);
      const held = (yield* flows.get(run.id))!.nodes.find((n) => n.nodeId === "coder")!;
      assert.strictEqual(held.status, "needs_you");
      assert.include(held.statusReason ?? "", "test/a.spec.ts");

      yield* flows.approveNode({ flowId: run.id, nodeId: "coder", by: "user" });
      const after = (yield* flows.get(run.id))!;
      assert.strictEqual(after.nodes.find((n) => n.nodeId === "coder")!.status, "settled");
      assert.strictEqual(after.nodes.find((n) => n.nodeId === "docs")!.status, "running");

      // A manual node whose turn fails can be retried in a fresh thread.
      const docsThread = startedThreads().at(-1)!;
      finishTurn(docsThread, "error");
      yield* flows.reconcileThread(docsThread);
      assert.strictEqual((yield* flows.get(run.id))!.run.status, "failed");
      yield* flows.retryNode({ flowId: run.id, nodeId: "docs", by: "user" });
      const retried = (yield* flows.get(run.id))!;
      assert.strictEqual(retried.run.status, "running");
      assert.notStrictEqual(retried.nodes.find((n) => n.nodeId === "docs")!.threadId, docsThread);

      assert.isAtLeast(yield* flows.killAll("user"), 1);
      assert.strictEqual((yield* flows.get(run.id))!.run.status, "cancelled");
      assert.isEmpty(yield* flows.list({ statuses: ["running", "paused"] }));
    }),
  );

  it.effect("a Claude step takes its Auto flag from discovery, not the saved selection", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      dispatched.length = 0;
      yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec,
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
        runtimeMode: "auto",
        startedBy: "user",
      });
      const create = dispatched.find((command) => command.type === "thread.create");
      assert.deepInclude(create?.modelSelection ?? {}, { supportsAutoMode: true });
      yield* flows.killAll("user");
    }),
  );

  it.effect(
    "applies per-node model options without leaking to other nodes and rejects invalid options",
    () =>
      Effect.gen(function* () {
        const flows = yield* FlowService;
        dispatched.length = 0;
        const started = yield* flows.start({
          projectId: ProjectId.makeUnsafe("project-1"),
          spec: `
version: flow-v1
name: Per-node options
nodes:
  - id: exec
    role: Executor
    provider: antigravity
    model: Gemini 4 Argon
    options: { reasoningEffort: medium }
    prompt: Build it
  - id: options-only
    role: Tuner
    options: { reasoningEffort: high }
    prompt: Tune it
  - id: same-provider-same-model
    role: SameModelTuner
    model: gpt-5-codex
    options: { reasoningEffort: low }
    prompt: Tune same model
  - id: same-provider-different-model
    role: DiffModelTuner
    model: gpt-5.5
    options: { reasoningEffort: low }
    prompt: Tune different model
  - id: provider-only
    role: ProviderDefault
    provider: claudeAgent
    options: { effort: medium }
    prompt: Use provider default
  - id: inherit-run
    role: Reviewer
    prompt: Review it
edges:
  - { from: exec, to: options-only }
  - { from: options-only, to: same-provider-same-model }
  - { from: same-provider-same-model, to: same-provider-different-model }
  - { from: same-provider-different-model, to: provider-only }
  - { from: provider-only, to: inherit-run }
`,
          modelSelection: {
            provider: "codex",
            instanceId: "codex-work" as never,
            model: "gpt-5-codex",
            options: { fastMode: true },
          },
          runtimeMode: "full-access",
          startedBy: "user",
        });
        void started;
        const execCreate = dispatched.find((command) => command.type === "thread.create");
        assert.deepStrictEqual(
          execCreate?.type === "thread.create" ? execCreate.modelSelection : null,
          {
            provider: "antigravity",
            instanceId: "antigravity",
            model: "Gemini 4 Argon",
            options: { reasoningEffort: "medium" },
          },
        );

        for (let idx = 0; idx < 5; idx += 1) {
          const thread = startedThreads()[idx]!;
          turns.set(thread, "completed");
          yield* flows.reconcileThread(thread);
        }

        const creates = dispatched.filter((command) => command.type === "thread.create");
        assert.strictEqual(creates.length, 6);
        // (a) Neither provider nor model set -> merges run options + node options
        assert.deepStrictEqual(
          creates[1]?.type === "thread.create" ? creates[1].modelSelection : null,
          {
            provider: "codex",
            instanceId: "codex-work",
            model: "gpt-5-codex",
            options: { fastMode: true, reasoningEffort: "high" },
          },
        );
        // (b) Resulting provider AND model equal the run's -> merges run options + node options
        assert.deepStrictEqual(
          creates[2]?.type === "thread.create" ? creates[2].modelSelection : null,
          {
            provider: "codex",
            instanceId: "codex-work",
            model: "gpt-5-codex",
            options: { fastMode: true, reasoningEffort: "low" },
          },
        );
        // (c1) Different model on same provider -> uses only spec.options (does not inherit fastMode)
        assert.deepStrictEqual(
          creates[3]?.type === "thread.create" ? creates[3].modelSelection : null,
          {
            provider: "codex",
            instanceId: "codex",
            model: "gpt-5.5",
            options: { reasoningEffort: "low" },
          },
        );
        // (c2) Provider-only -> uses provider default model and only spec.options
        assert.deepStrictEqual(
          creates[4]?.type === "thread.create" ? creates[4].modelSelection : null,
          {
            provider: "claudeAgent",
            instanceId: "claudeAgent",
            model: "claude-sonnet-5",
            options: { effort: "medium" },
            supportsAutoMode: true,
          },
        );
        // Unmodified node -> inherits run.modelSelection unchanged
        assert.deepStrictEqual(
          creates[5]?.type === "thread.create" ? creates[5].modelSelection : null,
          {
            provider: "codex",
            instanceId: "codex-work",
            model: "gpt-5-codex",
            options: { fastMode: true },
          },
        );
        yield* flows.killAll("user");

        dispatched.length = 0;
        const invalidErr = yield* flows
          .start({
            projectId: ProjectId.makeUnsafe("project-1"),
            spec: `
version: flow-v1
name: Bad options
nodes:
  - id: bad
    role: Bad
    provider: claudeAgent
    model: opus
    options: { effort: extreme-invalid }
    prompt: Fail
edges: []
`,
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            startedBy: "user",
          })
          .pipe(Effect.flip);
        assert.include(
          invalidErr.message,
          'Node "bad" names an unknown provider, model, or model options.',
        );

        dispatched.length = 0;
        const typoSpec = `
version: flow-v1
name: Typo option key on downstream node
nodes:
  - id: first
    role: First
    prompt: Start
  - id: bad-key
    role: BadKey
    provider: codex
    model: gpt-5-codex
    options: { reasoningEfort: high }
    prompt: Fail
edges:
  - { from: first, to: bad-key }
`;
        const typoKeyErr = yield* flows
          .start({
            projectId: ProjectId.makeUnsafe("project-1"),
            spec: typoSpec,
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            startedBy: "user",
          })
          .pipe(Effect.flip);
        assert.include(typoKeyErr.message, 'Node "bad-key"');
        assert.include(typoKeyErr.message, "reasoningEfort");
        assert.isEmpty(dispatched);

        const saveTypoErr = yield* flows
          .saveSpec({
            projectId: ProjectId.makeUnsafe("project-1"),
            yaml: typoSpec,
            by: "user",
          })
          .pipe(Effect.flip);
        assert.strictEqual(saveTypoErr.message, typoKeyErr.message);

        // Z4: model-only Claude-style node with effort saves (since provider is not set on the node),
        // and fails at start on a codex run against the run's authoritative provider.
        const modelOnlyClaudeEffortSpec = `
version: flow-v1
name: Model only Claude node with effort
nodes:
  - id: claude-model-only
    role: ClaudeModelOnly
    model: claude-opus-4-6
    options: { effort: high }
    prompt: Run with effort
edges: []
`;
        const savedModelOnlyClaude = yield* flows.saveSpec({
          projectId: ProjectId.makeUnsafe("project-1"),
          yaml: modelOnlyClaudeEffortSpec,
          by: "user",
        });
        assert.strictEqual(
          savedModelOnlyClaude.path,
          "flows/model-only-claude-node-with-effort.yaml",
        );

        dispatched.length = 0;
        const modelOnlyOnCodexErr = yield* flows
          .start({
            projectId: ProjectId.makeUnsafe("project-1"),
            spec: modelOnlyClaudeEffortSpec,
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            startedBy: "user",
          })
          .pipe(Effect.flip);
        assert.strictEqual(
          modelOnlyOnCodexErr.message,
          'Node "claude-model-only" names an unknown provider, model, or model options (unknown option "effort").',
        );
        assert.isEmpty(dispatched);

        // W2: options-only Claude-style node saves without a run selection, and fails at
        // start on a codex run with the shared unknown-option error message.
        const optionsOnlyClaudeSpec = `
version: flow-v1
name: Options only Claude node
nodes:
  - id: claude-opts
    role: ClaudeOpts
    options: { effort: high }
    prompt: Run with effort
edges: []
`;
        const savedOptionsOnly = yield* flows.saveSpec({
          projectId: ProjectId.makeUnsafe("project-1"),
          yaml: optionsOnlyClaudeSpec,
          by: "user",
        });
        assert.strictEqual(savedOptionsOnly.path, "flows/options-only-claude-node.yaml");

        dispatched.length = 0;
        const optionsOnlyOnCodexErr = yield* flows
          .start({
            projectId: ProjectId.makeUnsafe("project-1"),
            spec: optionsOnlyClaudeSpec,
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            startedBy: "user",
          })
          .pipe(Effect.flip);
        assert.strictEqual(
          optionsOnlyOnCodexErr.message,
          'Node "claude-opts" names an unknown provider, model, or model options (unknown option "effort").',
        );
        assert.isEmpty(dispatched);

        // W1: model-only node on an opencode run keeps the run's opencode provider even when
        // the model slug contains "claude".
        dispatched.length = 0;
        yield* flows.start({
          projectId: ProjectId.makeUnsafe("project-1"),
          spec: `
version: flow-v1
name: OpenCode with Claude model slug
nodes:
  - id: oc-step
    role: OpenCodeClaude
    model: anthropic/claude-sonnet-4
    prompt: Build on OpenCode
edges: []
`,
          modelSelection: { provider: "opencode", model: "anthropic/claude-opus-4" },
          runtimeMode: "full-access",
          startedBy: "user",
        });
        const ocCreate = dispatched.find((command) => command.type === "thread.create");
        assert.deepStrictEqual(
          ocCreate?.type === "thread.create" ? ocCreate.modelSelection : null,
          {
            provider: "opencode",
            instanceId: "opencode",
            model: "anthropic/claude-sonnet-4",
          },
        );
        yield* flows.killAll("user");

        const savedGrok = yield* flows.saveSpec({
          projectId: ProjectId.makeUnsafe("project-1"),
          yaml: `
version: flow-v1
name: Grok node spec
nodes:
  - id: grok-step
    role: Grok
    model: grok-4
    prompt: Analyze with Grok
edges: []
`,
          by: "user",
        });
        assert.strictEqual(savedGrok.path, "flows/grok-node-spec.yaml");
      }),
  );

  it.effect("a step whose thread cannot be created waits for the person with the reason", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      dispatched.length = 0;
      refuseThreadCreate = 'Claude model "x" has not been verified to support Auto mode.';
      const started = yield* flows
        .start({
          projectId: ProjectId.makeUnsafe("project-1"),
          spec,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          startedBy: "user",
        })
        .pipe(Effect.ensuring(Effect.sync(() => (refuseThreadCreate = null))));
      const architect = started.nodes.find((n) => n.nodeId === "architect")!;
      assert.strictEqual(architect.status, "needs_you");
      assert.include(architect.statusReason ?? "", "has not been verified to support Auto mode");
      assert.isEmpty(dispatched.filter((command) => command.type === "thread.turn.start"));
      yield* flows.killAll("user");
    }),
  );
});

// Aegis runs its kill handlers inside `kill`, as the real layer does.
const killHandlers: Array<(threadId: ThreadId) => Effect.Effect<void>> = [];
const killed: string[] = [];
const fakeAegis = {
  status: () => Effect.fail(new Error("not needed")),
  capRuntimeMode: (requested: Parameters<AegisShape["capRuntimeMode"]>[0]) =>
    Effect.succeed(requested),
  gateSandbox: () => Effect.succeed(null),
  unpermittedWrites: () => Effect.succeed([]),
  raise: () => Effect.void,
  setPrincipalResolver: () => {},
  onKill: (handler: Parameters<AegisShape["onKill"]>[0]) => {
    killHandlers.push(handler);
  },
  kill: (input: Parameters<AegisShape["kill"]>[0]) =>
    Effect.gen(function* () {
      killed.push(...input.threadIds);
      for (const threadId of input.threadIds) {
        for (const handler of killHandlers) yield* handler(threadId as ThreadId);
      }
      return {} as Effect.Success<ReturnType<AegisShape["kill"]>>;
    }),
} as unknown as AegisShape;

const killLayer = it.layer(
  FlowServiceLive.pipe(
    Layer.provideMerge(Layer.succeed(Aegis, fakeAegis)),
    Layer.provideMerge(FlowRepositoryLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    Layer.provideMerge(
      Layer.succeed(ServerSecretStore, {
        get: () => Effect.succeed(seed),
        set: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(seed),
        remove: () => Effect.void,
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

killLayer("FlowService with Aegis", (it) => {
  it.effect("a flow that fails under the lock stops its other steps without deadlocking", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      killHandlers.length = 0;
      yield* flows.startReactor();
      const started = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec: `
version: flow-v1
name: Breaker
budget: { breakerFailures: 1 }
nodes:
  - { id: one, role: One, prompt: a }
  - { id: two, role: Two, prompt: b }
edges: []
`,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      const [one, two] = ["one", "two"].map(
        (id) => started.nodes.find((n) => n.nodeId === id)!.threadId!,
      );
      finishTurn(one!, "error");
      yield* flows.reconcileThread(one!).pipe(Effect.timeout("2 seconds"));
      assert.include(killed, two);
      assert.strictEqual((yield* flows.get(started.run.id))!.run.status, "failed");
    }).pipe(Effect.scoped),
  );

  it.effect("an Aegis kill of a step from outside cancels its flow", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      killHandlers.length = 0;
      yield* flows.startReactor();
      const aegis = yield* Aegis;
      const started = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      const step = started.nodes.find((n) => n.nodeId === "architect")!.threadId!;
      yield* aegis
        .kill({ threadIds: [step], reason: "tripwire", by: "aegis" })
        .pipe(Effect.timeout("2 seconds"));
      assert.strictEqual((yield* flows.get(started.run.id))!.run.status, "cancelled");
    }).pipe(Effect.scoped),
  );
  it.effect("autopilot hands a step whose gate keeps failing to the next allowed agent", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      const started = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec: `
version: flow-v1
name: Autopilot
allowedProviders: [codex, claudeAgent]
nodes:
  - { id: fix, role: Fixer, prompt: a, mode: autopilot, maxRefix: 0, gate: { id: g, cmd: "false" } }
edges: []
`,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      const thread = started.nodes[0]!.threadId!;
      finishTurn(thread, "completed");
      yield* flows.reconcileThread(thread);
      const node = (yield* flows.get(started.run.id))!.nodes[0]!;
      assert.strictEqual(node.status, "running");
      assert.strictEqual(node.modelOverride?.provider, "claudeAgent");
      assert.deepStrictEqual(node.refixExhausted, ["codex"]);
    }),
  );
});
