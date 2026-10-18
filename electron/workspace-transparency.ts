import type { NativeImage } from "electron";

export type CanvasGeometry = {
  viewport: { width: number; height: number };
  transcript: { left: number; top: number; height: number; clientLeft: number; paddingLeft: number };
};

/** Sample inside the transcript's padding, outside messages and loading cards. */
export function canvasSamplePoints({ viewport, transcript }: CanvasGeometry) {
  const x = transcript.left + transcript.clientLeft + transcript.paddingLeft / 2;
  if (![viewport.width, viewport.height, transcript.height, transcript.paddingLeft].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("The transcript has no visible sampling area");
  }
  return [0.25, 0.5, 0.75].map(fraction => {
    const y = transcript.top + transcript.height * fraction;
    if (!(x > 0 && x < viewport.width && y > 0 && y < viewport.height)) throw new Error("Canvas sample is outside the viewport");
    return { x: x / viewport.width, y: y / viewport.height };
  });
}

/** Use one NativeImage representation for both dimensions and pixel storage. */
export function imageAlphaSampler(image: Pick<NativeImage, "getSize" | "toBitmap">) {
  const size = image.getSize(1);
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  if (size.width <= 0 || size.height <= 0 || bitmap.length !== size.width * size.height * 4) {
    throw new Error("Captured bitmap dimensions do not match its pixel storage");
  }
  return (x: number, y: number) => {
    if (!(x >= 0 && x < 1 && y >= 0 && y < 1)) throw new Error("Alpha sample is outside the captured image");
    return bitmap[(Math.floor(y * size.height) * size.width + Math.floor(x * size.width)) * 4 + 3];
  };
}
