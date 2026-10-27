export const BROWSER_PANEL_BOUNDS_SYNC_EVENT = "saint:browser-panel-bounds-sync";

export function requestBrowserPanelBoundsSync(): void {
  window.dispatchEvent(new Event(BROWSER_PANEL_BOUNDS_SYNC_EVENT));
}
