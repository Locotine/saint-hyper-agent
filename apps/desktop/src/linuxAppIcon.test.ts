// FILE: linuxAppIcon.test.ts
// Purpose: Guards the Linux icon-theme writer: desktop-entry icon resolution across XDG
//          directories, the declared size set, and leaving unchanged artwork alone.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LINUX_APP_ICON_SIZES,
  desktopEntryIconName,
  linuxDataHome,
  persistLinuxAppIcon,
  resolveLinuxDesktopIconName,
} from "./linuxAppIcon";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "saint-linux-icon-"));
  temporaryDirectories.push(directory);
  return directory;
}

function desktopEntry(iconLine: string): string {
  // Mirrors the installed Beta entry: the icon belongs to the desktop entry group, while the
  // trailing Uninstall action carries the trash icon.
  return `[Desktop Entry]\nType=Application\nName=Saint Beta\n${iconLine}\n[Desktop Action Uninstall]\nName=Move to Trash\nIcon=user-trash\n`;
}

function writeDesktopEntry(directory: string, fileName: string, contents: string): void {
  const applications = Path.join(directory, "applications");
  FS.mkdirSync(applications, { recursive: true });
  FS.writeFileSync(Path.join(applications, fileName), contents, "utf8");
}

describe("desktopEntryIconName", () => {
  it("reads the icon name of the desktop entry group only", () => {
    expect(desktopEntryIconName(desktopEntry("Icon=saint-beta"))).toBe("saint-beta");
    expect(desktopEntryIconName(desktopEntry("Icon= saint-beta "))).toBe("saint-beta");
    expect(desktopEntryIconName(desktopEntry("Icon=saint-beta").replace(/\n/g, "\r\n"))).toBe(
      "saint-beta",
    );
  });

  it("gives up when the entry has no theme name to cover", () => {
    // An absolute path is a private file, and a relative one is not a theme lookup name.
    expect(desktopEntryIconName(desktopEntry("Icon=/home/gabriel/.icons/saint.png"))).toBeNull();
    expect(desktopEntryIconName(desktopEntry("Icon=./saint.png"))).toBeNull();
    expect(desktopEntryIconName(desktopEntry("Icon=icons/saint"))).toBeNull();
    expect(desktopEntryIconName(desktopEntry("Name=Saint Beta"))).toBeNull();
  });
});

describe("resolveLinuxDesktopIconName", () => {
  it("prefers the data home over the data dirs", () => {
    const dataHome = temporaryDirectory();
    const dataDir = temporaryDirectory();
    const betaFile = "saint-beta.desktop";
    writeDesktopEntry(dataDir, betaFile, desktopEntry("Icon=saint-beta"));
    const env = { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: `/nonexistent:${dataDir}` };
    const homeDir = temporaryDirectory();

    expect(
      resolveLinuxDesktopIconName({
        env,
        homeDir,
        flavor: "beta",
      }),
    ).toBe("saint-beta");

    writeDesktopEntry(dataHome, betaFile, desktopEntry("Icon=saint-beta-custom"));
    expect(
      resolveLinuxDesktopIconName({
        env,
        homeDir,
        flavor: "beta",
      }),
    ).toBeNull();
  });

  it("keeps the entry it finds first authoritative", () => {
    const dataHome = temporaryDirectory();
    const dataDir = temporaryDirectory();
    const stableFile = "saint.desktop";
    writeDesktopEntry(dataHome, stableFile, desktopEntry("Icon=/tmp/custom.png"));
    writeDesktopEntry(dataDir, stableFile, desktopEntry("Icon=saint"));

    expect(
      resolveLinuxDesktopIconName({
        env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDir },
        homeDir: temporaryDirectory(),
        flavor: "production",
      }),
    ).toBeNull();
  });

  it("keeps installed flavor icons isolated, including a customized entry naming another app", () => {
    const dataHome = temporaryDirectory();
    const dataDir = temporaryDirectory();
    const env = { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDir };
    const homeDir = temporaryDirectory();
    const flavors = [
      ["production", "saint"],
      ["beta", "saint-beta"],
      ["canary", "saint-canary"],
      ["cua", "saint-cua"],
    ] as const;
    for (const [, iconName] of flavors) {
      writeDesktopEntry(dataHome, `${iconName}.desktop`, desktopEntry(`Icon=${iconName}`));
    }
    for (const [flavor, iconName] of flavors) {
      const resolved = resolveLinuxDesktopIconName({ env, homeDir, flavor });
      expect(resolved).toBe(iconName);
      if (resolved) {
        persistLinuxAppIcon({
          dataHome,
          iconName: resolved,
          renderPng: () => Buffer.from(flavor),
        });
      }
    }
    for (const [flavor, iconName] of flavors) {
      expect(
        FS.readFileSync(
          Path.join(dataHome, "icons/hicolor/256x256/apps", `${iconName}.png`),
          "utf8",
        ),
      ).toBe(flavor);
    }
    for (const sharedIcon of ["saint", "saint-beta", "firefox"]) {
      writeDesktopEntry(dataHome, "saint-canary.desktop", desktopEntry(`Icon=${sharedIcon}`));
      expect(resolveLinuxDesktopIconName({ env, homeDir, flavor: "canary" })).toBeNull();
    }
  });

  it("finds no icon without an installed entry, which is the case for source runs", () => {
    expect(
      resolveLinuxDesktopIconName({
        env: { XDG_DATA_DIRS: temporaryDirectory() },
        homeDir: temporaryDirectory(),
        flavor: "production",
      }),
    ).toBeNull();
  });

  it("ignores relative data dirs", () => {
    const dataHome = temporaryDirectory();
    expect(
      resolveLinuxDesktopIconName({
        env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: "../../etc:relative/share" },
        homeDir: temporaryDirectory(),
        flavor: "production",
      }),
    ).toBeNull();
  });
});

