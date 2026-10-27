import { Effect, Schema, ServiceMap, type Stream } from "effect";

import type {
  ProjectCreateEntryInput,
  ProjectCreateEntryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectMoveEntryInput,
  ProjectMoveEntryResult,
  ProjectReadFileInput,
  ProjectRenameEntryInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@saint/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths";

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.operation} failed for ${this.cwd}: ${this.detail}`;
  }
}

export class WorkspaceFileConflictError extends Schema.TaggedErrorClass<WorkspaceFileConflictError>()(
  "WorkspaceFileConflictError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return "This file changed on disk after it was opened. Reload it before saving to avoid overwriting those changes.";
  }
}

export class WorkspaceFileDeletedError extends Schema.TaggedErrorClass<WorkspaceFileDeletedError>()(
  "WorkspaceFileDeletedError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return "This file was removed from disk after it was opened. Reload the Explorer before saving.";
  }
}

export interface WorkspaceUploadFileInput {
  readonly cwd: string;
  /** Workspace-relative folder to upload into; null for the workspace root. */
  readonly directory: string | null;
  /** Plain file name; a taken name gets a ` (n)` suffix instead of being replaced. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface WorkspaceDownloadFileInput {
  readonly cwd: string;
  readonly relativePath: string;
}

/** An opened regular file inside the workspace, ready to stream to a download. */
export interface WorkspaceDownloadFile {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Reads the opened descriptor; it closes once the stream ends or is interrupted. */
  readonly stream: Stream.Stream<Uint8Array, WorkspaceFileSystemError>;
}

export interface WorkspaceFileSystemShape {
  readonly readFile: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<
    ProjectReadFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    | WorkspaceFileConflictError
    | WorkspaceFileDeletedError
    | WorkspaceFileSystemError
    | WorkspacePathOutsideRootError
  >;
  readonly createEntry: (
    input: ProjectCreateEntryInput,
  ) => Effect.Effect<
    ProjectCreateEntryResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly deleteEntry: (
    input: ProjectDeleteEntryInput,
  ) => Effect.Effect<
    ProjectDeleteEntryResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly moveEntry: (
    input: ProjectMoveEntryInput,
  ) => Effect.Effect<
    ProjectMoveEntryResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly renameEntry: (
    input: ProjectRenameEntryInput,
  ) => Effect.Effect<
    ProjectMoveEntryResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly uploadFile: (
    input: WorkspaceUploadFileInput,
  ) => Effect.Effect<
    { readonly relativePath: string },
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  /** Opens a regular file for a download; folders and special files are refused. */
  readonly openFileForDownload: (
    input: WorkspaceDownloadFileInput,
  ) => Effect.Effect<
    WorkspaceDownloadFile,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
}

export class WorkspaceFileSystem extends ServiceMap.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("saint/workspace/Services/WorkspaceFileSystem") {}
