// FILE: preloadBridge.ts
// Purpose: Exposes `window.desktopBridge` inside Tauri v2 WebView without modifying `apps/web`.
// Layer: Desktop Rust -> WebView initialization script bridge
// Depends on: `@saint/contracts` DesktopBridge interface and Tauri v2 `__TAURI_INTERNALS__`.

import type {
  BrowserAnnotationEvent,
  BrowserUseOpenPanelRequest,
  DesktopAgentCursorStyle,
  DesktopBridge,
  DesktopComputerPreviewFrame,
  DesktopQuitConfirmationRequest,
  DesktopQuitConfirmationResponse,
  DesktopWindowTranslucency,
  SaintStorageSnapshot,
} from "@saint/contracts";

export interface TauriBootstrapConfig {
  readonly wsUrl: string | null;
  readonly zoomFactor: number;
  readonly windowTranslucency?: DesktopWindowTranslucency | undefined;
  readonly remoteSshEnabled?: boolean | undefined;
  readonly storageMigrationSnapshot?: SaintStorageSnapshot | null | undefined;
}

export interface TauriRuntimeAdapter {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(event: string, handler: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    __SAINT_TAURI_BOOT__?: TauriBootstrapConfig;
    __TAURI_INTERNALS__?: {
      invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
      transformCallback?: (callback: (payload: unknown) => void, once?: boolean) => number;
    };
    desktopBridge?: DesktopBridge;
  }
}

function normalizeWsUrl(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function computerPreviewFrameBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Uint8Array.from(value);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { readonly data?: unknown }).data)
  ) {
    return Uint8Array.from((value as { readonly data: readonly number[] }).data);
  }
  return null;
}

export function parseComputerPreviewFrame(payload: unknown): DesktopComputerPreviewFrame | null {
  if (!payload || typeof payload !== "object") return null;
  const frame = payload as Record<string, unknown>;
  if (typeof frame.windowId !== "number" || !Number.isFinite(frame.windowId)) return null;
  if (typeof frame.seq !== "number" || !Number.isFinite(frame.seq)) return null;
  const jpeg = computerPreviewFrameBytes(frame.jpeg);
  if (!jpeg || jpeg.byteLength === 0) return null;
  return { windowId: frame.windowId, seq: frame.seq, jpeg };
}

export function parseBrowserOpenPanelRequest(payload: unknown): BrowserUseOpenPanelRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const threadId = (payload as { readonly threadId?: unknown }).threadId;
  if (typeof threadId !== "string" || threadId.trim().length === 0) return null;
  return { threadId: threadId as BrowserUseOpenPanelRequest["threadId"] };
}

export function parseBrowserAnnotationEvent(payload: unknown): BrowserAnnotationEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  if (
    !["started", "cancelled", "document-changed", "markers-synced", "committed"].includes(
      String(event.kind),
    ) ||
    typeof event.threadId !== "string" ||
    typeof event.tabId !== "string" ||
    !event.document ||
    typeof event.document !== "object" ||
    !event.source ||
    typeof event.source !== "object"
  ) {
    return null;
  }
  const document = event.document as Record<string, unknown>;
  const source = event.source as Record<string, unknown>;
  if (
    typeof document.token !== "string" ||
    typeof document.key !== "string" ||
    typeof document.url !== "string" ||
    typeof source.url !== "string" ||
    typeof source.pageTitle !== "string"
  ) {
    return null;
  }
  return payload as BrowserAnnotationEvent;
}

export function parseQuitConfirmationRequest(
  payload: unknown,
): DesktopQuitConfirmationRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.requestId !== "string" || candidate.requestId.trim().length === 0) {
    return null;
  }
  if (candidate.presentation !== "native" && candidate.presentation !== "in-app") {
    return null;
  }
  return {
    requestId: candidate.requestId,
    presentation: candidate.presentation,
  };
}

function isValidQuitConfirmationResponse(
  response: unknown,
): response is DesktopQuitConfirmationResponse {
  if (!response || typeof response !== "object") return false;
  const candidate = response as Record<string, unknown>;
  if (typeof candidate.requestId !== "string" || candidate.requestId.trim().length === 0) {
    return false;
  }
  if (candidate.phase === "ready") {
    return true;
  }
  if (candidate.phase === "decision") {
    return typeof candidate.allow === "boolean";
  }
  return false;
}

