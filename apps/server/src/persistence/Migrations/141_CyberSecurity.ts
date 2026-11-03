import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Deliberately no projection_projects foreign key: assessments are a durable pre-production
  // record that must survive projection repair, like project_pull_request_pins.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cyber_security_assessments (
      assessment_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      flow_id TEXT,
      verdict TEXT NOT NULL,
      threshold TEXT NOT NULL,
      inventory_json TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      ingested INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cyber_security_assessments_project
    ON cyber_security_assessments (project_id, started_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cyber_security_findings (
      finding_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      assessment_id TEXT NOT NULL,
      title TEXT NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      file TEXT,
      line INTEGER,
      detail TEXT NOT NULL,
      fix TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      fix_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cyber_security_findings_project
    ON cyber_security_findings (project_id, assessment_id)
  `;
});
