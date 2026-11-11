// FILE: LanRelaySettingsSection.tsx
// Purpose: Mobile LAN & Tailscale Relay controls with QR code pairing and active device session
//          revocation, shared between System tools and Remote hosts settings panels.
// Layer: Settings UI components
// Exports: LanRelaySettingsSection

import type { DesktopLanRelayState } from "@saint/contracts";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

function lanRelayBridge() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.lanRelay;
}

export function LanRelaySettingsSection(props: { readonly active: boolean }) {
  const [state, setState] = useState<DesktopLanRelayState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const bridge = lanRelayBridge();
    if (!props.active || !bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onState((nextState) => {
      if (!disposed) setState(nextState);
    });
    void bridge
      .getState()
      .then((initial) => {
        if (!disposed) setState(initial);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [props.active]);

  const bridge = lanRelayBridge();
  if (!props.active || !bridge || !state) return null;

  const handleToggleEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await bridge.setEnabled({ enabled });
      setState(next);
      if (next.error) {
        toastManager.add({
          type: "error",
          title: "Could not start Mobile & LAN Relay",
          description: next.error,
        });
      } else {
        toastManager.add({
          type: "success",
          title: enabled ? "Mobile & LAN Relay enabled" : "Mobile & LAN Relay stopped",
          ...(enabled && next.pairingUrl ? { description: `Listening on port ${next.port}` } : {}),
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update Mobile & LAN Relay",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRotateCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await bridge.rotatePairingToken();
      setState(next);
      toastManager.add({
        type: "success",
        title: "Pairing code rotated",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not rotate pairing code",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCopyUrl = async (url: string) => {
    await copyTextToClipboard(url);
    toastManager.add({
      type: "success",
      title: "Copied pairing link",
    });
  };

  const handleRevokeSession = async (sessionId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await bridge.revokeSession({ sessionId });
      setState(next);
      toastManager.add({
        type: "success",
        title: "Device session revoked",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not revoke session",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await bridge.revokeAllSessions();
      setState(next);
      toastManager.add({
        type: "success",
        title: "Revoked all mobile & LAN sessions",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not revoke sessions",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const qrDataUrl = state.qrSvg
    ? `data:image/svg+xml;utf8,${encodeURIComponent(state.qrSvg)}`
    : null;
  const allAddresses = [
    ...state.lanAddresses.map((ip) => ({ ip, kind: "LAN" as const })),
    ...state.tailscaleAddresses.map((ip) => ({ ip, kind: "Tailscale" as const })),
  ];

  return (
    <SettingsSection title="Mobile & LAN access">
      <SettingsRow
        title="Enable LAN / Tailscale relay"
        description="Expose a token-gated reverse proxy on 0.0.0.0 so you can pair your phone or tablet over Wi-Fi or Tailscale while keeping the core server bound to 127.0.0.1."
        status={
          state.error ? (
            <span className="text-destructive">{state.error}</span>
          ) : state.enabled ? (
            `Listening on 0.0.0.0:${state.port} — pairing code ${state.pairingToken}`
          ) : (
            "Off (local loopback only)"
          )
        }
        control={
          <Switch
            checked={state.enabled}
            disabled={busy}
            onCheckedChange={(checked) => void handleToggleEnabled(Boolean(checked))}
            aria-label="Enable LAN and Tailscale relay"
          />
        }
      >
        {state.enabled ? (
          <div className="mt-3 flex flex-col gap-4 border-t border-border/65 pt-3 sm:flex-row sm:items-start">
            {qrDataUrl ? (
              <div className="shrink-0 rounded-xl border border-border/75 bg-white p-2 shadow-xs">
                <img src={qrDataUrl} alt="Mobile pairing QR code" className="size-36 select-none" />
              </div>
            ) : null}
            <div className="min-w-0 flex-1 space-y-2.5 text-ui-sm">
              <div>
                <div className="font-medium text-foreground">Pairing code</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="rounded-md border border-border/75 bg-muted/40 px-2 py-0.5 font-mono text-ui font-semibold tracking-wider text-foreground">
                    {state.pairingToken}
                  </code>
                  <Button size="xs" variant="outline" onClick={() => void handleRotateCode()}>
                    Rotate code
                  </Button>
                  {state.pairingUrl ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void handleCopyUrl(state.pairingUrl!)}
                    >
                      Copy pairing link
                    </Button>
                  ) : null}
                </div>
              </div>
              {allAddresses.length > 0 ? (
                <div className="space-y-1">
                  <div className="font-medium text-foreground">Detected network endpoints</div>
                  <div className="flex flex-wrap gap-1.5">
                    {allAddresses.map(({ ip, kind }) => {
                      const url = `http://${ip}:${state.port}/pair?token=${state.pairingToken}`;
                      return (
                        <Button
                          key={`${kind}-${ip}`}
                          size="chip"
                          variant="outline"
                          onClick={() => void handleCopyUrl(url)}
                        >
                          {kind}: {ip}:{state.port}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground">
                  No private LAN or Tailscale IPv4 interface detected.
                </div>
              )}
            </div>
          </div>
        ) : null}
      </SettingsRow>

      {state.activeSessions.length > 0 ? (
        <>
          {state.activeSessions.map((session) => (
            <SettingsListRow
              key={session.sessionId}
              title={session.label}
              description={`Paired at ${new Date(session.createdAt).toLocaleTimeString()} · Last active ${new Date(session.lastSeenAt).toLocaleTimeString()}`}
              actions={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  onClick={() => void handleRevokeSession(session.sessionId)}
                >
                  Revoke
                </Button>
              }
            />
          ))}
          {state.activeSessions.length > 1 ? (
            <SettingsRow
              title="Connected devices"
              description={`${state.activeSessions.length} active mobile or LAN sessions.`}
              control={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  onClick={() => void handleRevokeAll()}
                >
                  Revoke all
                </Button>
              }
            />
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
