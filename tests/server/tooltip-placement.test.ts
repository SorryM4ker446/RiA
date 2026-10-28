import assert from "node:assert/strict";
import { test } from "node:test";
import { placeTooltip } from "@/components/ui/app-tooltips";

const view = { width: 1280, height: 800 };

test("a tooltip goes above its element when it fits there, and below when it does not", () => {
  const anchor = { top: 400, bottom: 432, left: 600, right: 632 };
  assert.deepEqual(placeTooltip(anchor, { width: 100, height: 30 }, view), { side: "top", top: 364, left: 566 });
  // An element near the top: three lines do not fit above it.
  const near = { top: 52, bottom: 84, left: 600, right: 632 };
  assert.equal(placeTooltip(near, { width: 100, height: 60 }, view).side, "bottom");
});

test("a tooltip near a corner slides along the edge instead of hanging off it", () => {
  // The long-term memory switch in the window's top-right corner.
  const corner = { top: 60, bottom: 92, left: 1180, right: 1270 };
  const place = placeTooltip(corner, { width: 352, height: 64 }, view);
  assert.equal(place.left, view.width - 8 - 352);
  assert.equal(place.side, "bottom");
  assert.ok(place.top >= corner.bottom);
});

test("a tooltip larger than the room on either side takes the roomier side and stays in the window", () => {
  const short = { width: 1280, height: 200 };
  const middle = { top: 90, bottom: 110, left: 600, right: 640 };
  // 76px of room on each side for a 150px tooltip: it keeps the preferred side and is held 8px from the top.
  assert.deepEqual(placeTooltip(middle, { width: 200, height: 150 }, short), { side: "top", top: 8, left: 520 });
});
