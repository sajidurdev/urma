import { UrmaError } from "./errors.js";

export type FrameCrop = Readonly<{ x: number; y: number; w: number; h: number }>;
export type FrameCropGeometry = Readonly<{
  coordinates: "displayed-source-percent";
  requested: FrameCrop;
  sourceWidth: number;
  sourceHeight: number;
  pixels: Readonly<{ x: number; y: number; width: number; height: number }>;
}>;

export function validateFrameCrop(crop: FrameCrop): FrameCrop {
  if (!crop || Object.keys(crop).length !== 4 ||
    ![crop.x, crop.y, crop.w, crop.h].every(Number.isFinite) ||
    crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 ||
    crop.x >= 100 || crop.y >= 100 || crop.w > 100 || crop.h > 100 ||
    crop.x + crop.w > 100 + 1e-9 || crop.y + crop.h > 100 + 1e-9) {
    throw new UrmaError("INVALID_SOURCE",
      "crop requires finite x,y,w,h percentages: x,y >= 0, w,h > 0, x+w and y+h <= 100; use coordinates of the individual displayed source frame");
  }
  return { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
}

/** Include every intersected source pixel, clamping the far edge to the frame. */
export function frameCropGeometry(crop: FrameCrop, width: number, height: number): FrameCropGeometry {
  crop = validateFrameCrop(crop);
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 32768) ||
    width * height > 64 * 1024 * 1024) {
    throw new UrmaError("MEDIA_INVALID", "Displayed source geometry exceeds the crop limit of 32768 pixels per side or 64 megapixels");
  }
  const x = Math.min(width - 1, Math.floor(width * crop.x / 100));
  const y = Math.min(height - 1, Math.floor(height * crop.y / 100));
  return {
    coordinates: "displayed-source-percent", requested: crop,
    sourceWidth: width, sourceHeight: height,
    pixels: {
      x, y,
      width: Math.max(1, Math.min(width, Math.ceil(width * (crop.x + crop.w) / 100)) - x),
      height: Math.max(1, Math.min(height, Math.ceil(height * (crop.y + crop.h) / 100)) - y),
    },
  };
}