function normalizeCaptureBytesField<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const bytes = computerPreviewFrameBytes(record.bytes);
  if (!bytes) return value;
  return { ...record, bytes } as T;
}

export function createDefaultTauriAdapter(): TauriRuntimeAdapter {
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();

  if (typeof window !== "undefined") {
    window.addEventListener("saint:tauri-event", ((customEvent: Event) => {
      const detail = (customEvent as CustomEvent<{ event: string; payload: unknown }>).detail;
      if (!detail || typeof detail.event !== "string") return;
      const handlers = eventListeners.get(detail.event);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        handler(detail.payload);
      }
    }) as EventListener);
  }

  return {
    invoke: <T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      const internals = typeof window !== "undefined" ? window.__TAURI_INTERNALS__ : undefined;
      if (!internals?.invoke) {
        return Promise.reject(new Error(`Tauri IPC unavailable for command: ${command}`));
      }
      return internals.invoke<T>(command, args);
    },
    listen: (event: string, handler: (payload: unknown) => void): (() => void) => {
      let handlers = eventListeners.get(event);
      if (!handlers) {
        handlers = new Set();
        eventListeners.set(event, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers?.delete(handler);
        if (handlers?.size === 0) {
          eventListeners.delete(event);
        }
      };
    },
  };
}

