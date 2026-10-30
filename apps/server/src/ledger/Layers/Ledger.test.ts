import { FlowRunId, type LedgerHandle } from "@saint/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { Ledger } from "../Services/Ledger.ts";
import { LEDGER_GENESIS_HASH, LedgerLive } from "./Ledger.ts";

const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const TestSecretStore = Layer.succeed(ServerSecretStore, {
  get: () => Effect.succeed(seed),
  set: () => Effect.void,
  getOrCreateRandom: () => Effect.succeed(seed),
  remove: () => Effect.void,
});

const layer = it.layer(
  LedgerLive.pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(TestSecretStore)),
);

const flowId = FlowRunId.makeUnsafe("flow-1");

layer("Ledger", (it) => {
  it.effect("chains, signs, verifies and detects tampering", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const sql = yield* SqlClient.SqlClient;

      const first = yield* ledger.append({
        kind: "flow.started",
        actor: "user",
        flowId,
        payload: { nodes: 2 },
      });
      const second = yield* ledger.append({
        kind: "node.settled",
        actor: "saint",
        flowId,
        nodeId: "architect",
        payload: { gate: "pass" },
      });
      yield* ledger.append({ kind: "other", actor: "saint", payload: null });

      assert.strictEqual(first.prevHash, LEDGER_GENESIS_HASH);
      assert.strictEqual(second.prevHash, first.hash);
      assert.deepStrictEqual(
        (yield* ledger.listByFlow(flowId)).map((event) => event.kind),
        ["flow.started", "node.settled"],
      );
      assert.deepStrictEqual(
        (yield* ledger.listByFlow(flowId, first.seq)).map((event) => event.seq),
        [second.seq],
      );
      assert.deepStrictEqual(yield* ledger.verify(), { intact: true, count: 3, brokenAtSeq: null });

      const exported = (yield* ledger.exportJsonl()).split("\n");
      assert.strictEqual(exported.length, 4);
      assert.include(exported[0]!, "PUBLIC KEY");

      yield* sql`UPDATE ledger_events SET payload_json = '{"gate":"fail"}' WHERE seq = ${second.seq}`;
      assert.deepStrictEqual(yield* ledger.verify(), {
        intact: false,
        count: 3,
        brokenAtSeq: second.seq,
      });
    }),
  );

  it.effect("stores content once per hash and reads line ranges", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const content = ["line 1", "line 2", "line 3", "line 4"].join("\n");
      const input = {
        kind: "ev",
        content,
        mime: "text/plain",
        provenance: "gate:g7",
        taint: "internal" as const,
        createdBy: "saint",
      };

      const handle = yield* ledger.putHandle(input);
      assert.match(handle, /^ev:[0-9a-f]{12}$/);
      assert.strictEqual(yield* ledger.putHandle(input), handle);

      const range = yield* ledger.getHandle(handle, { from: 2, to: 3 });
      assert.strictEqual(range?.content, "line 2\nline 3");
      assert.strictEqual(range?.totalLines, 4);
      assert.strictEqual(range?.taint, "internal");
      assert.strictEqual((yield* ledger.getHandle(handle))?.content, content);
      assert.isNull(yield* ledger.getHandle("ev:000000000000" as LedgerHandle));
    }),
  );
});
