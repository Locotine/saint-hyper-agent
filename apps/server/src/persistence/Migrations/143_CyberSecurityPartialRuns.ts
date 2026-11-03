import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The steps a run was limited to (`audit:<area>`, `scanner:<id>`) as JSON; NULL is a full run.
  if (!(yield* columnExists(sql, "cyber_security_assessments", "steps_json"))) {
    yield* sql`ALTER TABLE cyber_security_assessments ADD COLUMN steps_json TEXT`;
  }
});
