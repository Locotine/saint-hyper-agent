// FILE: RemoteHostsSettingsPanel.tsx
// Purpose: Settings › Remote hosts: manage SSH targets, import from ~/.ssh/config,
//          test reachability/auth/server status, and connect to a managed Saint server.
// Layer: Settings UI (desktop Beta only; the main process owns ssh, install and tunnels)
// Exports: RemoteHostsSettingsPanel

import type { DesktopRemoteSshSavedHost, DesktopRemoteSshTestResult } from "@saint/contracts";
import { useState } from "react";

import { showConfirmDialogFallback } from "~/confirmDialogFallback";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { useRemoteSshState } from "~/hooks/useRemoteSshState";
import { DISCLOSURE_INNER_CLASS, disclosureShellClassName } from "~/lib/disclosureMotion";
import { ServerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { readLocalNativeApi } from "~/nativeApi";
import { remoteSshBridge } from "../../lib/devLoopbackHosts";
import { LanRelaySettingsSection } from "./LanRelaySettingsSection";
import {
  isRemoteHostBusy,
  remoteHostConnectingProgress,
  remoteHostRows,
  remoteHostStatus,
  type RemoteHostRow,
  type RemoteHostStatusTone,
} from "./remoteHostsSettingsModel";
import {
  SettingsCard,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

function showError(title: string, error: unknown): void {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

async function confirmTargetDeletion(hostLabel: string): Promise<boolean> {
  const message = `Delete remote target "${hostLabel}"?\nThis removes the saved SSH target from Saint. Installed files on the remote host are not deleted.`;
  if (typeof window !== "undefined" && window.desktopBridge?.confirm) {
    return window.desktopBridge.confirm(message);
  }
  const localApi = readLocalNativeApi();
  if (localApi?.dialogs.confirm) {
    return localApi.dialogs.confirm(message);
  }
  return showConfirmDialogFallback(message);
}

const STATUS_DOT_CLASS_BY_TONE: Record<RemoteHostStatusTone, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  error: "bg-destructive",
  disconnected: "bg-muted-foreground/45",
};

export function RemoteHostsSettingsPanel(props: { active: boolean }) {
  const state = useRemoteSshState(props.active, (error) =>
    showError("Could not load remote hosts", error),
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("");

  const [importOpen, setImportOpen] = useState(false);
  const [selectedImportHosts, setSelectedImportHosts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [testingByHost, setTestingByHost] = useState<Readonly<Record<string, boolean>>>({});
  const [testResultByHost, setTestResultByHost] = useState<
    Readonly<Record<string, DesktopRemoteSshTestResult>>
  >({});

  const bridge = remoteSshBridge();
  if (!props.active || !bridge) return null;

  const resetForm = () => {
    setEditingHost(null);
    setLabel("");
    setHost("");
    setUser("");
    setPort("");
    setIdentityFile("");
    setRemoteRoot("");
  };

  const openAddTargetForm = () => {
    resetForm();
    setImportOpen(false);
    setFormOpen(true);
  };

  const openEditTargetForm = (row: RemoteHostRow) => {
    setEditingHost(row.host);
    setLabel(row.label ?? "");
    setHost(row.host);
    setUser(row.user ?? "");
    setPort(row.port ? String(row.port) : "");
    setIdentityFile(row.identityFile ?? "");
    setRemoteRoot(row.savedRemoteRoot ?? "");
    setImportOpen(false);
    setFormOpen(true);
  };

  const buildSavedHostInput = (targetHost: string): DesktopRemoteSshSavedHost => {
    const parsedPort = Number.parseInt(port.trim(), 10);
    return {
      host: targetHost,
      remoteRoot: remoteRoot.trim() || null,
      label: label.trim() || null,
      user: user.trim() || null,
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : null,
      identityFile: identityFile.trim() || null,
    };
  };

  const connect = (target: DesktopRemoteSshSavedHost) => {
    void bridge
      .connect(target)
      .catch((error: unknown) => showError(`Could not connect to ${target.host}`, error));
  };

  const run = (action: () => Promise<void>, failure: string) => {
    void action().catch((error: unknown) => showError(failure, error));
  };

  const handleSaveTarget = (andConnect: boolean) => {
    const trimmed = host.trim();
    if (!trimmed) return;
    const target = buildSavedHostInput(trimmed);
    const savePromise = bridge.updateHost
      ? bridge.updateHost({ previousHost: editingHost, target }).then(() => undefined)
      : Promise.resolve();
    void savePromise
      .then(() => {
        setFormOpen(false);
        resetForm();
        if (andConnect) {
          connect(target);
        }
      })
      .catch((error: unknown) => showError(`Could not save ${trimmed}`, error));
  };

  const handleTestHost = (row: RemoteHostRow) => {
    setTestingByHost((prev) => ({ ...prev, [row.host]: true }));
    const target: DesktopRemoteSshSavedHost = {
      host: row.host,
      remoteRoot: row.savedRemoteRoot,
      label: row.label,
      user: row.user,
      port: row.port,
      identityFile: row.identityFile,
    };
    const action = bridge.testHost
      ? bridge.testHost(target)
      : Promise.resolve<DesktopRemoteSshTestResult>({
          host: row.host,
          reachable: row.state?.phase === "connected",
          authenticated: row.state?.phase === "connected",
          serverRunning: row.state?.phase === "connected",
          message:
            row.state?.phase === "connected"
              ? "SSH reachable · authenticated · Saint server is running."
              : "SSH test unavailable in this environment.",
        });
    void action
      .then((result) => {
        setTestResultByHost((prev) => ({ ...prev, [row.host]: result }));
      })
      .catch((error: unknown) => {
        setTestResultByHost((prev) => ({
          ...prev,
          [row.host]: {
            host: row.host,
            reachable: false,
            authenticated: false,
            serverRunning: false,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      })
      .finally(() => {
        setTestingByHost((prev) => ({ ...prev, [row.host]: false }));
      });
  };

  const handleDeleteHost = (row: RemoteHostRow) => {
    void confirmTargetDeletion(row.displayName).then((confirmed) => {
      if (!confirmed) return;
      run(() => bridge.forget(row.host), `Could not delete ${row.host}`);
    });
  };

  const rows = state ? remoteHostRows(state) : [];
  const existingHostSet = new Set(rows.map((row) => row.host));
  const configHosts = state?.configHosts ?? [];
  const importableHosts = configHosts.filter((alias) => !existingHostSet.has(alias));
  const trimmedHost = host.trim();
  const connectingProgressLines = rows
    .map((row) => remoteHostConnectingProgress(row))
    .filter((line): line is string => line !== null);

  const toggleSelectImportHost = (alias: string) => {
    setSelectedImportHosts((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) {
        next.delete(alias);
      } else {
        next.add(alias);
      }
      return next;
    });
  };

  const handleImportSelected = () => {
    const picked = importableHosts.filter((alias) => selectedImportHosts.has(alias));
    if (picked.length === 0) return;
    const importAll = async () => {
      for (const alias of picked) {
        if (bridge.updateHost) {
          await bridge.updateHost({
            previousHost: null,
            target: { host: alias, remoteRoot: null },
          });
        } else {
          await bridge.connect({ host: alias, remoteRoot: null });
        }
      }
      setSelectedImportHosts(new Set());
      setImportOpen(false);
    };
    run(importAll, "Could not import SSH hosts");
  };

  return (
    <div className="space-y-6">
      <LanRelaySettingsSection active={props.active} />

      <SettingsSectionShell
        title="Targets"
        action={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-expanded={importOpen}
              onClick={() => {
                setFormOpen(false);
                setImportOpen((current) => !current);
              }}
            >
              Import
            </Button>
            <Button
              type="button"
              size="xs"
              variant="default"
              aria-expanded={formOpen && editingHost === null}
              onClick={openAddTargetForm}
            >
              Add Target
            </Button>
          </div>
        }
      >
        <div className={disclosureShellClassName(importOpen)}>
          <div className={DISCLOSURE_INNER_CLASS}>
            {importOpen ? (
              <SettingsCard className="mb-3">
                <SettingsListRow
                  align="start"
                  title="Import from ~/.ssh/config"
                  description={
                    importableHosts.length > 0 ? (
                      <div className="space-y-2 pt-1">
                        <div className="text-ui-sm text-muted-foreground">
                          Select SSH host aliases from your config to add as Saint targets:
                        </div>
                        <div
                          role="group"
                          aria-label="SSH config hosts"
                          className="flex flex-wrap gap-1.5"
                        >
                          {importableHosts.map((alias) => {
                            const selected = selectedImportHosts.has(alias);
                            return (
                              <Button
                                key={alias}
                                type="button"
                                size="chip"
                                variant={selected ? "default" : "outline"}
                                aria-pressed={selected}
                                onClick={() => toggleSelectImportHost(alias)}
                              >
                                {alias}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      "No unimported host aliases found in ~/.ssh/config."
                    )
                  }
                  actions={
                    <div className="flex items-center gap-2">
                      {importableHosts.length > 0 ? (
                        <Button
                          type="button"
                          size="xs"
                          disabled={selectedImportHosts.size === 0}
                          onClick={handleImportSelected}
                        >
                          Add Selected ({selectedImportHosts.size})
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setImportOpen(false)}
                      >
                        Close
                      </Button>
                    </div>
                  }
                />
              </SettingsCard>
            ) : null}
          </div>
        </div>

        <div className={disclosureShellClassName(formOpen)}>
          <div className={DISCLOSURE_INNER_CLASS}>
            {formOpen ? (
              <SettingsCard className="mb-3">
                <SettingsRow
                  title={editingHost ? `Edit target (${editingHost})` : "Target name"}
                  description="Optional display name shown in the Targets list."
                  control={
                    <Input
                      className="w-full sm:w-64"
                      aria-label="Target name"
                      value={label}
                      placeholder="Production GPU"
                      spellCheck={false}
                      onChange={(event) => setLabel(event.target.value)}
                    />
                  }
                />
                <SettingsRow
                  title="SSH host"
                  description="An alias from ~/.ssh/config or user@hostname. Saint signs in with your SSH keys and agent; password prompts are not supported."
                  control={
                    <Input
                      className="w-full sm:w-64"
                      aria-label="SSH host"
                      value={host}
                      placeholder="devbox"
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(event) => setHost(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && trimmedHost) {
                          handleSaveTarget(true);
                        }
                      }}
                    />
                  }
                >
                  {configHosts.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {configHosts.map((alias) => (
                        <Button
                          key={alias}
                          type="button"
                          size="chip"
                          variant="outline"
                          onClick={() => setHost(alias)}
                        >
                          {alias}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </SettingsRow>
                <SettingsRow
                  title="SSH user & port"
                  description="Optional SSH username and port override (defaults to ~/.ssh/config or port 22)."
                  control={
                    <div className="flex w-full items-center gap-2 sm:w-64">
                      <Input
                        className="min-w-0 flex-1"
                        aria-label="SSH user"
                        value={user}
                        placeholder="ubuntu"
                        spellCheck={false}
                        autoCapitalize="off"
                        onChange={(event) => setUser(event.target.value)}
                      />
                      <Input
                        className="w-20 shrink-0"
                        aria-label="SSH port"
                        value={port}
                        placeholder="22"
                        inputMode="numeric"
                        spellCheck={false}
                        onChange={(event) => setPort(event.target.value)}
                      />
                    </div>
                  }
                />
                <SettingsRow
                  title="Identity key path"
                  description="Optional private key path passed to ssh -i."
                  control={
                    <Input
                      className="w-full sm:w-64"
                      aria-label="Identity key path"
                      value={identityFile}
                      placeholder="~/.ssh/id_ed25519"
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(event) => setIdentityFile(event.target.value)}
                    />
                  }
                />
                <SettingsRow
                  title="Remote folder"
                  description="Where Saint is installed and keeps its data on the host, relative to the remote home folder. Use a folder of your own on shared accounts."
                  control={
                    <Input
                      className="w-full sm:w-64"
                      aria-label="Remote folder"
                      value={remoteRoot}
                      placeholder={state?.defaultRemoteRoot ?? ""}
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(event) => setRemoteRoot(event.target.value)}
                    />
                  }
                />
                <SettingsRow
                  title={editingHost ? "Save changes" : "Add target"}
                  description="Save this target to your list, or connect immediately to install and start the managed Saint server."
                  control={
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setFormOpen(false);
                          resetForm();
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={!trimmedHost}
                        onClick={() => handleSaveTarget(false)}
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        disabled={!trimmedHost}
                        onClick={() => handleSaveTarget(true)}
                      >
                        {editingHost ? "Save & Connect" : "Connect"}
                      </Button>
                    </div>
                  }
                />
              </SettingsCard>
            ) : null}
          </div>
        </div>

        <SettingsCard>
          {!state ? (
            <SettingsListRow title="Loading targets…" />
          ) : rows.length > 0 ? (
            rows.map((row) => (
              <RemoteHostListRow
                key={row.host}
                row={row}
                testing={Boolean(testingByHost[row.host])}
                testResult={testResultByHost[row.host] ?? null}
                onConnect={() =>
                  connect({
                    host: row.host,
                    remoteRoot: row.savedRemoteRoot,
                    label: row.label,
                    user: row.user,
                    port: row.port,
                    identityFile: row.identityFile,
                  })
                }
                onDisconnect={() =>
                  run(() => bridge.disconnect(row.host), `Could not disconnect ${row.host}`)
                }
                onStop={() =>
                  run(
                    () =>
                      bridge.stopServer({
                        host: row.host,
                        remoteRoot: row.savedRemoteRoot,
                        label: row.label,
                        user: row.user,
                        port: row.port,
                        identityFile: row.identityFile,
                      }),
                    `Could not stop the server on ${row.host}`,
                  )
                }
                onTest={() => handleTestHost(row)}
                onEdit={() => openEditTargetForm(row)}
                onDelete={() => handleDeleteHost(row)}
              />
            ))
          ) : (
            <SettingsListRow
              title="No remote targets yet"
              description="Use Import to add hosts from ~/.ssh/config or click Add Target to configure a remote Saint server."
            />
          )}
        </SettingsCard>

        {connectingProgressLines.length > 0 ? (
          <div
            role="status"
            aria-live="polite"
            className="mt-2 flex flex-col gap-1 rounded-lg border border-border/65 bg-muted/20 px-3 py-2 text-ui-sm text-muted-foreground"
          >
            {connectingProgressLines.map((line) => (
              <div key={line} className="flex items-center gap-2">
                <Spinner className="size-3.5 shrink-0 text-foreground" />
                <span>{line}</span>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsSectionShell>

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
  testing: boolean;
  testResult: DesktopRemoteSshTestResult | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onStop: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { row, testing, testResult } = props;
  const busy = isRemoteHostBusy(row.state);
  const connected = row.state?.phase === "connected";
  const failed = row.state?.phase === "error" ? row.state.message : null;
  const dotClassName = STATUS_DOT_CLASS_BY_TONE[row.statusTone];

  return (
    <SettingsListRow
      align="start"
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/75 bg-muted/30 text-muted-foreground"
          >
            <ServerIcon className="size-3.5" />
          </span>
          <span className="truncate font-medium text-foreground">{row.displayName}</span>
          {row.label && row.label !== row.host ? (
            <span className="truncate font-mono text-ui-xs text-muted-foreground">
              ({row.host})
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/25 px-2 py-0.5 text-ui-xs font-normal text-muted-foreground">
            {busy ? (
              <>
                <Spinner className="size-3 text-amber-500" />
                <span>Connecting</span>
              </>
            ) : (
              <>
                <span aria-hidden="true" className={cn("size-2 rounded-full", dotClassName)} />
                <span>{row.statusBadge}</span>
              </>
            )}
          </span>
        </div>
      }
      description={
        <div className="space-y-1 pt-0.5">
          <div className="font-mono text-ui-xs text-muted-foreground">
            {row.connectionDetails} • ~/{row.remoteRoot}
          </div>
          <div className="text-ui-sm text-muted-foreground">{remoteHostStatus(row.state)}</div>
          {failed ? <div className="break-words text-ui-sm text-destructive">{failed}</div> : null}
          {testing ? (
            <div className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
              <Spinner className="size-3" />
              <span>Testing SSH reachability, authentication, and remote Saint server…</span>
            </div>
          ) : testResult ? (
            <div
              className={cn(
                "text-ui-xs",
                testResult.reachable && testResult.authenticated
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive",
              )}
            >
              {testResult.message}
            </div>
          ) : null}
        </div>
      }
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {connected ? (
            <Button type="button" size="xs" variant="outline" onClick={props.onDisconnect}>
              Disconnect
            </Button>
          ) : busy ? (
            <Button type="button" size="xs" variant="outline" onClick={props.onDisconnect}>
              Cancel
            </Button>
          ) : (
            <Button type="button" size="xs" variant="default" onClick={props.onConnect}>
              Connect
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={props.onConnect}
          >
            Retry
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || testing}
            onClick={props.onTest}
          >
            Test
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={props.onEdit}>
            Edit
          </Button>
          {connected ? (
            <Button type="button" size="xs" variant="destructive-outline" onClick={props.onStop}>
              Stop server
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={props.onDelete}>
            Delete
          </Button>
        </div>
      }
    />
  );
}
