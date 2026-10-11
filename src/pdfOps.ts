import { PDFiumLibrary, type PDFiumDocument } from "@hyzyla/pdfium";
import sharp from "sharp";
import { ToolError, type WorkspaceIndex } from "./paths.js";
import { DenyPolicy } from "./policy.js";
import {
  bufferHasKeyMaterial,
  detectKind,
  isPdfMagic,
  mediaLimits,
  readCapped,
  sha256Hex,
  Semaphore,
  withDeadline,
} from "./media.js";
import type { Limits } from "./config.js";

/**
 * PDF inspection through PDFium (Chromium's PDF engine) compiled to WASM.
 * The parser runs in a memory sandbox — a hostile or malformed document
 * cannot touch host memory. Rendering never executes embedded JavaScript,
 * never resolves remote resources, and never exposes file attachments.
 * Documents are closed deterministically after each call.
 */

let libPromise: Promise<PDFiumLibrary> | null = null;
function getLib(): Promise<PDFiumLibrary> {
  if (!libPromise) libPromise = PDFiumLibrary.init();
  return libPromise;
}

type ML = ReturnType<typeof mediaLimits>;

export class PdfOps {
  private readonly m: ML;
  private readonly sem: Semaphore;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly policy: DenyPolicy,
    limits: Limits
  ) {
    this.m = mediaLimits(limits);
    this.sem = new Semaphore(this.m.mediaConcurrency);
  }

  private async load(workspace: string, inputPath: string): Promise<{ rel: string; sha: string; doc: PDFiumDocument }> {
    const r = await this.index.resolve(workspace, inputPath);
    const buf = await readCapped(r.canonical, r.rel, this.m.maxMediaFileBytes);
    if (bufferHasKeyMaterial(buf)) {
      throw new ToolError("ACCESS_DENIED", `file contains private-key material (content-class refusal): ${r.rel}`);
    }
    if (!isPdfMagic(buf.subarray(0, 8))) {
      const kind = detectKind(buf.subarray(0, Math.min(buf.length, 8192)));
      throw new ToolError("UNSUPPORTED_FORMAT", `not a pdf (detected ${kind}): ${r.rel}`);
    }
    const lib = await getLib();
    let doc: PDFiumDocument;
    try {
      doc = await this.sem.run(() => withDeadline(lib.loadDocument(new Uint8Array(buf)), this.m.mediaTimeoutMs, "pdf load"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/password|encrypt/i.test(msg)) {
        throw new ToolError("ACCESS_DENIED", `password-protected/encrypted pdf: ${r.rel}`);
      }
      throw new ToolError("INVALID_ARGUMENT", `pdf failed to parse: ${msg.slice(0, 160)}`);
    }
    return { rel: r.rel, sha: sha256Hex(buf), doc };
  }

  async info(workspace: string, inputPath: string) {
    const { rel, sha, doc } = await this.load(workspace, inputPath);
    try {
      const pageCount = doc.getPageCount();
      // Probe up to 3 pages for a text layer — image-only (scanned) PDFs
      // must report honestly rather than pretending extraction worked.
      let sampledText = 0;
      const probe = Math.min(pageCount, 3);
      for (let i = 0; i < probe; i++) {
        try {
          sampledText += doc.getPage(i).getText().length;
        } catch {
          /* page-level text failure — count as empty */
        }
      }
      return {
        workspace,
        path: rel,
        sha256: sha,
        pageCount,
        hasTextLayer: sampledText > 0,
        note: sampledText === 0 ? "no extractable text layer (scanned/image-only or restricted)" : undefined,
      };
    } finally {
      doc.destroy();
    }
  }

  private resolvePages(pageCount: number, pages: number[] | undefined, max: number, what: string): number[] {
    const want = pages && pages.length > 0 ? pages : [1];
    if (want.length > max) {
      throw new ToolError("RESOURCE_LIMIT", `too many pages requested (${want.length} > ${max} per call)`);
    }
    const out: number[] = [];
    for (const p of want) {
      if (!Number.isInteger(p) || p < 1 || p > pageCount) {
        throw new ToolError("INVALID_ARGUMENT", `page ${p} out of range: document has ${pageCount} pages (${what})`);
      }
      out.push(p);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  /** Render pages to native image blocks (PNG). Each page is scale-capped to
   *  the pixel budget; per-page output bytes are capped too. */
  async renderPages(workspace: string, inputPath: string, pages?: number[]) {
    const { rel, sha, doc } = await this.load(workspace, inputPath);
    try {
      const pageCount = doc.getPageCount();
      const wanted = this.resolvePages(pageCount, pages, this.m.pdfMaxPagesRender, "render");
      const images: { page: number; bytes: Buffer; mime: string; width: number; height: number }[] = [];
      for (const n of wanted) {
        const page = doc.getPage(n - 1);
        const size = page.getOriginalSize();
        // Scale to the smaller of 2x (≈144dpi) or the pixel budget.
        const scale = Math.min(
          2,
          Math.sqrt(this.m.pdfMaxRenderPixels / Math.max(1, size.originalWidth * size.originalHeight))
        );
        const res = await this.sem.run(() =>
          withDeadline(
            page.render({
              scale,
              colorSpace: "BGRA",
              render: async (img) =>
                new Uint8Array(
                  await sharp(bgraToRgba(img.data, img.width, img.height), {
                    raw: { width: img.width, height: img.height, channels: 4 },
                  })
                    .png()
                    .toBuffer()
                ),
            }),
            this.m.mediaTimeoutMs,
            `pdf page ${n} render`
          )
        );
        if (res.data.length > this.m.maxImageOutputBytes) {
          throw new ToolError(
            "RESOURCE_LIMIT",
            `rendered page ${n} is ${res.data.length} bytes, over output limit ${this.m.maxImageOutputBytes}`
          );
        }
        images.push({ page: n, bytes: Buffer.from(res.data), mime: "image/png", width: res.width, height: res.height });
      }
      return {
        rel,
        sha256: sha,
        pageCount,
        pages: images.map((i) => ({ page: i.page, width: i.width, height: i.height, bytes: i.bytes.length })),
        images,
      };
    } finally {
      doc.destroy();
    }
  }

  /** Bounded text extraction over a contiguous page range. */
  async text(workspace: string, inputPath: string, opts: { startPage?: number; endPage?: number } = {}) {
    const { rel, sha, doc } = await this.load(workspace, inputPath);
    try {
      const pageCount = doc.getPageCount();
      const start = opts.startPage ?? 1;
      this.resolvePages(pageCount, [start], 1, "text");
      if (opts.endPage !== undefined && opts.endPage > pageCount) {
        throw new ToolError("INVALID_ARGUMENT", `endPage ${opts.endPage} out of range: document has ${pageCount} pages`);
      }
      const end = Math.min(opts.endPage ?? start + this.m.pdfMaxPagesText - 1, start + this.m.pdfMaxPagesText - 1, pageCount);
      const CHAR_CAP = 256_000;
      const parts: { page: number; text: string }[] = [];
      let chars = 0;
      let truncated = false;
      for (let n = start; n <= end; n++) {
        let t = "";
        try {
          t = doc.getPage(n - 1).getText();
        } catch {
          t = "";
        }
        if (chars + t.length > CHAR_CAP) {
          const room = CHAR_CAP - chars;
          if (room > 0) parts.push({ page: n, text: t.slice(0, room) });
          truncated = true;
          break;
        }
        parts.push({ page: n, text: t });
        chars += t.length;
      }
      const lastIncluded = parts.length ? parts[parts.length - 1]!.page : start - 1;
      return {
        workspace,
        path: rel,
        sha256: sha,
        pageCount,
        startPage: start,
        endPage: lastIncluded,
        pages: parts,
        textChars: chars,
        truncated: truncated || lastIncluded < end,
        nextStartPage: truncated || lastIncluded < end ? lastIncluded + 1 : null,
        note: chars === 0 ? "no extractable text in range (image-only pages or restricted content)" : undefined,
      };
    } finally {
      doc.destroy();
    }
  }
}

/** PDFium emits BGRA on little-endian hosts; RGBA order is what encoders and
 *  callers expect — swap the channel pair in place. */
function bgraToRgba(data: Uint8Array, width: number, height: number): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = data[i + 2]!;
    out[i + 1] = data[i + 1]!;
    out[i + 2] = data[i]!;
    out[i + 3] = data[i + 3]!;
  }
  return out;
}
