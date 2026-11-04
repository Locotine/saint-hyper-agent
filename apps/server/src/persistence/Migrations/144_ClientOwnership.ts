/**
 * Records which remote desktop (client id) a project, space or task belongs to on a server shared by
 * several desktops (`apps/server/src/clientScope.ts`). Additive: null rows are unowned, which an
 * unscoped server ignores and a scoped one hides.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_projects", "owner_client_id"))) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN owner_client_id TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_spaces", "owner_client_id"))) {
    yield* sql`ALTER TABLE projection_spaces ADD COLUMN owner_client_id TEXT`;
  }
  // A partial schema (a migration test) may not have the todos table yet.
  if (
    (yield* tableExists(sql, "todos")) &&
    !(yield* columnExists(sql, "todos", "owner_client_id"))
  ) {
    yield* sql`ALTER TABLE todos ADD COLUMN owner_client_id TEXT`;
  }
});
