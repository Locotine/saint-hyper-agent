// FILE: officeAssets.ts
// Purpose: Lazily loads the buffalo office asset pack v2 (environment, UI overlays, six skins)
//          as Pixi spritesheets, picking @2x atlases on HiDPI screens. Vite serves the files from
//          assets/buffalo_mascot_pack; nothing loads until the office mounts.
// Layer: Web office renderer
// Exports: loadOfficeAssets, OfficeAssets

import {
  AnimatedSprite,
  Assets,
  NineSliceSprite,
  Sprite,
  Spritesheet,
  type SpritesheetData,
  type Texture,
} from "pixi.js";

import type { OfficeAnim, OfficeDirection } from "../officeBehavior.logic";
import { SKIN_IDS, type SkinId } from "../officeModel.logic";

type AtlasData = SpritesheetData & {
  readonly frames: Record<string, { readonly pivot?: { readonly x: number; readonly y: number } }>;
};

// Vite globs keep the reference images and the unused rig-layer atlas out of the build.
const JSON_1X = import.meta.glob<AtlasData>(
  [
    "../../../../../../assets/buffalo_mascot_pack/atlases/@1x/*.json",
    "!../../../../../../assets/buffalo_mascot_pack/atlases/**/buffalo_rig_layers*",
  ],
  { import: "default" },
);
const JSON_2X = import.meta.glob<AtlasData>(
  [
    "../../../../../../assets/buffalo_mascot_pack/atlases/@2x/*.json",
    "!../../../../../../assets/buffalo_mascot_pack/atlases/**/buffalo_rig_layers*",
  ],
  { import: "default" },
);
const PNG_1X = import.meta.glob<string>(
  [
    "../../../../../../assets/buffalo_mascot_pack/atlases/@1x/*.png",
    "!../../../../../../assets/buffalo_mascot_pack/atlases/**/buffalo_rig_layers*",
  ],
  { import: "default", query: "?url" },
);
const PNG_2X = import.meta.glob<string>(
  [
    "../../../../../../assets/buffalo_mascot_pack/atlases/@2x/*.png",
    "!../../../../../../assets/buffalo_mascot_pack/atlases/**/buffalo_rig_layers*",
  ],
  { import: "default", query: "?url" },
);

type AtlasName = "office_environment_and_props" | "ui_overlays" | SkinId;

async function loadAtlas(name: AtlasName, hiDpi: boolean): Promise<Spritesheet<AtlasData>> {
  const suffix = hiDpi ? "@2x" : "";
  const pick = <T>(table: Record<string, () => Promise<T>>, ext: string) => {
    const key = Object.keys(table).find((path) => path.endsWith(`/${name}${suffix}.${ext}`));
    if (!key) throw new Error(`Office atlas ${name}${suffix}.${ext} is missing`);
    return table[key]!();
  };
  const [data, url] = await Promise.all([
    pick(hiDpi ? JSON_2X : JSON_1X, "json"),
    pick(hiDpi ? PNG_2X : PNG_1X, "png"),
  ]);
  const texture = await Assets.load<Texture>(url);
  const sheet = new Spritesheet<AtlasData>(texture, data);
  await sheet.parse();
  return sheet;
}

export interface OfficeAssets {
  /** Static sprite anchored at the frame's pivot from the atlas. */
  readonly sprite: (name: string) => Sprite;
  readonly texture: (name: string) => Texture;
  readonly nineSlice: (name: string, borders: number) => NineSliceSprite;
  readonly animation: (skin: SkinId, direction: OfficeDirection, anim: OfficeAnim) => Texture[];
  readonly animated: (frames: readonly string[]) => AnimatedSprite;
}

let loaded: { readonly hiDpi: boolean; readonly assets: Promise<OfficeAssets> } | null = null;

/** Loads once per page and resolution; textures outlive any one office canvas. */
export function loadOfficeAssets(): Promise<OfficeAssets> {
  const hiDpi = (window.devicePixelRatio || 1) >= 1.5;
  if (loaded?.hiDpi !== hiDpi) {
    const assets = loadAll(hiDpi);
    loaded = { hiDpi, assets };
    // A failed load (offline, missing file) may be retried by the next mount.
    assets.catch(() => {
      if (loaded?.assets === assets) loaded = null;
    });
  }
  return loaded!.assets;
}

async function loadAll(hiDpi: boolean): Promise<OfficeAssets> {
  const [env, ui, ...skins] = await Promise.all([
    loadAtlas("office_environment_and_props", hiDpi),
    loadAtlas("ui_overlays", hiDpi),
    ...SKIN_IDS.map((skin) => loadAtlas(skin, hiDpi)),
  ]);
  const skinSheets = new Map(SKIN_IDS.map((skin, i) => [skin, skins[i]!]));
  const sheets = [env, ui];

  const texture = (name: string): Texture => {
    for (const sheet of sheets) {
      const found = sheet.textures[name];
      if (found) return found;
    }
    throw new Error(`Office sprite ${name} is missing`);
  };
  const pivot = (name: string) =>
    sheets.find((sheet) => sheet.data.frames[name])?.data.frames[name]?.pivot ?? { x: 0.5, y: 0.5 };

  return {
    texture,
    sprite: (name) => {
      const sprite = new Sprite(texture(name));
      const { x, y } = pivot(name);
      sprite.anchor.set(x, y);
      return sprite;
    },
    nineSlice: (name, borders) =>
      new NineSliceSprite({
        texture: texture(name),
        leftWidth: borders,
        rightWidth: borders,
        topHeight: borders,
        bottomHeight: borders,
      }),
    animation: (skin, direction, anim) => {
      const frames = skinSheets.get(skin)?.animations[`${direction}/${anim}`];
      if (!frames) throw new Error(`Office animation ${skin} ${direction}/${anim} is missing`);
      return frames;
    },
    animated: (frames) => {
      const sprite = new AnimatedSprite(frames.map(texture));
      sprite.anchor.set(0.5, 0.95);
      return sprite;
    },
  };
}
