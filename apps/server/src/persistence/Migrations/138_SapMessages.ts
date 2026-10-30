import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Agent-to-agent messages of a flow. The record is the decoded SapMessage; the columns are
  // what the bus looks messages up by.
  yield* sql`
    CREATE TABLE IF NOT EXISTS sap_messages (
      message_id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      to_node TEXT NOT NULL,
      state TEXT NOT NULL,
      loop_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sap_messages_flow ON sap_messages (flow_id, created_at)
  `;
});
