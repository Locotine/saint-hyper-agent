import type { ProjectReadFileResult } from "@saint/contracts";
import { isWorkspaceFileWriteConflictError } from "@saint/shared/workspaceFileWrite";
import type { QueryClient } from "@tanstack/react-query";

import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { apiFor } from "~/hosts/hostApi";
import { ensureLocalNativeApi } from "~/nativeApi";
import { refreshGitAfterFileWrite } from "./gitReactQuery";
import { projectReadFileQueryOptions } from "./projectReactQuery";
import {
  INITIAL_WORKSPACE_FILE_EDITOR_STATE,
  isWorkspaceFileEditorDirty,
  resolveWorkspaceFileEditorFormat,
  workspaceFileEditorKey,
  workspaceFileEditorReducer,
  type WorkspaceFileEditorAction,
} from "./workspaceFileEditor";

export const WORKSPACE_EDITOR_AUTOSAVE_MS = 400;

const sessions = new WeakMap<QueryClient, Map<string, WorkspaceEditorSession>>();

/** One buffer and one writer per file, shared by all editor surfaces. Failed
 * drafts survive panel unmounts; clean, unused sessions are released. */
export class WorkspaceEditorSession {
  private state = INITIAL_WORKSPACE_FILE_EDITOR_STATE;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<boolean> | undefined;
  private paused = false;
  private editGeneration = 0;

  constructor(
    private readonly client: QueryClient,
    readonly cwd: string,
    readonly relativePath: string,
    private readonly release: () => void,
    /** The machine the file lives on: this computer unless it is a connected host's. */
    readonly hostId: HostId = LOCAL_HOST_ID,
  ) {}

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.clearTimer();
      queueMicrotask(() => this.releaseIfUnused());
    };
  };

  private releaseIfUnused() {
    if (this.listeners.size === 0 && !this.writing && !this.dirty) this.release();
  }

  get saving() {
    return this.writing !== undefined;
  }

  get dirty() {
    return isWorkspaceFileEditorDirty(this.state);
  }

  private dispatch(action: WorkspaceFileEditorAction) {
    const next = workspaceFileEditorReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  load(file: ProjectReadFileResult) {
    const format = resolveWorkspaceFileEditorFormat(file);
    if (!format || this.writing) return;
    this.dispatch({
      type: "loaded",
      key: workspaceFileEditorKey(this.cwd, this.relativePath)!,
      contents: file.contents,
      format,
    });
  }

  change = (value: string) => {
    if (value === this.state.value) return;
    this.editGeneration += 1;
    this.dispatch({ type: "changed", value });
    this.schedule();
  };

  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule() {
    this.clearTimer();
    if (this.paused || this.writing || !this.dirty || this.state.saveError || this.state.conflict)
      return;
    this.timer = setTimeout(() => void this.flush(), WORKSPACE_EDITOR_AUTOSAVE_MS);
  }

  pause = () => {
    this.paused = true;
    this.clearTimer();
  };

  resume = () => {
    this.paused = false;
    this.schedule();
  };

  /** Drains edits typed during a write too. Failure retains the draft and stops
   * automatic retries; only an explicit Save/Overwrite retries it. */
  flush = (overwrite = false): Promise<boolean> => {
    this.clearTimer();
    if (this.writing) return this.writing;
    if (this.paused) return Promise.resolve(!this.dirty);
    if (!this.dirty) return Promise.resolve(true);
    this.writing = Promise.resolve()
      .then(async () => {
        let guarded = !overwrite;
        while (this.dirty) {
          const { value, format } = this.state;
          if (!format) return false;
          this.dispatch({ type: "saveStarted" });
          try {
            const api =
              this.hostId === LOCAL_HOST_ID ? ensureLocalNativeApi() : apiFor(this.hostId);
            if (!api) throw new Error("This host is not connected.");
            const result = await api.projects.writeFile({
              cwd: this.cwd,
              relativePath: this.relativePath,
              contents: value,
              encoding: format.encoding,
              lineEnding: format.lineEnding,
              ...(guarded ? { expectedVersion: format.expectedVersion } : {}),
            });
            // Cancel reads that predate the write, including aliases resolved to
            // this file, before publishing the new disk version to all surfaces.
            const queries = this.client.getQueryCache().findAll({
              queryKey: ["projects", "read-file", this.cwd],
              predicate: (query) =>
                // Same machine only: a host's reads carry its id after the usual key.
                query.queryKey[4] === (this.hostId === LOCAL_HOST_ID ? undefined : this.hostId) &&
                (query.queryKey[3] === this.relativePath ||
                  (query.state.data as ProjectReadFileResult | undefined)?.relativePath ===
                    this.relativePath),
            });
            await Promise.all(
              queries.map((query) =>
                this.client.cancelQueries({ queryKey: query.queryKey, exact: true }),
              ),
            );
            for (const query of queries) {
              this.client.setQueryData<ProjectReadFileResult>(query.queryKey, (previous) =>
                previous ? { ...previous, contents: value, version: result.version } : previous,
              );
            }
            this.dispatch({
              type: "saveSucceeded",
              contents: value,
              expectedVersion: result.version,
            });
            // Git latency or refresh failure must never change a successful save
            // into a failed write. Existing refresh queues serialize detail reads.
            void refreshGitAfterFileWrite(this.client, this.cwd).catch(() => undefined);
            guarded = true;
          } catch (error) {
            this.dispatch({
              type: "saveFailed",
              message: error instanceof Error ? error.message : "Could not save the file.",
              conflict: isWorkspaceFileWriteConflictError(error),
            });
            return false;
          }
        }
        return true;
      })
      .finally(() => {
        this.writing = undefined;
        this.releaseIfUnused();
      });
    return this.writing;
  };

  reload = async () => {
    this.pause();
    if (this.writing) await this.writing;
    const generation = this.editGeneration;
    try {
      const readOptions = projectReadFileQueryOptions({
        cwd: this.cwd,
        relativePath: this.relativePath,
        hostId: this.hostId,
      });
      await this.client.cancelQueries({ queryKey: readOptions.queryKey, exact: true });
      const file = await this.client.fetchQuery({
        ...readOptions,
        staleTime: 0,
      });
      const format = resolveWorkspaceFileEditorFormat(file);
      if (generation === this.editGeneration && format) {
        this.dispatch({
          type: "reloaded",
          key: workspaceFileEditorKey(this.cwd, this.relativePath)!,
          contents: file.contents,
          format,
        });
      }
    } catch (error) {
      this.dispatch({
        type: "saveFailed",
        message: error instanceof Error ? error.message : "Could not reload the file.",
        conflict: false,
      });
    } finally {
      this.resume();
    }
  };

  save = () => {
    this.paused = false;
    void this.flush();
  };

  overwrite = () => {
    this.paused = false;
    void this.flush(true);
  };
}

