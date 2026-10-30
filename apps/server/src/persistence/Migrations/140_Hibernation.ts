import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Agents Saint put to sleep. The provider binding keeps the resume cursor; this row only says
  // the stop was a hibernation, so the agent shows as such and wakes on its next message.
  yield* sql`
    CREATE TABLE IF NOT EXISTS economy_hibernation (
      thread_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      reason TEXT NOT NULL,
      hibernated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS economy_settings (
      setting_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
