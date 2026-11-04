/**
 * A desktop's stable name on remote hosts (`<user>-<8 hex>`). One remote server serves several
 * desktops and partitions their projects, threads and other data by this id.
 */
export const REMOTE_CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}-[0-9a-f]{8}$/u;

/** WebSocket query parameter carrying the desktop's remote client id. */
export const REMOTE_CLIENT_ID_PARAM = "client";

/**
 * Set to `1` on a server launched for remote desktops: every WebSocket must then carry a client
 * id, and each connection sees only its own client's data.
 */
export const CLIENT_SCOPED_ENV = "SAINT_CLIENT_SCOPED";

export function isRemoteClientId(value: string): boolean {
  return REMOTE_CLIENT_ID_PATTERN.test(value);
}
