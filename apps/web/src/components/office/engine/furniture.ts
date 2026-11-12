// FILE: furniture.ts
// Purpose: Office furniture from the asset pack: one depth-sorted group per desk (desk, chair
//          seat, monitor, seated buffalo, chair backrest) and the amenity column (coffee bar,
//          treadmill, WC stall). Groups sort with walking characters by their base y.
// Layer: Web office renderer
// Exports: buildFurniture, FurnitureSet, DeskHandle, DESK_LAYER

import { Container, type Sprite } from "pixi.js";

import type { DeskSlot, OfficeLayout } from "../officeLayout.logic";
import { deskSprites } from "../officeModel.logic";
import type { OfficeAssets } from "./officeAssets";

/** zIndex layers inside a desk group. */
export const DESK_LAYER = { desk: 10, monitor: 20, buffalo: 30, backrest: 40 } as const;
const CHAIR_DY = 20;
/** Raised from the pack's -18 to the back of the desk so the screen reads above the head. */
const MONITOR_DY = -32;
/** Desk groups sort just in front of a character standing at the chair's base. */
const GROUP_DEPTH = 33;

export interface DeskHandle {
  readonly slot: DeskSlot;
  readonly group: Container;
  /** Seat and backrest around a seated buffalo, or the tucked-in chair; and the screen. */
  readonly setState: (seated: boolean, monitor: string) => void;
  /** Interactive sprite for hover and tap. */
  readonly hit: Sprite;
}

export interface FurnitureSet {
  readonly desks: readonly DeskHandle[];
  /** Depth-sorted pieces; add them to the same sortable layer as characters. */
  readonly pieces: readonly Container[];
  readonly setToiletBusy: (busy: boolean) => void;
}

function buildDesk(slot: DeskSlot, assets: OfficeAssets): DeskHandle {
  const names = deskSprites(slot.tier, slot.variant);
  const { x, y } = slot.anchor;
  const group = new Container();
  group.sortableChildren = true;
  group.zIndex = y + GROUP_DEPTH;
  const place = (name: string, dy: number, z: number) => {
    const sprite = assets.sprite(name);
    sprite.position.set(x, y + dy);
    sprite.zIndex = z;
    group.addChild(sprite);
    return sprite;
  };
  const desk = place(names.desk, 0, DESK_LAYER.desk);
  const seat = place(names.seat, CHAIR_DY, DESK_LAYER.desk);
  const monitor = place("env/monitor_off.png", MONITOR_DY, DESK_LAYER.monitor);
  const backrest = place(names.backrest, CHAIR_DY, DESK_LAYER.backrest);
  const full = place(names.full, CHAIR_DY, DESK_LAYER.backrest);
  desk.eventMode = "static";
  desk.cursor = "pointer";
  const setState = (seated: boolean, screen: string) => {
    seat.visible = seated;
    backrest.visible = seated;
    full.visible = !seated;
    monitor.texture = assets.texture(screen);
  };
  setState(false, "env/monitor_off.png");
  return { slot, group, setState, hit: desk };
}

export function buildFurniture(layout: OfficeLayout, assets: OfficeAssets): FurnitureSet {
  const desks = layout.desks.map((slot) => buildDesk(slot, assets));
  const pieces: Container[] = desks.map((desk) => desk.group);
  const { amenities } = layout;
  const add = (name: string, at: { x: number; y: number }, z: number) => {
    const sprite = assets.sprite(name);
    sprite.position.set(at.x, at.y);
    sprite.zIndex = z;
    pieces.push(sprite);
    return sprite;
  };

  add("env/coffee_counter_station.png", amenities.coffeeCounter, amenities.coffeeCounter.y);
  add("env/coffee_machine.png", amenities.coffeeMachine, amenities.coffeeCounter.y + 1);
  // The runner stands on the belt, in front of the frame.
  add("env/treadmill.png", amenities.treadmill, amenities.runner.y - 1);
  add("env/wall_straight_sw.png", amenities.wcWall, amenities.sitter.y - 2);
  add("env/wc_toilet.png", amenities.toilet, amenities.sitter.y - 1);
  const door = add("env/wc_door_free_green.png", amenities.wcDoor, amenities.wcDoor.y);

  return {
    desks,
    pieces,
    setToiletBusy: (busy) => {
      door.texture = assets.texture(
        busy ? "env/wc_door_busy_red.png" : "env/wc_door_free_green.png",
      );
    },
  };
}
