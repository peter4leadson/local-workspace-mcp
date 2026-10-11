import { ToolError, type WorkspaceIndex } from "./paths.js";
import { DenyPolicy } from "./policy.js";
import {
  bufferHasKeyMaterial,
  detectKind,
  mediaLimits,
  readCapped,
  sha256Hex,
  withDeadline,
} from "./media.js";
import { openZipBuffer, safeEntryName, type OpenArchive } from "./zipOps.js";
import type { Limits } from "./config.js";

/**
 * OOXML (.docx/.pptx/.xlsx) text extraction through the same bounded ZIP
 * layer as fs_archive_*. Macros are detected and flagged, never executed;
 * external relationships (linked images, remote stylesheets) are never
 * followed. XML is scanned for text-bearing nodes with only builtin entity
 * decoding — no DTD, no parser-driven fetch, no formula evaluation.
 * Legacy OLE formats (.doc/.xls/.ppt) are refused explicitly.
 */

const CHAR_CAP = 256_000;
const ENTRY_XML_CAP = 32_000_000;

type ML = ReturnType<typeof mediaLimits>;

/** Builtin XML entities only (plus numeric refs); no DTD expansion. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent: string) => {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    const n = ent.startsWith("#x") ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

function extractRuns(xml: string, tag: string): string[] {
  // <w:t ...>text</w:t> / <a:t>text</a:t> — attribute-tolerant open tag.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(decodeEntities(m[1]!));
  return out;
}

export function officeFormat(entries: string[]): "docx" | "pptx" | "xlsx" | "ooxml" {
  const set = new Set(entries);
  if (set.has("word/document.xml")) return "docx";
  if (set.has("ppt/presentation.xml")) return "pptx";
  if (set.has("xl/workbook.xml")) return "xlsx";
  return "ooxml";
}

export class OfficeOps {
  private readonly m: ML;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly policy: DenyPolicy,
    limits: Limits
  ) {
    this.m = mediaLimits(limits);
  }

  async open(workspace: string, inputPath: string) {
    const r = await this.index.resolve(workspace, inputPath);
    const buf = await readCapped(r.canonical, r.rel, this.m.maxMediaFileBytes);
    if (bufferHasKeyMaterial(buf)) {
      throw new ToolError("ACCESS_DENIED", `file contains private-key material (content-class refusal): ${r.rel}`);
    }
    const kind = detectKind(buf.subarray(0, Math.min(buf.length, 8192)));
    if (kind === "ole") {
      throw new ToolError(
        "UNSUPPORTED_FORMAT",
        `legacy OLE Office format (.doc/.xls/.ppt) is not supported; convert to OOXML first: ${r.rel}`
      );
    }
    if (kind !== "zip" && kind !== "ooxml") {
      throw new ToolError("UNSUPPORTED_FORMAT", `not an OOXML Office document (detected ${kind}): ${r.rel}`);
    }
    const arc = await withDeadline(openZipBuffer(buf, this.policy, this.m), this.m.mediaTimeoutMs, "ooxml enumeration");
    if (!arc.entries.some((e) => e.name === "[Content_Types].xml")) {
      arc.close();
      throw new ToolError("UNSUPPORTED_FORMAT", `zip container without OOXML content types: ${r.rel}`);
    }
    return { r, sha: sha256Hex(buf), arc };
  }

  private async readXml(arc: OpenArchive, name: string): Promise<string | null> {
    const info = arc.entries.find((e) => e.name === name && e.type === "file");
    if (!info || info.denied || info.unsafe || info.encrypted) return null;
    try {
      const buf = await withDeadline(arc.readEntry(info, ENTRY_XML_CAP), this.m.mediaTimeoutMs, `read ${name}`);
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }

  /** fs_office_text */
  async text(workspace: string, inputPath: string, opts: { maxChars?: number } = {}) {
    const { r, sha, arc } = await this.open(workspace, inputPath);
    try {
      const names = arc.entries.map((e) => e.name);
      const fmt = officeFormat(names);
      if (fmt === "ooxml") {
        throw new ToolError("UNSUPPORTED_FORMAT", `unrecognized OOXML subtype (no word/, xl/, or ppt/ root): ${r.rel}`);
      }
      const macros = names.some((n) => /vbaProject\.bin$/i.test(n) || /(^|\/)macrosheets\//i.test(n));
      const cap = Math.min(opts.maxChars ?? CHAR_CAP, CHAR_CAP);
      const sections: { name: string; chars: number; text: string }[] = [];
      let chars = 0;
      let truncated = false;

      const push = (name: string, text: string) => {
        if (truncated) return;
        if (chars + text.length > cap) {
          const room = cap - chars;
          if (room > 64) {
            sections.push({ name, chars: room, text: text.slice(0, room) });
            chars += room;
          }
          truncated = true;
          return;
        }
        sections.push({ name, chars: text.length, text });
        chars += text.length;
      };

      if (fmt === "docx") {
        const parts = names.filter((n) => /^word\/(document|footnotes|endnotes|comments)\.xml$/.test(n));
        for (const n of parts) {
          const xml = await this.readXml(arc, n);
          if (!xml) continue;
          // Paragraph breaks at </w:p>; table cells joined inline.
          const paras = xml.split(/<\/w:p>/).map((p) => extractRuns(p, "w:t").join("")).filter((s) => s.trim().length > 0);
          push(n, paras.join("\n"));
        }
      } else if (fmt === "pptx") {
        const slideRe = /^ppt\/slides\/slide(\d+)\.xml$/;
        const slides = names
          .filter((n) => slideRe.test(n))
          .sort((a, b) => parseInt(slideRe.exec(a)![1]!, 10) - parseInt(slideRe.exec(b)![1]!, 10))
          .slice(0, 200);
        for (const n of slides) {
          const xml = await this.readXml(arc, n);
          if (!xml) continue;
          const num = slideRe.exec(n)![1]!;
          push(`slide ${num}`, extractRuns(xml, "a:t").join("\n"));
        }
      } else {
        // xlsx
        const shared: string[] = [];
        const ssXml = await this.readXml(arc, "xl/sharedStrings.xml");
        if (ssXml) {
          for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
            shared.push(extractRuns(m[1]!, "t").join(""));
            if (shared.length > 100_000) break;
          }
        }
        const sheetRe = /^xl\/worksheets\/sheet(\d+)\.xml$/;
        const sheets = names
          .filter((n) => sheetRe.test(n))
          .sort((a, b) => parseInt(sheetRe.exec(a)![1]!, 10) - parseInt(sheetRe.exec(b)![1]!, 10))
          .slice(0, 64);
        for (const n of sheets) {
          const xml = await this.readXml(arc, n);
          if (!xml) continue;
          const lines: string[] = [];
          let cellCount = 0;
          for (const cm of xml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)) {
            if (cellCount++ > 20_000) break;
            const open = cm[0].slice(0, cm[0].indexOf(">"));
            const ref = /\sr="([A-Z]+\d+)"/.exec(open)?.[1] ?? `#${cellCount}`;
            const t = /\st="(\w+)"/.exec(open)?.[1];
            const inner = cm[1]!;
            const vm = /<v>([\s\S]*?)<\/v>/.exec(inner) ?? /<is>([\s\S]*?)<\/is>/.exec(inner);
            if (!vm) continue;
            let val = decodeEntities(vm[1]!);
            if (t === "s") {
              const idx = parseInt(val, 10);
              val = shared[idx] ?? "";
            } else if (t === "inlineStr") {
              val = extractRuns(vm[1]!, "t").join("");
            }
            if (val !== "") lines.push(`${ref}\t${val}`);
          }
          push(n, lines.join("\n"));
        }
      }

      return {
        workspace,
        path: r.rel,
        sha256: sha,
        kind: "ooxml",
        officeFormat: fmt,
        macrosPresent: macros,
        note: macros ? "macros present — flagged, never executed" : undefined,
        memberCount: arc.entries.length,
        textChars: chars,
        truncated,
        sections,
        caveats: [
          "text extraction only: images/styles/comments are not rendered",
          "external relationships are never followed",
        ],
      };
    } finally {
      arc.close();
    }
  }
}

export { safeEntryName };
