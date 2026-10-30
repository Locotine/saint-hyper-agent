import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Append-only, hash-chained and signed: this table is both the flow event store and the
  // audit log. Rows are never updated or deleted.
  yield* sql`
    CREATE TABLE IF NOT EXISTS ledger_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      flow_id TEXT,
      node_id TEXT,
      payload_json TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      sig TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ledger_events_flow
    ON ledger_events (flow_id, seq)
    WHERE flow_id IS NOT NULL
  `;
  // Content-addressed blobs (diffs, gate logs, plans) that messages point at instead of pasting.
  yield* sql`
    CREATE TABLE IF NOT EXISTS ledger_handles (
      handle TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      provenance TEXT NOT NULL,
      taint TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      blob BLOB NOT NULL
    )
  `;
});
