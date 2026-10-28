// FILE: installerCount.ts
// Purpose: Serves the stored installer download total.
// Layer: Server utility
// Depends on: src/data/installer-downloads.json
// Note: There is no live source; the total stays at the snapshot carried over
//       from earlier release hosts.

import "server-only";

import storedInstallerDownloads from "@/data/installer-downloads.json";

// The count the deterministic browser fixture (VISUAL_TEST=1) renders. The
// visual baselines were captured with this value, and it must not follow the
// snapshot JSON or every refresh would invalidate them.
const VISUAL_TEST_INSTALLER_COUNT = 11_990;

export function getStoredInstallerCount(): number | null {
  if (process.env.VISUAL_TEST === "1") return VISUAL_TEST_INSTALLER_COUNT;
  return storedInstallerDownloads.count > 0 ? storedInstallerDownloads.count : null;
}

export async function getInstallerCount(): Promise<number | null> {
  return getStoredInstallerCount();
}
