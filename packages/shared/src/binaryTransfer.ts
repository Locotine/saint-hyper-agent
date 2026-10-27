// Shared route names keep browser uploads and server handlers on the same protocol surface.
export const ATTACHMENT_UPLOAD_ROUTE_PATH = "/api/attachments/upload" as const;
export const ATTACHMENT_CANCEL_ROUTE_PATH = "/api/attachments/cancel" as const;
export const VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH = "/api/voice/transcribe" as const;
export const LIBRARY_UPLOAD_ROUTE_PATH = "/api/library/upload" as const;
export const WORKSPACE_UPLOAD_ROUTE_PATH = "/api/workspace/upload" as const;
/** GET `?cwd=&path=`: streams one workspace file as an attachment (Explorer "Download"). */
export const WORKSPACE_DOWNLOAD_ROUTE_PATH = "/api/workspace/download" as const;
/** Largest file the Explorer can drop into a workspace; the body is buffered in memory. */
export const WORKSPACE_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
