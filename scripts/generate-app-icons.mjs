#!/usr/bin/env electron
// Generates the LobsterAI app icon set (macOS .icns, Windows .ico, Linux PNGs,
// notification icon) and the tray icons from a single source logo.
//
// Run through Electron so it can use `nativeImage` for decode/resize/encode,
// which keeps this script free of ImageMagick or other native image tooling:
//
//   npm run generate:app-icons
//   npm run generate:app-icons -- --source public/logo.png
//   npm run generate:app-icons -- --only=png,ico
//
// Geometry is matched to the icon set that shipped before this script: app
// icons keep the artwork at 84% of the canvas (the remaining 16% is the
// platform-standard transparent margin), tray icons are trimmed and fill the
// canvas edge to edge.
//
// `.icns` generation additionally needs macOS `iconutil`; other outputs work on
// any platform Electron can start on.

import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');

const DEFAULT_SOURCE = path.join(projectRoot, 'public', 'logo.png');
const APP_ICON_DIR = path.join(projectRoot, 'build', 'icons');
const PNG_DIR = path.join(APP_ICON_DIR, 'png');
const MAC_ICON = path.join(APP_ICON_DIR, 'mac', 'icon.icns');
const WIN_ICON = path.join(APP_ICON_DIR, 'win', 'icon.ico');
const TRAY_DIR = path.join(projectRoot, 'resources', 'tray');

// Referenced by electron-builder.json (mac/win/linux targets) and by
// getNotificationIconPath() in src/main/main.ts.
const APP_PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const APP_ART_RATIO = 0.84;

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// iconutil requires this exact name/size pairing inside the .iconset folder.
const ICNS_ENTRIES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

// Consumed by src/main/trayManager.ts and getAppIconPath() in src/main/main.ts.
// Sizes match the tray set that shipped before this script.
const TRAY_TARGETS = [
  { file: 'tray-icon.png', sizes: [48] },
  { file: 'tray-icon.ico', sizes: [16, 32, 48] },
  { file: 'tray-icon-mac.png', sizes: [22] },
  { file: 'tray-icon-mac@2x.png', sizes: [44] },
];
const TRAY_ART_RATIO = 1;

const ALPHA_THRESHOLD = 8;

function parseArgs(argv) {
  const args = {};
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    // Electron passes the app path (and possibly its own switches) first.
    if (value === scriptPath || value.endsWith(path.basename(scriptPath))) continue;
    if (!value.startsWith('--')) continue;
    const eq = value.indexOf('=');
    if (eq !== -1) {
      args[value.slice(2, eq)] = value.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[value.slice(2)] = next;
      i++;
    } else {
      args[value.slice(2)] = 'true';
    }
  }
  return args;
}

// Reads icon files by content: createFromPath() would apply macOS's `@2x`
// filename convention and report a 44px tray file as 22px.
function readImage(file) {
  return nativeImage.createFromBuffer(fs.readFileSync(file));
}

// Alpha bounding box of the visible artwork, used to trim the source logo and
// to verify generated output afterwards.
function measureArtwork(image) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (bitmap.length !== width * height * 4) {
    throw new Error(`unexpected bitmap size for ${width}x${height}: ${bitmap.length} bytes`);
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[(y * width + x) * 4 + 3] <= ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) {
    throw new Error('source image has no visible pixels');
  }
  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// Halve repeatedly before the final scale so large downscales keep their edges.
function resizeToFit(image, maxDim) {
  const size = image.getSize();
  const scale = maxDim / Math.max(size.width, size.height);
  const targetWidth = Math.max(1, Math.round(size.width * scale));
  const targetHeight = Math.max(1, Math.round(size.height * scale));

  let current = image;
  for (;;) {
    const currentSize = current.getSize();
    const halfWidth = Math.round(currentSize.width / 2);
    const halfHeight = Math.round(currentSize.height / 2);
    if (halfWidth < targetWidth || halfHeight < targetHeight) break;
    current = current.resize({ width: halfWidth, height: halfHeight, quality: 'best' });
  }
  return current.resize({ width: targetWidth, height: targetHeight, quality: 'best' });
}

// Centres the trimmed artwork on a transparent square canvas.
function composeIcon(artwork, size, artRatio) {
  const artMax = Math.max(1, Math.round(size * artRatio));
  const art = resizeToFit(artwork, artMax);
  const { width: artWidth, height: artHeight } = art.getSize();
  const source = art.toBitmap();
  const canvas = Buffer.alloc(size * size * 4);
  const offsetX = Math.floor((size - artWidth) / 2);
  const offsetY = Math.floor((size - artHeight) / 2);

  for (let y = 0; y < artHeight; y++) {
    const sourceStart = y * artWidth * 4;
    canvas.set(source.subarray(sourceStart, sourceStart + artWidth * 4), ((offsetY + y) * size + offsetX) * 4);
  }
  return nativeImage.createFromBitmap(canvas, { width: size, height: size, scaleFactor: 1 });
}

