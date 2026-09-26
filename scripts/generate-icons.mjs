// Draws the PWA / home-screen icons (P5.1) with sharp, which the app already
// uses for photos. Run once after changing the design, and commit the PNGs:
//   node scripts/generate-icons.mjs
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/icons");
mkdirSync(OUT, { recursive: true });

const INK = "#171717"; // --primary (light theme)
const PAPER = "#fafafa";

/**
 * `inset` shrinks the artwork towards the centre: a maskable icon's safe zone
 * is the middle 80%, since Android may crop it to a circle.
 */
function svg(size, { rounded, inset = 0 }) {
  const r = rounded ? size * 0.22 : 0;
  const s = size * (1 - inset);
  const o = (size - s) / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="${INK}"/>
  <g transform="translate(${o} ${o}) scale(${s / 512})">
    <text x="256" y="318" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="220" letter-spacing="-6" fill="${PAPER}">AB</text>
    <rect x="146" y="360" width="220" height="14" rx="7" fill="${PAPER}" opacity="0.55"/>
  </g>
</svg>`);
}

const icons = [
  { file: "icon-192.png", size: 192, rounded: true },
  { file: "icon-512.png", size: 512, rounded: true },
  // Full-bleed, artwork inside the safe zone.
  { file: "maskable-512.png", size: 512, rounded: false, inset: 0.2 },
  // iOS rounds the corners itself and shows transparency as black.
  { file: "apple-touch-icon.png", size: 180, rounded: false, inset: 0.08 },
];

for (const icon of icons) {
  await sharp(svg(icon.size, icon)).png().toFile(path.join(OUT, icon.file));
  console.log(`wrote public/icons/${icon.file}`);
}
