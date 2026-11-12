import { ProviderKind } from "@saint/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OFFICE_ANIMS, OFFICE_DIRECTIONS } from "./officeBehavior.logic";
import {
  BUBBLE_SPRITES,
  DESK_VARIANTS,
  SKIN_IDS,
  TYPING_BUBBLE_FRAMES,
  deskSprites,
  monitorSprite,
  palette,
  providerIconSprite,
} from "./officeModel.logic";

const PACK = join(import.meta.dirname, "../../../../../assets/buffalo_mascot_pack/atlases");
const OFFICE_DIR = import.meta.dirname;

interface Atlas {
  readonly frames: Record<string, unknown>;
  readonly animations?: Record<string, readonly string[]>;
}

function atlas(scale: "@1x" | "@2x", name: string): Atlas {
  const suffix = scale === "@2x" ? "@2x" : "";
  return JSON.parse(readFileSync(join(PACK, scale, `${name}${suffix}.json`), "utf8")) as Atlas;
}

/** Every `env/…`, `ui/…` or `props/…` frame name written as a literal in office source. */
function literalSpriteNames(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        for (const match of readFileSync(path, "utf8").matchAll(
          /"((?:env|ui|props)\/[a-z0-9_]+\.png)"/g,
        )) {
          names.add(match[1]!);
        }
      }
    }
  };
  walk(OFFICE_DIR);
  return [...names];
}

function usedSpriteNames(): string[] {
  const names = new Set(literalSpriteNames());
  for (const tier of ["root", "nested", "leaf"] as const) {
    for (let variant = 0; variant < DESK_VARIANTS; variant += 1) {
      const sprites = deskSprites(tier, variant);
      for (const name of [sprites.desk, sprites.seat, sprites.backrest, sprites.full]) {
        names.add(name);
      }
      if (sprites.badge) names.add(sprites.badge);
    }
  }
  for (const provider of [...ProviderKind.literals, null]) names.add(providerIconSprite(provider));
  for (const duty of ["working", "approval", "input", "error", "idle", null] as const) {
    for (const skin of [...SKIN_IDS, null]) names.add(monitorSprite(duty, skin));
  }
  for (const name of [...Object.values(BUBBLE_SPRITES), ...TYPING_BUBBLE_FRAMES]) names.add(name);
  return [...names];
}

describe.each(["@1x", "@2x"] as const)("asset pack %s", (scale) => {
  const env = atlas(scale, "office_environment_and_props");
  const ui = atlas(scale, "ui_overlays");

  it("has every sprite the office uses", () => {
    const names = usedSpriteNames();
    expect(names.length).toBeGreaterThan(40);
    const missing = names.filter((name) => !(name in env.frames) && !(name in ui.frames));
    expect(missing).toEqual([]);
  });

  it("has every animation in every skin and direction", () => {
    expect(SKIN_IDS).toEqual(Object.keys(palette.skins));
    for (const skin of SKIN_IDS) {
      const sheet = atlas(scale, skin);
      for (const direction of OFFICE_DIRECTIONS) {
        for (const anim of OFFICE_ANIMS) {
          const frames = sheet.animations?.[`${direction}/${anim}`];
          expect(frames?.length, `${skin} ${direction}/${anim}`).toBeGreaterThan(0);
          for (const frame of frames ?? []) expect(frame in sheet.frames).toBe(true);
        }
      }
    }
  });
});
