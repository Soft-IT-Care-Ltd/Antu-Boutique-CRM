import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, unlink, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { ALLOWED_IMAGE_MIME_TYPES } from "@/lib/catalog/constants";

// CLAUDE.md: local /uploads, served through an auth-checked route, never a
// public static path — see app/uploads/[...path]/route.ts, which is the only
// thing allowed to read out of UPLOAD_ROOT. Every file on disk sits under a
// resource-scoped subfolder (e.g. products/<id>/, orders/<order_no>/) so a
// delete of the parent never has to guess what to clean up.
export const UPLOAD_ROOT = path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.UPLOAD_DIR ?? "./public/uploads");
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? "5") * 1024 * 1024;

const THUMB_SIZE = 400;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export function isAllowedImageMime(mime: string): mime is AllowedImageMime {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/** Resolves a relative "subdir/filename" path under UPLOAD_ROOT, rejecting any attempt to escape it. */
export function resolveUploadPath(...segments: string[]): string {
  const resolved = path.resolve(/* turbopackIgnore: true */ UPLOAD_ROOT, ...segments);
  if (resolved !== UPLOAD_ROOT && !resolved.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error("Invalid upload path");
  }
  return resolved;
}

type SavedImage = {
  /** Path relative to UPLOAD_ROOT, stored in the DB and used to build the /uploads/... URL. */
  filePath: string;
  thumbPath: string;
  mimeType: string;
  sizeBytes: number;
};

/**
 * Compresses the given image bytes with sharp, writes a full-size (capped)
 * copy and a square-ish thumbnail under `subdir/`, and returns the relative
 * paths to store on the row. Always re-encodes to strip EXIF/GPS metadata.
 */
export async function saveCompressedImage(
  buffer: Buffer,
  mimeType: string,
  subdir: string,
): Promise<SavedImage> {
  if (!isAllowedImageMime(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }

  const dir = resolveUploadPath(subdir);
  await mkdir(dir, { recursive: true });

  const id = randomUUID();
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const filename = `${id}.${ext}`;
  const thumbFilename = `${id}_thumb.${ext}`;

  const pipeline = sharp(buffer).rotate();
  const resized = pipeline.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
  const encoded =
    ext === "png" ? resized.png({ quality: 82 }) : ext === "webp" ? resized.webp({ quality: 82 }) : resized.jpeg({ quality: 82 });
  const fullBuffer = await encoded.toBuffer();

  const thumbPipeline = sharp(buffer)
    .rotate()
    .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "cover" });
  const thumbEncoded =
    ext === "png" ? thumbPipeline.png({ quality: 78 }) : ext === "webp" ? thumbPipeline.webp({ quality: 78 }) : thumbPipeline.jpeg({ quality: 78 });
  const thumbBuffer = await thumbEncoded.toBuffer();

  await Promise.all([
    writeFile(path.join(/* turbopackIgnore: true */ dir, filename), fullBuffer),
    writeFile(path.join(/* turbopackIgnore: true */ dir, thumbFilename), thumbBuffer),
  ]);

  return {
    filePath: path.posix.join(subdir, filename),
    thumbPath: path.posix.join(subdir, thumbFilename),
    mimeType: `image/${ext === "jpg" ? "jpeg" : ext}`,
    sizeBytes: fullBuffer.byteLength,
  };
}

export async function deleteUploadedFile(relativePath: string): Promise<void> {
  try {
    await unlink(resolveUploadPath(relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function readUploadedFile(relativePath: string): Promise<Buffer> {
  return readFile(resolveUploadPath(relativePath));
}

/**
 * P2.3 expense receipts: a PDF is stored as-is (after checking it really is
 * one); images go through saveCompressedImage like every other upload.
 */
export async function saveReceipt(buffer: Buffer, mimeType: string, subdir: string): Promise<{ filePath: string; mimeType: string }> {
  if (mimeType === "application/pdf") {
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("That file isn't a valid PDF");
    const dir = resolveUploadPath(subdir);
    await mkdir(dir, { recursive: true });
    const filename = `${randomUUID()}.pdf`;
    await writeFile(path.join(/* turbopackIgnore: true */ dir, filename), buffer);
    return { filePath: path.posix.join(subdir, filename), mimeType };
  }
  const saved = await saveCompressedImage(buffer, mimeType, subdir);
  // The thumbnail isn't used for receipts.
  await deleteUploadedFile(saved.thumbPath);
  return { filePath: saved.filePath, mimeType: saved.mimeType };
}
