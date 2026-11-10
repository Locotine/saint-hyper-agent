import { describe, expect, it, vi } from "vitest";
import {
  createTauriDesktopBridge,
  parseBrowserAnnotationEvent,
  parseBrowserOpenPanelRequest,
  parseComputerPreviewFrame,
  parseQuitConfirmationRequest,
  type TauriRuntimeAdapter,
} from "./preloadBridge";

function createMockAdapter() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined);
  const adapter: TauriRuntimeAdapter = {
    invoke: invoke as TauriRuntimeAdapter["invoke"],
    listen: (event, handler) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const handler of listeners.get(event) ?? []) {
      handler(payload);
    }
  };
  return { adapter, invoke, emit };
}

describe("createTauriDesktopBridge", () => {
  it("exposes synchronous wsUrl, zoomFactor, and storageMigration snapshot without Electron", async () => {
    const { adapter, invoke, emit } = createMockAdapter();
    const snapshot = {
      version: 1 as const,
      exportedAt: "2026-11-05T00:00:00.000Z",
      entries: { "saint:theme": "dark" },
    };
    const bridge = createTauriDesktopBridge(
      {
        wsUrl: "ws://127.0.0.1:41234",
        zoomFactor: 1.25,
        windowTranslucency: "native",
        remoteSshEnabled: true,
        storageMigrationSnapshot: snapshot,
      },
      adapter,
    );

    expect(bridge.getWsUrl()).toBe("ws://127.0.0.1:41234/");
    expect(bridge.getZoomFactor()).toBe(1.25);
    expect(bridge.windowTranslucency).toBe("native");
    expect(bridge.storageMigration.readSnapshot()).toEqual(snapshot);

    // Omitted per user architectural decision: no beta, no browser.vault, no safariAccess
    expect(bridge.beta).toBeUndefined();
    expect(bridge.betaDiagnostics).toBeUndefined();
    expect(bridge.safariAccess).toBeUndefined();
    expect(bridge.browser.vault).toBeUndefined();
    expect(bridge.remoteSsh).toBeDefined();

    await bridge.storageMigration.acknowledgeSnapshot();
    expect(bridge.storageMigration.readSnapshot()).toBeNull();
    expect(invoke).toHaveBeenCalledWith("desktop_storage_migration_acknowledge");

    const zoomSpy = vi.fn();
    bridge.onZoomFactorChange(zoomSpy);
    emit("desktop:zoom-factor-changed", 1.5);
    expect(zoomSpy).toHaveBeenCalledWith(1.5);
    expect(bridge.getZoomFactor()).toBe(1.5);
  });

  it("manages computerPreview subscription demand refcount across listeners", () => {
    const { adapter, invoke, emit } = createMockAdapter();
    const bridge = createTauriDesktopBridge({ wsUrl: null, zoomFactor: 1 }, adapter);

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const unsubA = bridge.computerPreview!.onFrame((frame) => seenA.push(frame));
    const unsubB = bridge.computerPreview!.onFrame((frame) => seenB.push(frame));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("desktop_computer_preview_subscribe");

    emit("computerPreview.frame", { windowId: 42, seq: 1, jpeg: [255, 216, 255] });
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);

    unsubA();
    expect(invoke).toHaveBeenCalledTimes(1);
    unsubB();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("desktop_computer_preview_unsubscribe");
  });

  it("validates payload parsers accurately", () => {
    expect(
      parseComputerPreviewFrame({ windowId: 7, seq: 3, jpeg: new Uint8Array([1, 2]) }),
    ).toEqual({
      windowId: 7,
      seq: 3,
      jpeg: new Uint8Array([1, 2]),
    });
    expect(parseComputerPreviewFrame({ windowId: 7, seq: 3, jpeg: [] })).toBeNull();
    expect(parseBrowserOpenPanelRequest({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
    expect(parseBrowserOpenPanelRequest({ threadId: "   " })).toBeNull();
    expect(parseQuitConfirmationRequest({ requestId: "req-1", presentation: "in-app" })).toEqual({
      requestId: "req-1",
      presentation: "in-app",
    });
    expect(
      parseBrowserAnnotationEvent({
        kind: "started",
        threadId: "t1",
        tabId: "tab1",
        document: { token: "tok", key: "k", url: "https://example.com" },
        source: { url: "https://example.com", pageTitle: "Example" },
      }),
    ).not.toBeNull();
  });

  it("invokes all 4 Phase 1 shell IPC commands with expected arguments", async () => {
    const { adapter, invoke } = createMockAdapter();
    const bridge = createTauriDesktopBridge({ wsUrl: null, zoomFactor: 1 }, adapter);

    await bridge.showContextMenu([{ id: "copy", label: "Copy" }], { x: 120, y: 240 });
    expect(invoke).toHaveBeenCalledWith("desktop_context_menu", {
      items: [{ id: "copy", label: "Copy" }],
      position: { x: 120, y: 240 },
    });

    await bridge.setMenuShortcuts?.({
      "terminal.new": {
        key: "t",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      "sidebar.toggle": null,
      "browser.toggle": null,
    });
    expect(invoke).toHaveBeenCalledWith("desktop_set_menu_shortcuts", {
      shortcuts: {
        "terminal.new": {
          key: "t",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        "sidebar.toggle": null,
        "browser.toggle": null,
      },
    });

    await bridge.clipboard?.writeImagePngDataUrl("data:image/png;base64,AAAA");
    expect(invoke).toHaveBeenCalledWith("desktop_clipboard_write_image", {
      dataUrl: "data:image/png;base64,AAAA",
    });

    bridge.replyQuitConfirmation({
      requestId: "req-42",
      phase: "decision",
      allow: true,
    });
    expect(invoke).toHaveBeenCalledWith("desktop_quit_confirmation_response", {
      response: {
        requestId: "req-42",
        phase: "decision",
        allow: true,
      },
    });
  });

  it("wires Phase 3 remoteSsh, appSnap, audioLevel, and updater IPC commands", async () => {
    const { adapter, invoke } = createMockAdapter();
    const bridge = createTauriDesktopBridge(
      { wsUrl: null, zoomFactor: 1, remoteSshEnabled: true },
      adapter,
    );

    await bridge.remoteSsh!.connect({ host: "devbox", remoteRoot: ".saint-remote" });
    expect(invoke).toHaveBeenCalledWith("desktop_remote_ssh_connect", {
      host: { host: "devbox", remoteRoot: ".saint-remote" },
    });

    await bridge.remoteSsh!.disconnect("devbox");
    expect(invoke).toHaveBeenCalledWith("desktop_remote_ssh_disconnect", { host: "devbox" });

    await bridge.remoteSsh!.stopServer({ host: "devbox" });
    expect(invoke).toHaveBeenCalledWith("desktop_remote_ssh_stop_server", {
      host: { host: "devbox" },
    });

    await bridge.remoteSsh!.testHost!({ host: "devbox", port: 2222 });
    expect(invoke).toHaveBeenCalledWith("desktop_remote_ssh_test_host", {
      host: { host: "devbox", port: 2222 },
    });

    await bridge.remoteSsh!.updateHost!({
      previousHost: "devbox",
      target: { host: "devbox-2", label: "Dev 2" },
    });
    expect(invoke).toHaveBeenCalledWith("desktop_remote_ssh_update_host", {
      input: {
        previousHost: "devbox",
        target: { host: "devbox-2", label: "Dev 2" },
      },
    });

    await bridge.appSnap.captureCurrentApp("req-1");
    expect(invoke).toHaveBeenCalledWith("desktop_appsnap_capture_current_app", {
      requestId: "req-1",
    });

    await bridge.appSnap.openPermissionSettings("screen-recording");
    expect(invoke).toHaveBeenCalledWith("desktop_appsnap_open_permission_settings", {
      pane: "screen-recording",
    });

    await bridge.audioLevel!.setSource("microphone", "mic-1");
    expect(invoke).toHaveBeenCalledWith("desktop_audio_level_set_source", {
      source: "microphone",
      microphoneId: "mic-1",
    });

    await bridge.checkForUpdates();
    expect(invoke).toHaveBeenCalledWith("desktop_update_check");
  });
});
