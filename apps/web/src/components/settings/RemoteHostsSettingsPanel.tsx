// FILE: RemoteHostsSettingsPanel.tsx
// Purpose: Settings › Remote hosts: connect to a Saint server on another machine over SSH.
// Layer: Settings UI (desktop Beta only; the main process owns ssh, install and tunnels)
// Exports: RemoteHostsSettingsPanel

import type { DesktopRemoteSshSavedHost } from "@saint/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { useRemoteSshState } from "~/hooks/useRemoteSshState";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import {
  isRemoteHostBusy,
  remoteHostRows,
  remoteHostStatus,
  type RemoteHostRow,
} from "./remoteHostsSettingsModel";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { remoteSshBridge } from "../../lib/devLoopbackHosts";

function showError(title: string, error: unknown): void {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

export function RemoteHostsSettingsPanel(props: { active: boolean }) {
  const state = useRemoteSshState(props.active, (error) =>
    showError("Could not load remote hosts", error),
  );
  const [host, setHost] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("");

  const bridge = remoteSshBridge();
  if (!props.active || !bridge) return null;

  const connect = (target: DesktopRemoteSshSavedHost) => {
    void bridge
      .connect(target)
      .catch((error: unknown) => showError(`Could not connect to ${target.host}`, error));
  };
  const run = (action: () => Promise<void>, failure: string) => {
    void action().catch((error: unknown) => showError(failure, error));
  };

  const rows = state ? remoteHostRows(state) : [];
  const trimmedHost = host.trim();
  const configHosts = state?.configHosts ?? [];

  return (
    <div className="space-y-6">
      <SettingsSection title="Connect a host">
        <SettingsRow
          title="SSH host"
          description="An alias from ~/.ssh/config or user@hostname. Saint signs in with your SSH keys and agent; password prompts are not supported."
          control={
            <Input
              className="w-full sm:w-64"
              value={host}
              placeholder="devbox"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setHost(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && trimmedHost) {
                  connect({ host: trimmedHost, remoteRoot: remoteRoot.trim() || null });
                }
              }}
            />
          }
        >
          {configHosts.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {configHosts.map((alias) => (
                <Button key={alias} size="chip" variant="outline" onClick={() => setHost(alias)}>
                  {alias}
                </Button>
              ))}
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="Remote folder"
          description="Where Saint is installed and keeps its data on the host, relative to the remote home folder. Use a folder of your own on shared accounts."
          control={
            <Input
              className="w-full sm:w-64"
              value={remoteRoot}
              placeholder={state?.defaultRemoteRoot ?? ""}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setRemoteRoot(event.target.value)}
            />
          }
        />
        <SettingsRow
          title="Connect"
          description={`Installs this Saint version on the host when needed, starts its server in tmux, and connects through an SSH tunnel. Its projects then appear in the sidebar's Projects list.`}
          control={
            <Button
              size="sm"
              disabled={!trimmedHost}
              onClick={() => connect({ host: trimmedHost, remoteRoot: remoteRoot.trim() || null })}
            >
              Connect
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Hosts">
        {!state ? (
          <SettingsListRow title="Loading hosts…" />
        ) : rows.length > 0 ? (
          rows.map((row) => (
            <RemoteHostListRow
              key={row.host}
              row={row}
              onConnect={() => connect({ host: row.host, remoteRoot: row.savedRemoteRoot })}
              onDisconnect={() =>
                run(() => bridge.disconnect(row.host), `Could not disconnect ${row.host}`)
              }
              onStop={() =>
                run(
                  () => bridge.stopServer({ host: row.host, remoteRoot: row.savedRemoteRoot }),
                  `Could not stop the server on ${row.host}`,
                )
              }
              onForget={() => run(() => bridge.forget(row.host), `Could not forget ${row.host}`)}
            />
          ))
        ) : (
          <SettingsListRow
            title="No remote hosts yet"
            description="Hosts you connect to appear here so you can reopen them."
          />
        )}
      </SettingsSection>

      <SettingsSection title="Host requirements">
        <SettingsListRow
          title="What the host needs"
          description={
            <ul className="list-disc space-y-1 pl-4">
              <li>Key-based SSH access from this computer.</li>
              <li>
                Node.js 22.16 or newer (23.11+ on the 23 line) and npm on the login shell's PATH.
              </li>
              <li>
                tmux, so the server and its agents keep running after you disconnect. Without it
                Saint starts the server with nohup.
              </li>
              <li>
                On Linux, a C/C++ toolchain and Python, which npm uses to build the terminal module.
              </li>
              <li>The provider CLIs you use (Claude, Codex, …), signed in on the host.</li>
            </ul>
          }
          align="start"
        />
      </SettingsSection>
    </div>
  );
}

function RemoteHostListRow(props: {
  row: RemoteHostRow;
  onConnect: () => void;
  onDisconnect: () => void;
  onStop: () => void;
  onForget: () => void;
}) {
  const { row } = props;
  const busy = isRemoteHostBusy(row.state);
  const connected = row.state?.phase === "connected";
  const failed = row.state?.phase === "error" ? row.state.message : null;
  return (
    <SettingsListRow
      align="start"
      title={row.host}
      description={
        <div className="space-y-1">
          <div>{remoteHostStatus(row.state)}</div>
          <div>Folder: ~/{row.remoteRoot}</div>
          {failed ? <div className="break-words text-destructive">{failed}</div> : null}
        </div>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* A connected host's chats open from the sidebar, so it needs no button here. */}
          {connected ? null : (
            <Button size="xs" variant="outline" disabled={busy} onClick={props.onConnect}>
              {failed ? "Retry" : "Connect"}
            </Button>
          )}
          {connected || busy ? (
            <Button size="xs" variant="ghost" onClick={props.onDisconnect}>
              {busy ? "Cancel" : "Disconnect"}
            </Button>
          ) : null}
          <Button size="xs" variant="destructive-outline" disabled={busy} onClick={props.onStop}>
            Stop server
          </Button>
          {row.saved && !connected && !busy ? (
            <Button size="xs" variant="ghost" onClick={props.onForget}>
              Forget
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
