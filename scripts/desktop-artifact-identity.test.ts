import { describe, expect, it } from "vitest";

import {
  resolveSaintDesktopRuntimeFlavor,
  saintDesktopIdentity,
} from "@saint/shared/desktopIdentity";
import { createDesktopArtifactIdentity } from "./lib/desktop-artifact-identity.ts";

describe("desktop artifact identity", () => {
  it.each(["mac", "win"] as const)(
    "preserves the production %s package and artifact names",
    (platform) => {
      const result = createDesktopArtifactIdentity({ platform, flavor: "production" });
      expect(result.packageMetadata).toEqual({
        name: "saint-desktop",
        productName: "Saint",
        saintDesktopFlavor: "production",
      });
      expect(result.buildConfig).toEqual({
        appId: "com.locotine.saint",
        productName: "Saint",
        artifactName: "Saint-${version}-${arch}.${ext}",
      });
      expect(result.releaseDirectoryName).toBe("release");
      expect(result.identity.usesScriptedUpdates).toBe(false);
    },
  );

  it.each(["canary", "cua"] as const)(
    "keeps packaged %s metadata, native identity, origin, storage and updater policy aligned",
    (flavor) => {
      const result = createDesktopArtifactIdentity({ platform: "mac", flavor });
      const packagedJson = JSON.parse(JSON.stringify(result.packageMetadata));
      const runtimeFlavor = resolveSaintDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        packagedFlavor: packagedJson.saintDesktopFlavor,
        requestedFlavor: "production",
      });
      const runtimeIdentity = saintDesktopIdentity(runtimeFlavor);
      expect(runtimeIdentity).toEqual(result.identity);
      expect(result.buildConfig.appId).toBe(runtimeIdentity.bundleId);
      expect(result.packageMetadata.productName).toBe(result.buildConfig.productName);
      expect(result.packageMetadata.name).toBe(`saint-desktop-${flavor}`);
      expect(result.buildConfig.protocols).toEqual([
        { name: runtimeIdentity.displayName, schemes: [runtimeIdentity.scheme] },
      ]);
      expect(runtimeIdentity.userDataDirectoryName).toBe(`saint-${flavor}`);
      expect(runtimeIdentity.defaultHomeDirectoryName).toBe(`.saint-${flavor}`);
      expect(runtimeIdentity.usesScriptedUpdates).toBe(true);
      expect(result.releaseDirectoryName).toBe(`release-${flavor}`);
      expect(result.buildConfig.artifactName).not.toBe("Saint-${version}-${arch}.${ext}");
    },
  );

  it.each(["canary", "cua"] as const)(
    "refuses %s on Windows until it has an isolated installer registration",
    (flavor) => {
      expect(() => createDesktopArtifactIdentity({ platform: "win", flavor })).toThrow(
        "macOS and Linux only",
      );
    },
  );
});