// ICO container holding PNG frames (Vista and later read these natively).
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(16 * frames.length);
  let offset = header.length + directory.length;
  frames.forEach((frame, index) => {
    const entry = index * 16;
    const dimension = frame.size >= 256 ? 0 : frame.size;
    directory.writeUInt8(dimension, entry);
    directory.writeUInt8(dimension, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.png.length;
  });

  return Buffer.concat([header, directory, ...frames.map(frame => frame.png)]);
}

function writeFile(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  const relative = path.relative(projectRoot, target);
  console.log(`  ${relative} (${(contents.length / 1024).toFixed(1)} KB)`);
}

function verifyPng(target, expectedSize, expectedRatio) {
  const image = readImage(target);
  const { width, height } = image.getSize();
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${target}: expected ${expectedSize}x${expectedSize}, got ${width}x${height}`);
  }
  const art = measureArtwork(image);
  const artPixels = Math.max(art.width, art.height);
  const expectedPixels = Math.round(expectedSize * expectedRatio);
  // Tray icons trim to the canvas, so only the padded app icons are checked.
  if (expectedRatio < 1 && Math.abs(artPixels - expectedPixels) > 1) {
    throw new Error(`${target}: artwork is ${artPixels}px, expected ${expectedPixels}px on a ${expectedSize}px canvas`);
  }
}

function writeIconsetEntry(directory, name, image) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, image.toPNG());
}

function generateIcns(render) {
  if (process.platform !== 'darwin') {
    console.warn('[icons] skipped .icns: iconutil is macOS-only');
    return;
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-iconset-'));
  const iconsetDir = path.join(workDir, 'icon.iconset');
  fs.mkdirSync(iconsetDir, { recursive: true });
  for (const [name, size] of ICNS_ENTRIES) {
    writeIconsetEntry(iconsetDir, name, render(size, APP_ART_RATIO));
  }
  try {
    const result = spawnSync('iconutil', ['-c', 'icns', iconsetDir, '-o', MAC_ICON], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `iconutil exited with ${result.status}`);
    }
    console.log(`  ${path.relative(projectRoot, MAC_ICON)} (${(fs.statSync(MAC_ICON).size / 1024).toFixed(1)} KB)`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function generateAppIcons(render) {
  console.log('[icons] app icon set');
  for (const size of APP_PNG_SIZES) {
    const target = path.join(PNG_DIR, `${size}x${size}.png`);
    writeFile(target, render(size, APP_ART_RATIO).toPNG());
    verifyPng(target, size, APP_ART_RATIO);
  }

  console.log('[icons] windows installer icon');
  const icoFrames = ICO_SIZES.map(size => ({ size, png: render(size, APP_ART_RATIO).toPNG() }));
  writeFile(WIN_ICON, buildIco(icoFrames));
}

function generateTrayIcons(render) {
  console.log('[icons] tray icons');
  for (const target of TRAY_TARGETS) {
    const destination = path.join(TRAY_DIR, target.file);
    if (target.file.endsWith('.ico')) {
      const frames = target.sizes.map(size => ({ size, png: render(size, TRAY_ART_RATIO).toPNG() }));
      writeFile(destination, buildIco(frames));
      continue;
    }
    for (const size of target.sizes) {
      writeFile(destination, render(size, TRAY_ART_RATIO).toPNG());
      verifyPng(destination, size, TRAY_ART_RATIO);
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const sourcePath = args.source ? path.resolve(process.cwd(), args.source) : DEFAULT_SOURCE;
  const only = (args.only ? String(args.only) : 'png,ico,icns,tray')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`source logo not found: ${sourcePath}`);
  }

  const source = readImage(sourcePath);
  if (source.isEmpty()) {
    throw new Error(`source logo could not be decoded: ${sourcePath}`);
  }
  const artworkBox = measureArtwork(source);
  const trimmed = source.crop({
    x: artworkBox.minX,
    y: artworkBox.minY,
    width: artworkBox.width,
    height: artworkBox.height,
  });
  const sourceSize = source.getSize();
  console.log(
    `[icons] source ${path.relative(projectRoot, sourcePath)} ${sourceSize.width}x${sourceSize.height}`
    + ` -> artwork ${artworkBox.width}x${artworkBox.height}`,
  );

  const render = (size, artRatio) => composeIcon(trimmed, size, artRatio);

  if (only.includes('png') || only.includes('ico')) generateAppIcons(render);
  if (only.includes('icns')) generateIcns(render);
  if (only.includes('tray')) generateTrayIcons(render);

  console.log('[icons] done');
}

app.dock?.hide();

app.whenReady().then(() => {
  try {
    main();
    app.exit(0);
  } catch (error) {
    console.error(`[icons] ${error instanceof Error ? error.stack || error.message : String(error)}`);
    app.exit(1);
  }
});
