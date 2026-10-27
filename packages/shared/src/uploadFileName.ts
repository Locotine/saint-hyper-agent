// FILE: uploadFileName.ts
// Purpose: Validates names of files moved between this computer and a workspace
//          (Explorer uploads on the server, downloads in the desktop app) and lists
//          the non-clobbering names they may take ("a.pdf", "a (1).pdf", ...).
// Layer: Shared file-transfer utility
// Exports: isPlainUploadFileName, uploadFileNameCandidates

const MAX_UPLOAD_FILE_NAME_LENGTH = 255;
const MAX_UPLOAD_NAME_SUFFIX = 999;

/** A single path segment: no separators, NUL, or dot-only names. */
export function isPlainUploadFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_UPLOAD_FILE_NAME_LENGTH &&
    name.trim() === name &&
    name !== "." &&
    name !== ".." &&
    !["/", "\\", "\0"].some((character) => name.includes(character))
  );
}

/** `name`, then `stem (1).ext` up to `stem (999).ext`; dotfiles keep their leading dot. */
export function* uploadFileNameCandidates(name: string): Generator<string> {
  yield name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 1; index <= MAX_UPLOAD_NAME_SUFFIX; index += 1) {
    yield `${stem} (${index})${extension}`;
  }
}
