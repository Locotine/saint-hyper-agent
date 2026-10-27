import { Effect, Schema, ServiceMap } from "effect";

import type {
  ProjectCreateEntryInput,
  ProjectCreateEntryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectReadFileInput,
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
  readonly uploadFile: (
    input: WorkspaceUploadFileInput,
  ) => Effect.Effect<
    { readonly relativePath: string },
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
}

export class WorkspaceFileSystem extends ServiceMap.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("saint/workspace/Services/WorkspaceFileSystem") {}
