// FILE: RemoteFolderPickerDialog.tsx
// Purpose: Folder picker for remote SSH host windows. Browses the host's folders
//          through the server (`filesystem.browse`), marks git repositories, and
//          resolves `pickRemoteFolder()` with the chosen host path.
// Layer: Web UI dialog (mounted once in the root route)
// Exports: RemoteFolderPickerDialog

import type { FilesystemBrowseResult } from "@saint/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { remoteWindowHost } from "../env";
import { readLocalNativeApi } from "../nativeApi";
import { useRemoteFolderPickerStore } from "../remoteFolderPickerStore";
import { ArrowUpIcon, EyeIcon, FolderIcon, GitBranchIcon, HomeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME } from "./CreateGitHubProjectFields";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";

const HOME_DIRECTORY = "~";
// Reopening the picker starts where the last pick ended, like a native dialog.
let lastPickedDirectory = HOME_DIRECTORY;

function parentDirectory(directory: string): string {
  const trimmed = directory.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function browsePath(directory: string): string {
  return directory.endsWith("/") ? directory : `${directory}/`;
}

export function RemoteFolderPickerDialog() {
  const resolve = useRemoteFolderPickerStore((state) => state.resolve);
  const settle = useRemoteFolderPickerStore((state) => state.settle);
  // Mounting per request resets navigation to the last picked folder.
  return resolve ? <RemoteFolderPickerContent onSettle={settle} /> : null;
}

function RemoteFolderPickerContent(props: { onSettle: (path: string | null) => void }) {
  const [directory, setDirectory] = useState(lastPickedDirectory);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const browseQuery = useQuery<FilesystemBrowseResult>({
    queryKey: ["remote-folder-picker", directory],
    queryFn: async () => {
      const api = readLocalNativeApi();
      if (!api) throw new Error("The app server is unavailable.");
      return api.filesystem.browse({ partialPath: browsePath(directory) });
    },
    retry: false,
    staleTime: 5_000,
  });

  const resolvedDirectory = browseQuery.data?.parentPath ?? null;
  const entries = (browseQuery.data?.entries ?? []).filter(
    (entry) => showHidden || !entry.name.startsWith("."),
  );
  const pathValue = draftPath ?? resolvedDirectory ?? directory;

  const navigate = (next: string) => {
    setDraftPath(null);
    setDirectory(next.trim() || HOME_DIRECTORY);
  };
  const choose = () => {
    if (!resolvedDirectory) return;
    lastPickedDirectory = resolvedDirectory;
    props.onSettle(resolvedDirectory);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onSettle(null);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            Folders on {remoteWindowHost ?? "the server"}. Agents, git and terminals run there.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 px-5" scrollFade={false}>
          <div className="mt-3 flex items-center gap-1.5">
            <InputGroup className={cn(PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME, "min-w-0 flex-1")}>
              <InputGroupAddon className="w-10 self-stretch border-e border-foreground/12 ps-0">
                <FolderIcon className="size-4 text-muted-foreground/70" aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                value={pathValue}
                aria-label="Folder path on the remote host"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => setDraftPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  navigate(pathValue);
                }}
              />
            </InputGroup>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Parent folder"
              disabled={!resolvedDirectory || resolvedDirectory === "/"}
              onClick={() => resolvedDirectory && navigate(parentDirectory(resolvedDirectory))}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Home folder"
              onClick={() => navigate(HOME_DIRECTORY)}
            >
              <HomeIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
              aria-pressed={showHidden}
              className={cn(showHidden && "bg-foreground/8")}
              onClick={() => setShowHidden((current) => !current)}
            >
              <EyeIcon />
            </Button>
          </div>
          <div
            role="group"
            aria-label="Folders"
            className="h-72 overflow-y-auto rounded-lg border border-foreground/12 p-1"
          >
            {browseQuery.isError ? (
              <p className="px-2.5 py-2 text-ui-sm text-destructive">
                {browseQuery.error instanceof Error
                  ? browseQuery.error.message
                  : "Unable to read this folder."}
              </p>
            ) : browseQuery.isPending ? (
              <p className="px-2.5 py-2 text-ui-sm text-muted-foreground">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="px-2.5 py-2 text-ui-sm text-muted-foreground">No folders here.</p>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.fullPath}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-start text-ui outline-none hover:bg-foreground/6 focus-visible:bg-foreground/6"
                  onClick={() => navigate(entry.fullPath)}
                >
                  <FolderIcon
                    className="size-4 shrink-0 text-muted-foreground/70"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.isGitRepository ? (
                    <span className="flex shrink-0 items-center gap-1 text-ui-xs text-muted-foreground">
                      <GitBranchIcon className="size-3.5" aria-hidden="true" />
                      git
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </DialogPanel>
        <DialogFooter className="px-5 pb-5">
          <Button
            variant="ghost"
            shape="capsule"
            className="px-4 text-ui-lg sm:text-ui-lg"
            onClick={() => props.onSettle(null)}
          >
            Cancel
          </Button>
          <Button
            variant="prominent"
            className="px-4 text-ui-lg transition-opacity hover:scale-100 sm:text-ui-lg"
            disabled={!resolvedDirectory}
            onClick={choose}
          >
            Open
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
