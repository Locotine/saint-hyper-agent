import type { ProjectResolveWorkspaceFileReferencesResult } from "@saint/contracts";

import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

import { projectApiFor } from "./projectReactQuery";

const MAX_WORKSPACE_FILE_REFERENCE_BATCH_SIZE = 128;

type PendingWorkspaceFileReference = {
  readonly relativePath: string;
  readonly resolve: (relativePath: string | null) => void;
  readonly reject: (cause: unknown) => void;
};

const pendingByCwd = new Map<string, PendingWorkspaceFileReference[]>();
const scheduledCwds = new Set<string>();

// Batches are per host and workspace: the same path on two hosts is two files.
const batchKey = (hostId: HostId, cwd: string) => `${hostId}\0${cwd}`;

async function requestWorkspaceFileReferenceChunks(
  hostId: HostId,
  cwd: string,
  uniquePaths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string | null>> {
  const api = projectApiFor(hostId);
  const resolvedByPath = new Map<string, string | null>();
  for (
    let offset = 0;
    offset < uniquePaths.length;
    offset += MAX_WORKSPACE_FILE_REFERENCE_BATCH_SIZE
  ) {
    const relativePaths = uniquePaths.slice(
      offset,
      offset + MAX_WORKSPACE_FILE_REFERENCE_BATCH_SIZE,
    );
    const result: ProjectResolveWorkspaceFileReferencesResult =
      await api.projects.resolveWorkspaceFileReferences({ cwd, relativePaths });
    if (result.relativePaths.length !== relativePaths.length) {
      throw new Error("Workspace file reference response length did not match the request.");
    }
    relativePaths.forEach((relativePath, index) => {
      resolvedByPath.set(relativePath, result.relativePaths[index] ?? null);
    });
  }
  return resolvedByPath;
}

async function flushWorkspaceFileReferenceBatch(hostId: HostId, cwd: string): Promise<void> {
  const key = batchKey(hostId, cwd);
  scheduledCwds.delete(key);
  const pending = pendingByCwd.get(key) ?? [];
  pendingByCwd.delete(key);
  if (pending.length === 0) {
    return;
  }

  try {
    const uniquePaths = [...new Set(pending.map((entry) => entry.relativePath))];
    const resolvedByPath = await requestWorkspaceFileReferenceChunks(hostId, cwd, uniquePaths);
    pending.forEach((entry) => entry.resolve(resolvedByPath.get(entry.relativePath) ?? null));
  } catch (cause) {
    pending.forEach((entry) => entry.reject(cause));
  }
}

export function resolveWorkspaceFileReferenceBatched(input: {
  cwd: string;
  relativePath: string;
  hostId?: HostId;
}): Promise<string | null> {
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  const key = batchKey(hostId, input.cwd);
  return new Promise((resolve, reject) => {
    const pending = pendingByCwd.get(key);
    const entry = { relativePath: input.relativePath, resolve, reject };
    if (pending) {
      pending.push(entry);
    } else {
      pendingByCwd.set(key, [entry]);
    }
    if (!scheduledCwds.has(key)) {
      scheduledCwds.add(key);
      queueMicrotask(() => void flushWorkspaceFileReferenceBatch(hostId, input.cwd));
    }
  });
}
