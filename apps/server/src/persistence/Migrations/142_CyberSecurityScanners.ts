import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Where a finding came from: `review` (the model's read of the code) or `scanner:<id>`.
  if (!(yield* columnExists(sql, "cyber_security_findings", "source"))) {
    yield* sql`ALTER TABLE cyber_security_findings ADD COLUMN source TEXT NOT NULL DEFAULT 'review'`;
  }

  // One row per scanner per assessment. The assessment's verdict waits until none is pending or
  // running, so a slow scanner can never be reported as a clean repo.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cyber_security_scanner_runs (
      assessment_id TEXT NOT NULL,
      scanner_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      finding_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (assessment_id, scanner_id)
    )
  `;
  // What the person must do before the scanner can run (install a package, allow the network).
  if (!(yield* columnExists(sql, "cyber_security_scanner_runs", "attention"))) {
    yield* sql`ALTER TABLE cyber_security_scanner_runs ADD COLUMN attention TEXT`;
  }
});
