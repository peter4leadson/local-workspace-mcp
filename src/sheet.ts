import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { minimatch } from "minimatch";
import { ToolError, type WorkspaceIndex } from "./paths.js";
import type { DenyPolicy } from "./policy.js";
import { mediaLimits, readCapped, sha256Hex, withDeadline, Semaphore } from "./media.js";
import { ImageOps } from "./imageOps.js";
import type { Limits } from "./config.js";

/**
 * Bounded image-set montage. Each item passes the full authorization
 * boundary (containment + deny policy + content-class scan) independently;
 * a single unauthorized member degrades that cell rather than failing the
 * sheet. Layout positions are reported so agents can reference cells by
 * index instead of re-requesting images.
 */

const LABEL_H = 22;
const PAD = 8;

function escapeXml(s: string): string {
  // XML 1.0 forbids character references for control chars — drop them first
  // so a hostile filename degrades its label instead of producing invalid XML.
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

interface SheetItem {
  index: number;
  path: string;
  status: "ok" | "failed";
  error?: string;
  sha256?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  position?: { row: number; col: number };
  thumb?: Buffer;
  thumbWidth?: number;
  thumbHeight?: number;
}

export class ContactSheet {
  private readonly m: ReturnType<typeof mediaLimits>;
  private readonly images: ImageOps;
  private readonly sem: Semaphore;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly policy: DenyPolicy,
    limits: Limits,
    sem?: Semaphore
  ) {
    this.m = mediaLimits(limits);
    this.sem = sem ?? new Semaphore(this.m.mediaConcurrency);
    this.images = new ImageOps(index, policy, limits, this.sem);
  }

  async render(workspace: string, opts: {
    paths?: string[];
    directory?: string;
    glob?: string;
    cell?: number;
    columns?: number;
  }) {
    const maxItems = this.m.contactSheetMaxItems;
    let relPaths: string[];
    let truncated = false;
    let omitted = 0;

    if (opts.paths && opts.paths.length > 0) {
      if (opts.paths.length > maxItems) {
        truncated = true;
        omitted = opts.paths.length - maxItems;
        relPaths = opts.paths.slice(0, maxItems);
      } else {
        relPaths = [...opts.paths];
      }
    } else if (opts.directory) {
      const r = await this.index.resolve(workspace, opts.directory);
      const dirEntries = await fs.readdir(r.canonical, { withFileTypes: true });
      const pattern = opts.glob ?? "*.@(png|jpg|jpeg|webp|gif|avif|svg|bmp|tif|tiff)";
      const matched = dirEntries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter((n) => minimatch(n, pattern, { nocase: true, dot: false }))
        .sort();
      const joined = matched.map((n) => path.posix.join(r.rel === "." ? "" : r.rel, n));
      if (joined.length > maxItems) {
        truncated = true;
        omitted = joined.length - maxItems;
      }
      relPaths = joined.slice(0, maxItems);
      if (relPaths.length === 0) {
        throw new ToolError("NOT_FOUND", `no files matched ${pattern} in ${opts.directory}`);
      }
    } else {
      throw new ToolError("INVALID_ARGUMENT", "provide paths[] or directory");
    }

    const cell = opts.cell ?? 256;
    if (cell < 64 || cell > 512) {
      throw new ToolError("INVALID_ARGUMENT", "cell must be 64..512 px");
    }
    const inner = cell - PAD * 2;
    const thumbMax = inner;
    const labelH = LABEL_H;

    const items: SheetItem[] = [];
    for (let i = 0; i < relPaths.length; i++) {
      const p = relPaths[i]!;
      const item: SheetItem = { index: i, path: p, status: "ok" };
      try {
        const resolved = await this.index.resolve(workspace, p);
        const buf = await readCapped(resolved.canonical, resolved.rel, this.m.maxMediaFileBytes);
        const prepared = await this.images.previewResolved(resolved.rel, buf, { fitMaxDim: thumbMax });
        const meta = await sharp(prepared.bytes).metadata();
        item.thumb = prepared.bytes;
        item.thumbWidth = meta.width ?? thumbMax;
        item.thumbHeight = meta.height ?? thumbMax;
        item.width = prepared.meta.width;
        item.height = prepared.meta.height;
        item.sha256 = sha256Hex(buf);
        item.sizeBytes = buf.length;
      } catch (err) {
        item.status = "failed";
        item.error = err instanceof ToolError ? `${err.code}: ${err.message}` : `ERROR: ${String(err).slice(0, 120)}`;
      }
      items.push(item);
    }

    const cols = Math.min(opts.columns ?? Math.ceil(Math.sqrt(items.length)), 8, items.length);
    const rows = Math.ceil(items.length / cols);
    const W = cols * (cell + PAD) + PAD;
    const H = rows * (cell + labelH + PAD) + PAD;

    const composites: { input: Buffer; left: number; top: number }[] = [];
    items.forEach((it, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      it.position = { row, col };
      const x = PAD + col * (cell + PAD);
      const y = PAD + row * (cell + labelH + PAD);
      const label = `${i}: ${path.posix.basename(it.path)}`.slice(0, 48);
      composites.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${labelH}"><text x="0" y="${labelH - 7}" font-family="sans-serif" font-size="11" fill="#222">${escapeXml(label)}</text></svg>`
        ),
        left: x,
        top: y + inner,
      });
      if (it.status === "ok" && it.thumb) {
        composites.push({
          input: it.thumb,
          left: x + Math.max(0, Math.floor((inner - (it.thumbWidth ?? 0)) / 2)),
          top: y + Math.max(0, Math.floor((inner - (it.thumbHeight ?? 0)) / 2)),
        });
      } else {
        composites.push({
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}"><rect width="${inner}" height="${inner}" fill="#eee"/><text x="${inner / 2}" y="${inner / 2}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#a00">failed</text></svg>`
          ),
          left: x,
          top: y,
        });
      }
    });

    if (W * H > this.m.maxImagePixels) {
      throw new ToolError("RESOURCE_LIMIT", `sheet would be ${W}x${H}, over pixel limit`);
    }

    const canvas = sharp({
      create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
      limitInputPixels: this.m.maxImagePixels,
    }).composite(composites);

    const { buf: out, mime } = await withDeadline(
      this.sem.run(async () => {
        let b = await canvas.png().toBuffer();
        if (b.length <= this.m.maxImageOutputBytes) return { buf: b, mime: "image/png" as const };
        b = await sharp(
          { create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } },
        )
          .composite(composites)
          .jpeg({ quality: 82, mozjpeg: true })
          .toBuffer();
        if (b.length <= this.m.maxImageOutputBytes) return { buf: b, mime: "image/jpeg" as const };
        throw new ToolError(
          "RESOURCE_LIMIT",
          `contact sheet output exceeds ${this.m.maxImageOutputBytes} bytes even as jpeg; reduce item count or cell size`
        );
      }),
      this.m.mediaTimeoutMs,
      "contact sheet encode"
    );

    return {
      workspace,
      sheetWidth: W,
      sheetHeight: H,
      columns: cols,
      rows,
      itemCount: items.length,
      truncated,
      omitted,
      items: items.map(({ thumb, ...rest }) => rest),
      bytes: out,
      mime,
    };
  }
}
