import sharp from "sharp";
import { WorkspaceIndex, ToolError } from "./paths.js";
import { DenyPolicy } from "./policy.js";
import {
  bufferHasKeyMaterial,
  detectKind,
  mediaLimits,
  readCapped,
  sha256Hex,
  sniffImage,
  SVG_TEXT_MAX_BYTES,
  NATIVE_IMAGE_KINDS,
  RASTER_MIMES,
  Semaphore,
  withDeadline,
  type MediaKind,
} from "./media.js";
import type { Limits } from "./config.js";

/**
 * Raster image inspection and preview. Produces native MCP image blocks:
 * the ORIGINAL file bytes whenever no transform was requested (evidence is
 * never silently altered), or an explicitly requested, fully disclosed
 * re-encode. Every input passes index.resolve (containment + deny policy)
 * and a raw-byte private-key scan before decoding.
 */

export interface ImageMeta {
  kind: MediaKind;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  frames?: number;
  animated?: boolean;
}

/**
 * External-reference scan for SVG rasterization. librsvg (inside sharp's
 * libvips) never executes scripts, but its image/use href resolution is a
 * local-file exfiltration vector: `<image href="/etc/secret.png">` would be
 * rasterized INTO the output pixels. Fail closed on anything that is not a
 * pure same-document reference (#id) or an inline RASTER data: payload —
 * `data:image/svg+xml` is refused because a nested SVG is a second, unscanned
 * document that can itself carry file:// hrefs. CSS escapes are decoded
 * before scanning so `@impo\72t` cannot launder `@import`. Attribute values
 * are matched literally, so entity-encoded smuggling (`h&#116;tp:`) also
 * fails the allowlist rather than decoding into a fetch.
 */
const SAFE_DATA_URI = /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i;

function safeInlineRef(v: string): boolean {
  return v.startsWith("#") || SAFE_DATA_URI.test(v);
}

function decodeCssEscapes(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})[ \t]?/g, (_m, h: string) => {
    const n = parseInt(h, 16);
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}

export function svgExternalRefReason(svgRaw: string): string | null {
  const svg = decodeCssEscapes(svgRaw);
  if (/<\s*script[\s/>]/i.test(svg)) return "script-element";
  if (/<\s*foreignObject[\s/>]/i.test(svg)) return "foreignObject-element";
  if (/<!ENTITY/i.test(svg)) return "entity-declaration";
  if (/<!DOCTYPE[^>]*\[/is.test(svg)) return "doctype-internal-subset";
  if (/<\?xml-stylesheet/i.test(svg)) return "xml-stylesheet-pi";
  if (/@(import|charset|namespace)\b/i.test(svg)) return "css-at-rule";

  for (const m of svg.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const v = m[1]!.trim();
    if (safeInlineRef(v)) continue;
    return `external-href:${v.slice(0, 32)}`;
  }
  // Quoted whitespace inside url() is trimmed by CSS — the capture is
  // trimmed here before the allowlist, and an empty/unparseable arg fails.
  for (const m of svg.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi)) {
    const v = (m[1] ?? "").trim();
    if (v === "" || !safeInlineRef(v)) return `external-url:${v.slice(0, 32) || "empty"}`;
  }
  return null;
}

export interface PreparedImage {
  meta: ImageMeta;
  /** Original file bytes when no transform is needed. */
  bytes: Buffer;
  transform?: { kind: string; sourceSha256: string; returnedSha256: string; detail: string };
}

/** Decode-agnostic per-file pipeline shared by fs_image, fs_archive_entry
 *  and fs_contact_sheet. `sourceName` appears in metadata/error strings. */
