import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The spec is frozen at start: edits on the Canvas apply to the next run, never this one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS flow_runs (
      flow_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_flow_runs_project
    ON flow_runs (project_id, created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS flow_nodes (
      flow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (flow_id, node_id)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_nodes_thread
    ON flow_nodes (thread_id)
    WHERE thread_id IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS flow_edge_approvals (
      flow_id TEXT NOT NULL,
      edge_key TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      PRIMARY KEY (flow_id, edge_key)
    )
  `;
});