describe("linuxDataHome", () => {
  it("uses an absolute XDG_DATA_HOME and ignores a relative one", () => {
    expect(linuxDataHome({ XDG_DATA_HOME: "/data/home" }, "/home/gabriel")).toBe("/data/home");
    expect(linuxDataHome({ XDG_DATA_HOME: "crumbs" }, "/home/gabriel")).toBe(
      "/home/gabriel/.local/share",
    );
    expect(linuxDataHome({}, "/home/gabriel")).toBe("/home/gabriel/.local/share");
  });
});

describe("persistLinuxAppIcon", () => {
  const iconPathFor = (dataHome: string, size: number, iconName = "saint-beta") =>
    Path.join(dataHome, "icons", "hicolor", `${size}x${size}`, "apps", `${iconName}.png`);

  it("writes every declared size under the entry's own icon name", () => {
    const dataHome = temporaryDirectory();
    const changed = persistLinuxAppIcon({
      dataHome,
      iconName: "saint-beta",
      renderPng: (size) => Buffer.from(`png-${size}`),
    });

    expect(changed).toBe(true);
    for (const size of LINUX_APP_ICON_SIZES) {
      expect(FS.readFileSync(iconPathFor(dataHome, size), "utf8")).toBe(`png-${size}`);
    }
    expect(FS.readdirSync(Path.dirname(iconPathFor(dataHome, 256)))).toEqual(["saint-beta.png"]);
  });

  it("leaves unchanged artwork alone so icon caches are not invalidated", () => {
    const dataHome = temporaryDirectory();
    const renderPng = (size: number) => Buffer.from(`png-${size}`);

    expect(persistLinuxAppIcon({ dataHome, iconName: "saint-beta", renderPng })).toBe(true);
    expect(persistLinuxAppIcon({ dataHome, iconName: "saint-beta", renderPng })).toBe(false);

    expect(
      persistLinuxAppIcon({
        dataHome,
        iconName: "saint-beta",
        renderPng: (size) => Buffer.from(`next-${size}`),
      }),
    ).toBe(true);
    expect(FS.readFileSync(iconPathFor(dataHome, 512), "utf8")).toBe("next-512");
  });

  it("refuses an icon name that would escape the apps directory", () => {
    const dataHome = temporaryDirectory();
    expect(() =>
      persistLinuxAppIcon({
        dataHome,
        iconName: "../../../startup/evil",
        renderPng: (size) => Buffer.from(`png-${size}`),
      }),
    ).toThrow(/unsafe name/);
    expect(FS.existsSync(Path.join(dataHome, "icons"))).toBe(false);
  });
});