export class ImageOps {
  private readonly m: ReturnType<typeof mediaLimits>;
  private readonly sem: Semaphore;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly policy: DenyPolicy,
    limits: Limits,
    sem?: Semaphore
  ) {
    this.m = mediaLimits(limits);
    this.sem = sem ?? new Semaphore(this.m.mediaConcurrency);
  }

  /**
   * Prepare a native image block for a resolved+authorized file.
   * Returns null when the buffer is not a supported image (caller decides
   * how to report it).
   */
  async previewResolved(
    rel: string,
    buf: Buffer,
    opts: { frame?: number; fitMaxDim?: number; format?: "png" | "jpeg" | "webp" } = {}
  ): Promise<PreparedImage> {
    if (bufferHasKeyMaterial(buf)) {
      throw new ToolError("ACCESS_DENIED", `file contains private-key material (content-class refusal): ${rel}`);
    }
    const frame = opts.frame ?? 0;
    const sniffed = sniffImage(buf);

    if (sniffed.kind === "svg") {
      return this.rasterizeSvg(rel, buf, opts);
    }

    if (sniffed.width * sniffed.height > this.m.maxImagePixels) {
      throw new ToolError(
        "RESOURCE_LIMIT",
        `image is ${sniffed.width}x${sniffed.height} (${sniffed.width * sniffed.height} px), over pixel limit ${this.m.maxImagePixels}: ${rel}`
      );
    }

    // Deadline races the semaphore-wrapped work: the slot stays held until
    // the native decode actually settles, so timed-out zombies still count
    // against the concurrency budget.
    return withDeadline(
      this.sem.run(async () => {
          // Decode metadata once: gives the true frame count for animated
          // formats and double-checks the header sniff against the decoder.
          const meta = await sharp(buf, { limitInputPixels: this.m.maxImagePixels }).metadata();
          const frames = meta.pages ?? 1;
          const animated = frames > 1;
          if (frame < 0 || frame >= frames) {
            throw new ToolError(
              "INVALID_ARGUMENT",
              `frame ${frame} out of range: ${rel} has ${frames} frame${frames === 1 ? "" : "s"} (0..${frames - 1})`
            );
          }
          const im: ImageMeta = {
            kind: sniffed.kind,
            mime: RASTER_MIMES[sniffed.kind] ?? "application/octet-stream",
            width: meta.width ?? sniffed.width,
            height: meta.height ?? sniffed.height,
            sizeBytes: buf.length,
            frames,
            animated,
          };

          const servingOriginal =
            frame === 0 && !opts.fitMaxDim && !opts.format && NATIVE_IMAGE_KINDS.has(sniffed.kind);
          if (servingOriginal && buf.length <= this.m.maxImageOutputBytes) {
            return { meta: im, bytes: buf };
          }

          // Transform path — required for: frame>0 extraction, bmp/tiff
          // transcode, or an explicit fitMaxDim. When the original could have
          // been served but is simply too large, refuse up front instead of
          // silently shrinking evidence: the caller must opt in to a bounded
          // re-encode via fitMaxDim.
          if (servingOriginal && buf.length > this.m.maxImageOutputBytes) {
            throw new ToolError(
              "RESOURCE_LIMIT",
              `image payload ${buf.length} bytes exceeds output limit ${this.m.maxImageOutputBytes}; request an explicit bounded preview with fitMaxDim`
            );
          }
          const fit = opts.fitMaxDim ?? 0;
          if (fit && (fit < 32 || fit > 4096)) {
            throw new ToolError("INVALID_ARGUMENT", "fitMaxDim must be 32..4096 px");
          }
          let img = sharp(buf, {
            limitInputPixels: this.m.maxImagePixels,
            ...(animated ? { page: frame } : {}),
          });
          if (fit) img = img.resize(fit, fit, { fit: "inside", withoutEnlargement: true });
          const fmt = opts.format ?? "png";
          const out =
            fmt === "jpeg"
              ? await img.jpeg({ quality: 85, mozjpeg: true }).toBuffer()
              : fmt === "webp"
                ? await img.webp({ quality: 85 }).toBuffer()
                : await img.png().toBuffer();
          if (out.length > this.m.maxImageOutputBytes) {
            throw new ToolError(
              "RESOURCE_LIMIT",
              `transformed payload ${out.length} bytes still exceeds output limit ${this.m.maxImageOutputBytes}; reduce fitMaxDim`
            );
          }
          const rm = await sharp(out).metadata();
          im.width = rm.width ?? im.width;
          im.height = rm.height ?? im.height;
          im.mime = fmt === "jpeg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
          const reasons: string[] = [];
          if (frame > 0) reasons.push(`frame ${frame}/${frames - 1} extracted`);
          if (fit) reasons.push(`resized to fit ${fit}px`);
          if (!NATIVE_IMAGE_KINDS.has(sniffed.kind)) reasons.push(`${sniffed.kind} transcoded to ${fmt}`);
          return {
            meta: im,
            bytes: out,
            transform: {
              kind: "re-encode",
              sourceSha256: sha256Hex(buf),
              returnedSha256: sha256Hex(out),
              detail: reasons.join("; ") || `re-encoded as ${fmt}`,
            },
          };
      }),
      this.m.mediaTimeoutMs,
      "image decode"
    );
  }

  private async rasterizeSvg(
    rel: string,
    buf: Buffer,
    opts: { fitMaxDim?: number; format?: "png" | "jpeg" | "webp" }
  ): Promise<PreparedImage> {
    if (buf.length > SVG_TEXT_MAX_BYTES) {
      throw new ToolError("RESOURCE_LIMIT", `svg exceeds ${SVG_TEXT_MAX_BYTES} byte text limit: ${rel}`);
    }
    const svg = buf.toString("utf8");
    const bad = svgExternalRefReason(svg);
    if (bad) {
      throw new ToolError(
        "ACCESS_DENIED",
        `svg contains external/active content (${bad}); rasterization refused: ${rel}`
      );
    }
    const dims = sniffImage(buf);
    return withDeadline(
      this.sem.run(async () => {
          let img = sharp(buf, { density: 150, limitInputPixels: this.m.maxImagePixels });
          if (opts.fitMaxDim) img = img.resize(opts.fitMaxDim, opts.fitMaxDim, { fit: "inside", withoutEnlargement: true });
          const out = await img.png().toBuffer();
          if (out.length > this.m.maxImageOutputBytes) {
            throw new ToolError("RESOURCE_LIMIT", `rasterized svg exceeds output limit ${this.m.maxImageOutputBytes}: ${rel}`);
          }
          const rm = await sharp(out).metadata();
          return {
            meta: {
              kind: "svg",
              mime: "image/png",
              width: rm.width ?? dims.width,
              height: rm.height ?? dims.height,
              sizeBytes: buf.length,
            },
            bytes: out,
            transform: {
              kind: "svg-rasterize",
              sourceSha256: sha256Hex(buf),
              returnedSha256: sha256Hex(out),
              detail: "rasterized svg→png at 150dpi after external-reference scan",
            },
          };
      }),
      this.m.mediaTimeoutMs,
      "svg rasterize"
    );
  }

  /** Full tool path for fs_image. */
  async preview(workspace: string, inputPath: string, opts: { frame?: number; fitMaxDim?: number; format?: "png" | "jpeg" | "webp" }) {
    const r = await this.index.resolve(workspace, inputPath);
    const buf = await readCapped(r.canonical, r.rel, this.m.maxMediaFileBytes);
    const kind = detectKind(buf.subarray(0, Math.min(buf.length, 8192)));
    const isImage = NATIVE_IMAGE_KINDS.has(kind) || kind === "bmp" || kind === "tiff" || kind === "svg";
    if (!isImage) {
      const hint = kind === "zip" ? "use fs_archive_list/fs_archive_entry" : kind === "pdf" ? "use fs_pdf_* tools" : kind === "text" ? "use fs_read" : "not a supported image";
      throw new ToolError("UNSUPPORTED_FORMAT", `path is ${kind}, not an image (${hint}): ${r.rel}`);
    }
    const prepared = await this.previewResolved(r.rel, buf, opts);
    return { r, prepared };
  }
}
