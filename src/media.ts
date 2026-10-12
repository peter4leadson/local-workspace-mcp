import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import imageSize from "image-size";
import { ToolError } from "./paths.js";
import type { Limits } from "./config.js";

/**
 * Media layer shared by fs_inspect/fs_image/fs_contact_sheet and the archive/
 * pdf/office tools. Format detection is magic-byte driven — file extensions
 * are never trusted. Decoding is bounded by byte caps, pixel caps, and a
 * process-wide concurrency semaphore; nothing here writes to a workspace.
 */

export type MediaKind =
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "avif"
  | "bmp"
  | "tiff"
  | "svg"
  | "zip"
  | "ooxml"
  | "ole"
  | "pdf"
  | "text"
  | "binary";

export const RASTER_MIMES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tiff: "image/tiff",
};

/** Formats served as native image blocks without transcode. */
export const NATIVE_IMAGE_KINDS = new Set(["png", "jpeg", "gif", "webp", "avif"]);

export interface SniffedImage {
  kind: MediaKind;
  width: number;
  height: number;
}

/** True when the buffer is a supported PDF container. */
export function isPdfMagic(head: Buffer): boolean {
  return head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-";
}

export function isOleMagic(head: Buffer): boolean {
  // D0 CF 11 E0 A1 B1 1A E1 — legacy OLE compound documents (.doc/.xls/.ppt)
  return (
    head.length >= 8 &&
    head[0] === 0xd0 &&
    head[1] === 0xcf &&
    head[2] === 0x11 &&
    head[3] === 0xe0 &&
    head[4] === 0xa1 &&
    head[5] === 0xb1 &&
    head[6] === 0x1a &&
    head[7] === 0xe1
  );
}

export function isZipMagic(head: Buffer): boolean {
  // PK\x03\x04 local header, PK\x05\x06 empty archive, PK\x07\x08 spanned.
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)
  );
}

const SVG_TEXT_MAX_BYTES = 5_000_000;

/**
 * Detect the high-level kind of a buffer. Image subtypes go through
 * image-size (magic-byte sniffing, no pixel decode). `.svg` is text XML —
 * detected after the binary probe fails on a leading `<`+svg/xml marker.
 */
export function detectKind(head: Buffer): MediaKind {
  if (isPdfMagic(head)) return "pdf";
  if (isOleMagic(head)) return "ole";
  if (isZipMagic(head)) return "zip";
  const str = head.subarray(0, Math.min(head.length, 8192)).toString("utf8");
  if (looksLikeSvg(str)) return "svg";
  try {
    const r = imageSize(head);
    const k = (r.type ?? "").toLowerCase();
    if (k === "png" || k === "jpg" || k === "jpeg") return "jpeg" === k || k === "jpg" ? "jpeg" : "png";
    if (["gif", "webp", "avif", "bmp", "tiff"].includes(k)) return k as MediaKind;
    if (k === "svg") return "svg";
    if (k === "heic" || k === "heif") return "binary"; // unsupported, reported as binary
  } catch {
    /* not a recognized image */
  }
  return head.includes(0) ? "binary" : "text";
}

function looksLikeSvg(head: string): boolean {
  const t = head.replace(/^﻿/, "").replace(/^\s*(<\?xml[^?]*\?>\s*)?/, "").trimStart().slice(0, 4096);
  if (/^<!--[^]*?-->\s*/.test(t)) {
    const stripped = t.replace(/^(<!--[^]*?-->\s*)+/, "");
    return stripped.startsWith("<svg") || /^<!DOCTYPE\s+svg/i.test(stripped);
  }
  return t.startsWith("<svg") || /^<!DOCTYPE\s+svg/i.test(t);
}