export function createTauriDesktopBridge(
  boot: TauriBootstrapConfig,
  adapter: TauriRuntimeAdapter = createDefaultTauriAdapter(),
): DesktopBridge {
  let currentWsUrl = normalizeWsUrl(boot.wsUrl);
  let currentZoomFactor =
    typeof boot.zoomFactor === "number" && Number.isFinite(boot.zoomFactor) && boot.zoomFactor > 0
      ? boot.zoomFactor
      : 1;
  let cachedStorageSnapshot: SaintStorageSnapshot | null = boot.storageMigrationSnapshot ?? null;
  let computerPreviewListenerCount = 0;

  // Keep synchronous state updated when Rust broadcasts changes.
  adapter.listen("desktop:ws-url-changed", (payload) => {
    const next = normalizeWsUrl(payload);
    if (next) currentWsUrl = next;
  });
  adapter.listen("desktop:zoom-factor-changed", (payload) => {
    if (typeof payload === "number" && Number.isFinite(payload) && payload > 0) {
      currentZoomFactor = payload;
    }
  });

  const remoteSshBridge: DesktopBridge["remoteSsh"] =
    boot.remoteSshEnabled === true
      ? {
          getState: () => adapter.invoke("desktop_remote_ssh_get_state"),
          connect: (host) => adapter.invoke("desktop_remote_ssh_connect", { host }),
          disconnect: (host) => adapter.invoke("desktop_remote_ssh_disconnect", { host }),
          stopServer: (host) => adapter.invoke("desktop_remote_ssh_stop_server", { host }),
          forget: (host) => adapter.invoke("desktop_remote_ssh_forget", { host }),
          testHost: (host) => adapter.invoke("desktop_remote_ssh_test_host", { host }),
          updateHost: (input) => adapter.invoke("desktop_remote_ssh_update_host", { input }),
          wsUrl: (host) => adapter.invoke("desktop_remote_ssh_ws_url", { host }),
          downloadFiles: (input) => adapter.invoke("desktop_remote_ssh_download_files", { input }),
          onState: (listener) =>
            adapter.listen("desktop:remote-ssh-state", (state) => {
              if (typeof state === "object" && state !== null) {
                listener(state as Parameters<typeof listener>[0]);
              }
            }),
        }
      : undefined;

  return {
    ...(remoteSshBridge ? { remoteSsh: remoteSshBridge } : {}),
    getWsUrl: () => currentWsUrl,
    getPathForFile: (file: File) => {
      const candidate = (file as File & { readonly path?: unknown }).path;
      return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
    },
    pickFolder: () => adapter.invoke("desktop_pick_folder"),
    saveFile: (input) => adapter.invoke("desktop_save_file", { input }),
    confirm: (message) => adapter.invoke("desktop_confirm", { message }),
    setTheme: (theme) => adapter.invoke("desktop_set_theme", { theme }),
    setWindowMaterial: (input) => adapter.invoke("desktop_set_window_material", { input }),
    ...(boot.windowTranslucency === "native" || boot.windowTranslucency === "compositor"
      ? { windowTranslucency: boot.windowTranslucency }
      : {}),
    showContextMenu: (items, position) =>
      adapter.invoke("desktop_context_menu", { items, position: position ?? null }),
    openExternal: (url) => adapter.invoke("desktop_open_external", { url }),
    officeWidget: {
      toggle: () => adapter.invoke("desktop_office_widget_toggle"),
    },
    showInFolder: (path) => adapter.invoke("desktop_show_in_folder", { path }),
    shell: {
      showInFolder: (path) => adapter.invoke("desktop_show_in_folder", { path }),
    },
    clipboard: {
      writeImagePngDataUrl: (dataUrl) =>
        adapter.invoke("desktop_clipboard_write_image", { dataUrl }),
    },
    windowControls: {
      minimize: () => adapter.invoke("desktop_window_minimize"),
      toggleMaximize: () => adapter.invoke("desktop_window_toggle_maximize"),
      close: () => adapter.invoke("desktop_window_close"),
      getState: () => adapter.invoke("desktop_window_get_state"),
      onState: (listener) =>
        adapter.listen("desktop:window-state", (state) => {
          if (typeof state === "object" && state !== null) {
            listener(state as Parameters<typeof listener>[0]);
          }
        }),
    },
    customTitleBar: {
      getState: () => adapter.invoke("desktop_custom_title_bar_get_state"),
      setPreference: (enabled) =>
        adapter.invoke("desktop_custom_title_bar_set_preference", { enabled }),
      relaunch: () => adapter.invoke("desktop_custom_title_bar_relaunch"),
    },
    computerPreview: {
      onFrame: (listener) => {
        const unlisten = adapter.listen("computerPreview.frame", (payload) => {
          const frame = parseComputerPreviewFrame(payload);
          if (frame) listener(frame);
        });
        computerPreviewListenerCount += 1;
        if (computerPreviewListenerCount === 1) {
          void adapter.invoke("desktop_computer_preview_subscribe").catch(() => {});
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          unlisten();
          computerPreviewListenerCount -= 1;
          if (computerPreviewListenerCount === 0) {
            void adapter.invoke("desktop_computer_preview_unsubscribe").catch(() => {});
          }
        };
      },
    },
    computer: {
      setCursorStyle: (style: DesktopAgentCursorStyle | null) =>
        adapter.invoke("desktop_computer_set_cursor_style", { style }),
    },
    audioLevel: {
      setSource: (source, microphoneId) =>
        adapter.invoke("desktop_audio_level_set_source", {
          source,
          microphoneId: microphoneId ?? null,
        }),
      listMicrophones: () => adapter.invoke("desktop_audio_level_list_microphones"),
      onLevel: (listener) =>
        adapter.listen("desktop:audio-level", (level) => {
          if (typeof level === "number" && Number.isFinite(level)) {
            listener(level);
          }
        }),
    },
    onMenuAction: (listener) =>
      adapter.listen("desktop:menu-action", (action) => {
        if (typeof action === "string") listener(action);
      }),
    setMenuShortcuts: (shortcuts) => adapter.invoke("desktop_set_menu_shortcuts", { shortcuts }),
    onQuitConfirmationRequest: (listener) =>
      adapter.listen("desktop:quit-confirmation-request", (payload) => {
        const request = parseQuitConfirmationRequest(payload);
        if (request) listener(request);
      }),
    replyQuitConfirmation: (response: DesktopQuitConfirmationResponse) => {
      if (!isValidQuitConfirmationResponse(response)) return;
      void adapter.invoke("desktop_quit_confirmation_response", { response }).catch(() => {});
    },
    getZoomFactor: () => currentZoomFactor,
    onZoomFactorChange: (listener) =>
      adapter.listen("desktop:zoom-factor-changed", (factor) => {
        if (typeof factor === "number" && Number.isFinite(factor) && factor > 0) {
          currentZoomFactor = factor;
          listener(factor);
        }
      }),
    getUpdateState: () => adapter.invoke("desktop_update_get_state"),
    checkForUpdates: () => adapter.invoke("desktop_update_check"),
    downloadUpdate: () => adapter.invoke("desktop_update_download"),
    installUpdate: () => adapter.invoke("desktop_update_install"),
    onUpdateState: (listener) =>
      adapter.listen("desktop:update-state", (state) => {
        if (typeof state === "object" && state !== null) {
          listener(state as Parameters<typeof listener>[0]);
        }
      }),
    lanRelay: {
      getState: () => adapter.invoke("desktop_lan_relay_get_state"),
      setEnabled: (input) => adapter.invoke("desktop_lan_relay_set_enabled", { input }),
      rotatePairingToken: () => adapter.invoke("desktop_lan_relay_rotate_pairing_token"),
      revokeSession: (input) => adapter.invoke("desktop_lan_relay_revoke_session", { input }),
      revokeAllSessions: () => adapter.invoke("desktop_lan_relay_revoke_all_sessions"),
      onState: (listener) =>
        adapter.listen("desktop:lan-relay-state", (state) => {
          if (typeof state === "object" && state !== null) {
            listener(state as Parameters<typeof listener>[0]);
          }
        }),
    },
    notifications: {
      isSupported: () => adapter.invoke("desktop_notifications_is_supported"),
      show: (input) => adapter.invoke("desktop_notifications_show", { input }),
    },
    appSnap: {
      captureCurrentApp: async (requestId) =>
        normalizeCaptureBytesField(
          await adapter.invoke("desktop_appsnap_capture_current_app", { requestId }),
        ),
      cancelCapture: (requestId) => adapter.invoke("desktop_appsnap_cancel_capture", { requestId }),
      getState: (permissions) =>
        adapter.invoke("desktop_appsnap_get_state", { permissions: permissions ?? null }),
      setEnabled: (enabled) => adapter.invoke("desktop_appsnap_set_enabled", { enabled }),
      checkShortcut: (shortcut) => adapter.invoke("desktop_appsnap_check_shortcut", { shortcut }),
      setShortcut: (shortcut) => adapter.invoke("desktop_appsnap_set_shortcut", { shortcut }),
      requestPermissions: (permissions) =>
        adapter.invoke("desktop_appsnap_request_permissions", { permissions: permissions ?? null }),
      startPermissionSetup: (permissions) =>
        adapter.invoke("desktop_appsnap_start_permission_setup", { permissions }),
      listPendingCaptures: async () => {
        const captures = await adapter.invoke<unknown>("desktop_appsnap_list_pending_captures");
        return Array.isArray(captures)
          ? (captures.map((item) => normalizeCaptureBytesField(item)) as Awaited<
              ReturnType<DesktopBridge["appSnap"]["listPendingCaptures"]>
            >)
          : [];
      },
      acknowledgeCapture: (captureId) =>
        adapter.invoke("desktop_appsnap_acknowledge_capture", { captureId }),
      listWindows: () => adapter.invoke("desktop_appsnap_list_windows"),
      captureWindow: async (input) =>
        normalizeCaptureBytesField(
          await adapter.invoke("desktop_appsnap_capture_window", { input }),
        ),
      openPermissionSettings: (pane) =>
        adapter.invoke("desktop_appsnap_open_permission_settings", { pane }),
      restartApp: () => adapter.invoke("desktop_appsnap_restart_app"),
      showPermissionGuide: (pane) =>
        adapter.invoke("desktop_appsnap_show_permission_guide", { pane }),
      hidePermissionGuide: () => adapter.invoke("desktop_appsnap_hide_permission_guide"),
      onPermissionGuideState: (listener) =>
        adapter.listen("desktop:appsnap-permission-guide-state", (state) => {
          if (state === "closed" || state === "granted") {
            listener(state);
          }
        }),
      onCaptured: (listener) =>
        adapter.listen("desktop:appsnap-captured", (capture) => {
          if (typeof capture === "object" && capture !== null) {
            listener(normalizeCaptureBytesField(capture) as Parameters<typeof listener>[0]);
          }
        }),
      onError: (listener) =>
        adapter.listen("desktop:appsnap-error", (error) => {
          if (typeof error === "object" && error !== null) {
            listener(error as Parameters<typeof listener>[0]);
          }
        }),
      onState: (listener) =>
        adapter.listen("desktop:appsnap-state", (state) => {
          if (typeof state === "object" && state !== null) {
            listener(state as Parameters<typeof listener>[0]);
          }
        }),
    },
    storageMigration: {
      readSnapshot: () => cachedStorageSnapshot,
      acknowledgeSnapshot: async () => {
        cachedStorageSnapshot = null;
        await adapter.invoke("desktop_storage_migration_acknowledge");
      },
    },
    server: {
      transcribeVoice: (input) => adapter.invoke("desktop_server_transcribe_voice", { input }),
    },
    browser: {
      open: (input) => adapter.invoke("desktop_browser_open", { input }),
      close: (input) => adapter.invoke("desktop_browser_close", { input }),
      hide: (input) => adapter.invoke("desktop_browser_hide", { input }),
      getState: (input) => adapter.invoke("desktop_browser_get_state", { input }),
      setPanelBounds: (input) => adapter.invoke("desktop_browser_set_bounds", { input }),
      attachWebview: (input) => adapter.invoke("desktop_browser_attach_webview", { input }),
      detachWebview: (input) => adapter.invoke("desktop_browser_detach_webview", { input }),
      copyLink: (input) => adapter.invoke("desktop_browser_request_copy_link", { input }),
      copyScreenshotToClipboard: (input) =>
        adapter.invoke("desktop_browser_copy_screenshot_to_clipboard", { input }),
      captureScreenshot: async (input) =>
        normalizeCaptureBytesField(
          await adapter.invoke("desktop_browser_capture_screenshot", { input }),
        ),
      capturePreview: (input) => adapter.invoke("desktop_browser_capture_preview", { input }),
      navigate: (input) => adapter.invoke("desktop_browser_navigate", { input }),
      reload: (input) => adapter.invoke("desktop_browser_reload", { input }),
      goBack: (input) => adapter.invoke("desktop_browser_go_back", { input }),
      goForward: (input) => adapter.invoke("desktop_browser_go_forward", { input }),
      newTab: (input) => adapter.invoke("desktop_browser_new_tab", { input }),
      closeTab: (input) => adapter.invoke("desktop_browser_close_tab", { input }),
      selectTab: (input) => adapter.invoke("desktop_browser_select_tab", { input }),
      openDevTools: (input) => adapter.invoke("desktop_browser_open_devtools", { input }),
      annotations: {
        start: (input) => adapter.invoke("desktop_browser_annotations_start", { input }),
        cancel: (input) => adapter.invoke("desktop_browser_annotations_cancel", { input }),
        syncMarkers: (input) =>
          adapter.invoke("desktop_browser_annotations_sync_markers", { input }),
        onEvent: (listener) =>
          adapter.listen("desktop:browser-annotations-event", (payload) => {
            const parsed = parseBrowserAnnotationEvent(payload);
            if (parsed) listener(parsed);
          }),
      },
      onState: (listener) =>
        adapter.listen("desktop:browser-state", (state) => {
          if (typeof state === "object" && state !== null) {
            listener(state as Parameters<typeof listener>[0]);
          }
        }),
      onBrowserUseOpenPanelRequest: (listener) =>
        adapter.listen("desktop:browser-use-request-open-panel", (payload) => {
          const parsed = parseBrowserOpenPanelRequest(payload);
          if (parsed) listener(parsed);
        }),
      onBrowserCopyLink: (listener) =>
        adapter.listen("desktop:browser-copy-link", (payload) => {
          if (typeof payload === "object" && payload !== null) {
            listener(payload as Parameters<typeof listener>[0]);
          }
        }),
    },
  } satisfies DesktopBridge;
}

if (typeof window !== "undefined" && !window.desktopBridge) {
  const boot = window.__SAINT_TAURI_BOOT__ ?? {
    wsUrl: null,
    zoomFactor: 1,
  };
  window.desktopBridge = createTauriDesktopBridge(boot);
}
