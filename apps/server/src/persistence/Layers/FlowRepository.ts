import { FlowNodeRun, FlowRun } from "@saint/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import { FlowRepository, type FlowRepositoryShape } from "../Services/FlowRepository.ts";

type RecordRow = { readonly recordJson: string };
const FlowRunJson = Schema.fromJsonString(FlowRun);
const FlowNodeRunJson = Schema.fromJsonString(FlowNodeRun);
const decodeRun = Schema.decodeUnknownEffect(FlowRunJson);
const decodeNode = Schema.decodeUnknownEffect(FlowNodeRunJson);
const encodeRun = Schema.encodeEffect(FlowRunJson);
const encodeNode = Schema.encodeEffect(FlowNodeRunJson);

const mapError = (operation: string) =>
  Effect.mapError(
    toPersistenceSqlOrDecodeError(
      `FlowRepository.${operation}:query`,
      `FlowRepository.${operation}:decode`,
    ),
  );

const makeFlowRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertNode = (node: FlowNodeRun) =>
    encodeNode(node).pipe(
      Effect.flatMap(
        (recordJson) => sql`
          INSERT INTO flow_nodes (flow_id, node_id, status, thread_id, revision, record_json)
          VALUES (${node.flowId}, ${node.nodeId}, ${node.status}, ${node.threadId}, ${node.revision}, ${recordJson})
        `,
      ),
    );

  const create: FlowRepositoryShape["create"] = (run, nodes) =>
    Effect.gen(function* () {
      const recordJson = yield* encodeRun(run);
      yield* sql`
        INSERT INTO flow_runs (flow_id, project_id, status, revision, record_json, created_at, updated_at)
        VALUES (${run.id}, ${run.projectId}, ${run.status}, ${run.revision}, ${recordJson},
          ${run.createdAt}, ${run.updatedAt})
      `;
      yield* Effect.forEach(nodes, insertNode, { discard: true });
    }).pipe(sql.withTransaction, mapError("create"));

  const get: FlowRepositoryShape["get"] = (flowId) =>
    Effect.gen(function* () {
      const runRows = yield* sql<RecordRow>`
        SELECT record_json AS "recordJson" FROM flow_runs WHERE flow_id = ${flowId}
      `;
      if (!runRows[0]) return null;
      const run = yield* decodeRun(runRows[0].recordJson);
      const nodeRows = yield* sql<RecordRow>`
        SELECT record_json AS "recordJson" FROM flow_nodes WHERE flow_id = ${flowId}
      `;
      const nodes = yield* Effect.forEach(nodeRows, (row) => decodeNode(row.recordJson));
      const approvals = yield* sql<{ edgeKey: string }>`
        SELECT edge_key AS "edgeKey" FROM flow_edge_approvals WHERE flow_id = ${flowId}
      `;
      return { run, nodes, approvedEdges: new Set(approvals.map((row) => row.edgeKey)) };
    }).pipe(mapError("get"));

  const list: FlowRepositoryShape["list"] = ({ projectId, statuses }) =>
    sql<RecordRow & { status: string; projectId: string }>`
      SELECT record_json AS "recordJson", status, project_id AS "projectId"
      FROM flow_runs
      ORDER BY created_at DESC
    `.pipe(
      // ponytail: filters in memory; add indexed WHERE clauses once a host keeps thousands of runs.
      Effect.map((rows) =>
        rows.filter(
          (row) =>
            (projectId === undefined || row.projectId === projectId) &&
            (statuses === undefined || statuses.includes(row.status as FlowRun["status"])),
        ),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRun(row.recordJson))),
      mapError("list"),
    );

  const saveRun: FlowRepositoryShape["saveRun"] = (run) =>
    Effect.gen(function* () {
      const recordJson = yield* encodeRun(run);
      const updated = yield* sql<{ flowId: string }>`
        UPDATE flow_runs
        SET status = ${run.status}, revision = ${run.revision}, record_json = ${recordJson},
          updated_at = ${run.updatedAt}
        WHERE flow_id = ${run.id} AND revision = ${run.revision - 1}
        RETURNING flow_id AS "flowId"
      `;
      return updated.length > 0;
    }).pipe(mapError("saveRun"));

  const saveNode: FlowRepositoryShape["saveNode"] = (node) =>
    Effect.gen(function* () {
      const recordJson = yield* encodeNode(node);
      const updated = yield* sql<{ nodeId: string }>`
        UPDATE flow_nodes
        SET status = ${node.status}, thread_id = ${node.threadId}, revision = ${node.revision},
          record_json = ${recordJson}
        WHERE flow_id = ${node.flowId} AND node_id = ${node.nodeId}
          AND revision = ${node.revision - 1}
        RETURNING node_id AS "nodeId"
      `;
      return updated.length > 0;
    }).pipe(mapError("saveNode"));

  const approveEdge: FlowRepositoryShape["approveEdge"] = (input) =>
    sql`
      INSERT INTO flow_edge_approvals (flow_id, edge_key, approved_by, approved_at)
      VALUES (${input.flowId}, ${input.edgeKey}, ${input.approvedBy}, ${input.approvedAt})
      ON CONFLICT (flow_id, edge_key) DO NOTHING
    `.pipe(Effect.asVoid, mapError("approveEdge"));

  const findNodeByThread: FlowRepositoryShape["findNodeByThread"] = (threadId) =>
    sql<RecordRow>`
      SELECT record_json AS "recordJson" FROM flow_nodes WHERE thread_id = ${threadId}
    `.pipe(
      Effect.flatMap((rows) => (rows[0] ? decodeNode(rows[0].recordJson) : Effect.succeed(null))),
      mapError("findNodeByThread"),
    );

  return {
    create,
    get,
    list,
    saveRun,
    saveNode,
    approveEdge,
    findNodeByThread,
  } satisfies FlowRepositoryShape;
});

export const FlowRepositoryLive = Layer.effect(FlowRepository, makeFlowRepository);