/** image-size dimensions for a raster buffer; throws on unparseable input. */
export function sniffImage(buf: Buffer): SniffedImage {
  let r;
  try {
    r = imageSize(buf);
  } catch {
    throw new ToolError("INVALID_ARGUMENT", "file is not a recognized image format");
  }
  const kind = (r.type ?? "").toLowerCase() as MediaKind;
  const normalized = kind === ("jpg" as MediaKind) ? "jpeg" : kind;
  if (!NATIVE_IMAGE_KINDS.has(normalized) && normalized !== "bmp" && normalized !== "tiff" && normalized !== "svg") {
    throw new ToolError("UNSUPPORTED_FORMAT", `image format ${JSON.stringify(r.type ?? "unknown")} is not supported`);
  }
  const width = Math.round(r.width ?? 0);
  const height = Math.round(r.height ?? 0);
  if (!(width > 0) || !(height > 0)) {
    throw new ToolError("INVALID_ARGUMENT", "image header does not carry valid dimensions");
  }
  return { kind: normalized, width, height };
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const KEY_ARMOR_BYTES = Buffer.from("PRIVATE KEY", "latin1");
const PUTTY_BYTES = Buffer.from("PuTTY-User-Key-File-", "latin1");
const KEY_ARMOR_RE = /-{2,}\s*BEGIN\s+[A-Z0-9 \-]*PRIVATE KEY(?:\s+BLOCK)?\s*-{0,}|PuTTY-User-Key-File-\d:/i;
const KEY_ARMOR_RE_COMPACT = /-{2,}BEGIN[A-Z0-9\-]*PRIVATEKEY(?:BLOCK)?|PUTTY-USER-KEY-FILE-\d:/i;

/**
 * Content-class refusal on raw bytes: private-key armor is ASCII and survives
 * verbatim inside PNG tEXt chunks, ZIP comments, and renamed files — a name
 * that evades the path policy must not become a content channel. Covers both
 * PEM/OpenSSH-style armor and PuTTY .ppk headers. A whitespace-split marker
 * (`PRIVAT\nE KEY`) evades the literal probes, so text-like payloads get a
 * zero-collapse pass too; binary payloads only match when armor is contiguous
 * anyway (interleaved binary bytes break either pattern).
 */
export function bufferHasKeyMaterial(buf: Buffer): boolean {
  // Fast reject on the literals, confirm with the marker grammar so plain
  // mentions like "PRIVATE KEY" prose don't deny a legitimate payload.
  if (buf.includes(KEY_ARMOR_BYTES) || buf.includes(PUTTY_BYTES)) {
    if (KEY_ARMOR_RE.test(buf.toString("latin1"))) return true;
  }
  const s = buf.toString("latin1");
  return KEY_ARMOR_RE_COMPACT.test(s.replace(/[\s\0]+/g, ""));
}

/** Read a whole file under a byte cap. Used by media tools only — callers
 *  have already proven containment + policy via index.resolve. */
export async function readCapped(canonical: string, rel: string, capBytes: number): Promise<Buffer> {
  let st;
  try {
    st = await fs.stat(canonical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ToolError("NOT_FOUND", `path does not exist: ${rel}`);
    if (code === "EACCES" || code === "EPERM") throw new ToolError("ACCESS_DENIED", `permission denied reading: ${rel}`);
    throw new ToolError("INTERNAL_ERROR", `filesystem error accessing: ${rel}`);
  }
  if (!st.isFile()) throw new ToolError("INVALID_ARGUMENT", `not a file: ${rel}`);
  if (st.size > capBytes) {
    throw new ToolError("RESOURCE_LIMIT", `file is ${st.size} bytes, over media limit ${capBytes}`);
  }
  let fh;
  try {
    fh = await fs.open(canonical, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ToolError("NOT_FOUND", `path does not exist: ${rel}`);
    throw new ToolError("ACCESS_DENIED", `permission denied reading: ${rel}`);
  }
  try {
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Bounded-concurrency gate for decode/render work (pixel work is the
 *  memory-heavy path; N callers must not fan out N decodes at once). */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((res) => this.waiters.push(res));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

/** Wall-clock deadline for a media operation. The underlying native work
 *  cannot be cancelled mid-call; input caps bound it, and this rejects the
 *  result rather than letting a slow decode stall the caller forever. */
export async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new ToolError("TIMEOUT", `${what} exceeded ${ms}ms deadline`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

export interface MediaLimits {
  maxMediaFileBytes: number;
  maxImagePixels: number;
  maxImageOutputBytes: number;
  mediaConcurrency: number;
  contactSheetMaxItems: number;
  archiveMaxMembers: number;
  archiveMaxEntryBytes: number;
  archiveMaxRatio: number;
  pdfMaxPagesRender: number;
  pdfMaxPagesText: number;
  pdfMaxRenderPixels: number;
  mediaTimeoutMs: number;
}

export function mediaLimits(l: Limits): MediaLimits {
  return {
    maxMediaFileBytes: l.maxMediaFileBytes,
    maxImagePixels: l.maxImagePixels,
    maxImageOutputBytes: l.maxImageOutputBytes,
    mediaConcurrency: l.mediaConcurrency,
    contactSheetMaxItems: l.contactSheetMaxItems,
    archiveMaxMembers: l.archiveMaxMembers,
    archiveMaxEntryBytes: l.archiveMaxEntryBytes,
    archiveMaxRatio: l.archiveMaxRatio,
    pdfMaxPagesRender: l.pdfMaxPagesRender,
    pdfMaxPagesText: l.pdfMaxPagesText,
    pdfMaxRenderPixels: l.pdfMaxRenderPixels,
    mediaTimeoutMs: l.mediaTimeoutMs,
  };
}

export { SVG_TEXT_MAX_BYTES };
