import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasSamplePoints, imageAlphaSampler } from "../../electron/workspace-transparency";

for (const [width, height] of [[1440, 960], [900, 640], [1100, 720]]) {
  test(`canvas alpha samples avoid opaque content at ${width} by ${height}`, () => {
    const geometry = { viewport: { width, height }, transcript: { left: 224, top: 120, height: height - 300, clientLeft: 17, paddingLeft: 28 } };
    const bitmap = Buffer.alloc(width * height * 4);
    // Opaque message/skeleton content may cover all former percentage probes.
    const contentLeft = geometry.transcript.left + geometry.transcript.clientLeft + geometry.transcript.paddingLeft;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bitmap[(y * width + x) * 4 + 3] = x < contentLeft ? 224 : 255;
    const alpha = imageAlphaSampler({
      getSize(scale) { assert.equal(scale, 1); return { width, height }; },
      toBitmap(options) { assert.equal(options?.scaleFactor, 1); return bitmap; },
    });
    assert.deepEqual([[0.55, 0.3], [0.65, 0.6], [0.7, 0.4]].map(([x, y]) => alpha(x, y)), [255, 255, 255]);
    const points = canvasSamplePoints(geometry);
    assert.deepEqual(points.map(point => alpha(point.x, point.y)), [224, 224, 224]);
    // An actually opaque canvas must still fail the same pixel requirement.
    bitmap.fill(255);
    assert.ok(points.every(point => alpha(point.x, point.y) === 255));
  });
}

test("missing canvas geometry and inconsistent bitmap representations cannot pass transparency checks", () => {
  const geometry = { viewport: { width: 1440, height: 960 }, transcript: { left: 224, top: 120, height: 500, clientLeft: 17, paddingLeft: 0 } };
  assert.throws(() => canvasSamplePoints(geometry), /no visible sampling area/);
  assert.throws(() => canvasSamplePoints({ ...geometry, transcript: { ...geometry.transcript, paddingLeft: 28, left: 1600 } }), /outside the viewport/);
  assert.throws(() => imageAlphaSampler({ getSize: () => ({ width: 20, height: 20 }), toBitmap: () => Buffer.alloc(10) }), /dimensions/);
  const alpha = imageAlphaSampler({ getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.from([0, 0, 0, 224]) });
  assert.equal(alpha(0.5, 0.5), 224);
  assert.throws(() => alpha(1, 0.5), /outside/);
});