export function getWorkspaceEditorSession(
  client: QueryClient,
  cwd: string,
  relativePath: string,
  hostId: HostId = LOCAL_HOST_ID,
) {
  let entries = sessions.get(client);
  if (!entries) {
    entries = new Map();
    sessions.set(client, entries);
  }
  const key =
    hostId === LOCAL_HOST_ID
      ? workspaceFileEditorKey(cwd, relativePath)!
      : `${hostId}\0${workspaceFileEditorKey(cwd, relativePath)!}`;
  let session = entries.get(key);
  if (!session) {
    const ownedEntries = entries;
    session = new WorkspaceEditorSession(
      client,
      cwd,
      relativePath,
      () => {
        if (ownedEntries.get(key) === session) ownedEntries.delete(key);
      },
      hostId,
    );
    entries.set(key, session);
  }
  return session;
}

/** Read-only snapshots include dirty documents whose editor surface has been unmounted. */
export function getUnsavedWorkspaceEditorDocuments(client: QueryClient, cwd: string) {
  return [...(sessions.get(client)?.values() ?? [])]
    .filter((session) => session.cwd === cwd && (session.dirty || session.saving))
    .map((session) => ({
      relativePath: session.relativePath,
      contents: session.getSnapshot().value,
      version: session.getSnapshot().version,
    }));
}

export function hasUnsavedWorkspaceEditors(client: QueryClient, cwd?: string | null) {
  return [...(sessions.get(client)?.values() ?? [])].some(
    (session) => (cwd == null || session.cwd === cwd) && (session.dirty || session.saving),
  );
}

export async function flushWorkspaceEditors(
  client: QueryClient,
  cwd?: string | null,
): Promise<boolean> {
  const pending = [...(sessions.get(client)?.values() ?? [])].filter(
    (session) => (cwd == null || session.cwd === cwd) && (session.dirty || session.saving),
  );
  const results = await Promise.all(
    pending.map((session) =>
      session.getSnapshot().saveError || session.getSnapshot().conflict ? false : session.flush(),
    ),
  );
  return results.every(Boolean);
}
