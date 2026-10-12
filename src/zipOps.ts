import yauzl from "yauzl";
import { ToolError, type WorkspaceIndex } from "./paths.js";
import { DenyPolicy } from "./policy.js";
import {
  bufferHasKeyMaterial,
  detectKind,
  mediaLimits,
  readCapped,
  withDeadline,
  type MediaKind,
} from "./media.js";
import type { Limits } from "./config.js";
import { hasPrivateKeyMaterial } from "./git.js";

/**
 * ZIP browsing without extraction. yauzl is the lazy random-access reader:
 * it reads the central directory and decompresses one member on demand —
 * nothing is ever written back into the workspace. Member names are
 * adversarial input: each is normalized, traversal-checked, and run through
 * the same DenyPolicy as workspace paths before any bytes are decompressed.
 */

export interface ArchiveEntryInfo {
  name: string;
  type: "file" | "directory" | "symlink" | "special";
  compressedBytes: number;
  uncompressedBytes: number;
  ratio: number | null;
  compressed: boolean;
  encrypted: boolean;
  /** Set when the member name fails safety validation. */
  unsafe?: string;
  /** Deny-policy reason when the normalized name is denied. */
  denied?: string;
}

/** Member-name safety: POSIX normalize after backslash unification, reject
 *  absolutes, drive letters, and any `..` segment in the RAW spelling. */
export function safeEntryName(raw: string): { name: string; unsafe?: string } {
  if (raw.length === 0 || raw.length > 4096) return { name: raw.slice(0, 4096), unsafe: "name-length" };
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(raw)) return { name: raw, unsafe: "control-characters" };
  const fwd = raw.replace(/\\/g, "/");
  if (fwd.startsWith("/") || /^[A-Za-z]:/.test(fwd) || fwd.startsWith("//")) {
    return { name: fwd, unsafe: "absolute-path" };
  }
  if (fwd.split("/").some((seg) => seg === "..")) {
    return { name: fwd, unsafe: "traversal" };
  }
  const norm = fwd.replace(/^\.\//, "").replace(/\/+$/, "");
  return { name: norm === "" ? "." : norm };
}

function entryType(e: yauzl.Entry, name: string): "file" | "directory" | "symlink" | "special" {
  const unixMode = (e.externalFileAttributes >>> 16) & 0xffff;
  const madeByUnix = (e.versionMadeBy >>> 8) === 3;
  if (/\/$/.test(name)) return "directory";
  if (madeByUnix) {
    const fmt = unixMode & 0o170000;
    if (fmt === 0o120000) return "symlink";
    if (fmt !== 0 && fmt !== 0o100000 && fmt !== 0o040000) return "special"; // fifo/socket/dev
  }
  return "file";
}

export interface OpenArchive {
  entries: ArchiveEntryInfo[];
  totalMembers: number;
  truncated: boolean;
  commentBytes: number;
  close: () => void;
  readEntry: (entry: ArchiveEntryInfo, capBytes: number) => Promise<Buffer>;
}

interface Internal {
  zf: yauzl.ZipFile;
  byName: Map<string, yauzl.Entry>;
}

/** Open a ZIP container (path or in-memory buffer for nested/office use). */
export async function openZipBuffer(
  buf: Buffer,
  policy: DenyPolicy,
  limits: MediaLimitsT
): Promise<OpenArchive> {
  return openZipCommon(
    (cb) => yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true }, cb),
    policy,
    limits
  );
}

type MediaLimitsT = ReturnType<typeof mediaLimits>;

async function openZipCommon(
  openFn: (cb: (err: Error | null, zf: yauzl.ZipFile) => void) => void,
  policy: DenyPolicy,
  limits: MediaLimitsT
): Promise<OpenArchive> {
  const zf = await new Promise<yauzl.ZipFile>((res, rej) => {
    openFn((err, zf) => (err ? rej(err) : res(zf)));
  }).catch((err: Error) => {
    throw new ToolError("INVALID_ARGUMENT", `not a readable zip archive: ${err.message.slice(0, 200)}`);
  });

  const internal: Internal = { zf, byName: new Map() };
  const entries: ArchiveEntryInfo[] = [];
  let truncated = false;
  // Holder object: plain `let` narrowing can't see closure writes.
  const enumState: { err: Error | null } = { err: null };

  await new Promise<void>((resolve) => {
    zf.on("entry", (e: yauzl.Entry) => {
      // decodeStrings:false — yauzl fatally aborts enumeration on the first
      // unsafe name; we decode per-entry so hostile members are flagged in
      // listings and remain unreachable for preview.
      const utf8 = (e.generalPurposeBitFlag & 0x800) !== 0;
      const rawName = Buffer.isBuffer(e.fileName) ? e.fileName.toString(utf8 ? "utf8" : "latin1") : String(e.fileName);
      const { name, unsafe } = safeEntryName(rawName);
      const type = entryType(e, rawName);
      const info: ArchiveEntryInfo = {
        name,
        type,
        compressedBytes: e.compressedSize,
        uncompressedBytes: e.uncompressedSize,
        ratio: e.compressedSize > 0 ? Math.round((e.uncompressedSize / e.compressedSize) * 10) / 10 : null,
        compressed: e.compressionMethod !== 0,
        encrypted: (e.generalPurposeBitFlag & 0x1) !== 0,
        ...(unsafe ? { unsafe } : {}),
      };
      if (!unsafe && type === "file") {
        // Trimmed spelling is checked too — ".env " must not launder past
        // the deny list just because the byte-exact name differs.
        const denied = policy.check(name) ?? policy.check(name.trim());
        if (denied) info.denied = denied;
      }
      // Duplicate member names desync validation vs decompression — the
      // second spelling wins nothing: mark it unsafe and keep the first.
      if (!unsafe && !info.denied && internal.byName.has(name)) {
        info.unsafe = "duplicate-name";
      }
      entries.push(info);
      if (!unsafe && !info.unsafe && !internal.byName.has(name)) internal.byName.set(name, e);
      if (entries.length >= limits.archiveMaxMembers) {
        truncated = true;
        zf.close();
        resolve();
        return;
      }
      if (zf.isOpen) zf.readEntry();
    });
    zf.on("end", () => resolve());
    zf.on("error", (err: Error) => {
      enumState.err = err;
      resolve();
    });
    zf.readEntry();
  });
  if (enumState.err) {
    zf.close();
    throw new ToolError("INVALID_ARGUMENT", `zip enumeration failed: ${enumState.err.message.slice(0, 200)}`);
  }

  return {
    entries,
    totalMembers: zf.entryCount,
    truncated,
    commentBytes: zf.comment?.length ?? 0,
    close: () => zf.close(),
    readEntry: (info: ArchiveEntryInfo, capBytes: number) =>
      readEntryBytes(internal, info, capBytes),
  };
}

/** Decompress one member under a hard byte counter — declared sizes in the
 *  central directory are adversarial and never trusted on their own. */
function readEntryBytes(internal: Internal, info: ArchiveEntryInfo, capBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const entry = internal.byName.get(info.name);
    if (!entry) {
      reject(new ToolError("NOT_FOUND", `no such archive member: ${info.name}`));
      return;
    }
    internal.zf.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new ToolError("INVALID_ARGUMENT", `cannot decompress member ${info.name}: ${(err ?? new Error("no stream")).message.slice(0, 160)}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (c: Buffer) => {
        total += c.length;
        if (total > capBytes) {
          stream.destroy();
          reject(new ToolError("RESOURCE_LIMIT", `member ${info.name} expanded beyond ${capBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", (err: Error) => {
        reject(new ToolError("INVALID_ARGUMENT", `member ${info.name} decompression failed: ${err.message.slice(0, 160)}`));
      });
    });
  });
}

/** fs_archive_list */
export class ZipOps {
  private readonly m: MediaLimitsT;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly policy: DenyPolicy,
    limits: Limits
  ) {
    this.m = mediaLimits(limits);
  }

  private async resolveArchive(workspace: string, inputPath: string) {
    const r = await this.index.resolve(workspace, inputPath);
    const buf = await readCapped(r.canonical, r.rel, this.m.maxMediaFileBytes);
    if (bufferHasKeyMaterial(buf)) {
      throw new ToolError("ACCESS_DENIED", `file contains private-key material (content-class refusal): ${r.rel}`);
    }
    const kind = detectKind(buf.subarray(0, Math.min(buf.length, 8192)));
    if (kind !== "zip" && kind !== "ooxml") {
      throw new ToolError("UNSUPPORTED_FORMAT", `not a zip archive (detected ${kind}): ${r.rel}`);
    }
    return { r, buf };
  }

  async list(workspace: string, inputPath: string, opts: { limit?: number; offset?: number } = {}) {
    const { r, buf } = await this.resolveArchive(workspace, inputPath);
    const arc = await withDeadline(openZipBuffer(buf, this.policy, this.m), this.m.mediaTimeoutMs, "zip enumeration");
    try {
      const cap = Math.min(opts.limit ?? 500, this.m.archiveMaxMembers);
      const slice = arc.entries.slice(opts.offset ?? 0, (opts.offset ?? 0) + cap);
      const deniedCount = arc.entries.filter((e) => e.denied).length;
      const unsafeCount = arc.entries.filter((e) => e.unsafe).length;
      return {
        workspace,
        path: r.rel,
        totalMembers: arc.totalMembers,
        shown: slice.length,
        deniedCount,
        unsafeCount,
        truncated: arc.truncated || (opts.offset ?? 0) + slice.length < arc.entries.length,
        nextOffset: arc.truncated ? null : (opts.offset ?? 0) + slice.length < arc.entries.length ? (opts.offset ?? 0) + slice.length : null,
        entries: slice,
      };
    } finally {
      arc.close();
    }
  }

  /** Resolve one member to its raw (still bounded) decompressed bytes plus
   *  the detected kind; the caller routes image/text rendering. */
  async entryBytes(
    workspace: string,
    inputPath: string,
    memberName: string
  ): Promise<{ rel: string; info: ArchiveEntryInfo; buf: Buffer; kind: MediaKind }> {
    const { r, buf } = await this.resolveArchive(workspace, inputPath);
    const safe = safeEntryName(memberName);
    if (safe.unsafe) {
      throw new ToolError("INVALID_ARGUMENT", `unsafe member name (${safe.unsafe}): ${JSON.stringify(memberName.slice(0, 80))}`);
    }
    const denied = this.policy.check(safe.name) ?? this.policy.check(safe.name.trim());
    if (denied) throw new ToolError("ACCESS_DENIED", `archive member denied by policy (${denied}): ${safe.name}`);

    const arc = await withDeadline(openZipBuffer(buf, this.policy, this.m), this.m.mediaTimeoutMs, "zip enumeration");
    try {
      const info = arc.entries.find((e) => e.name === safe.name);
      if (!info) throw new ToolError("NOT_FOUND", `no such archive member: ${safe.name}`);
      if (info.unsafe) throw new ToolError("ACCESS_DENIED", `unsafe member name (${info.unsafe}): ${info.name}`);
      if (info.denied) throw new ToolError("ACCESS_DENIED", `archive member denied by policy (${info.denied}): ${info.name}`);
      if (info.encrypted) throw new ToolError("ACCESS_DENIED", `member is encrypted: ${info.name}`);
      if (info.type === "directory") throw new ToolError("INVALID_ARGUMENT", `member is a directory: ${info.name}`);
      if (info.type !== "file") throw new ToolError("ACCESS_DENIED", `member is a ${info.type} (special-file refusal): ${info.name}`);
      if (info.ratio !== null && info.ratio > this.m.archiveMaxRatio && info.uncompressedBytes > 1_048_576) {
        throw new ToolError(
          "RESOURCE_LIMIT",
          `member ${info.name} expands at ${info.ratio}:1 (limit ${this.m.archiveMaxRatio}:1)`
        );
      }
      if (info.uncompressedBytes > this.m.archiveMaxEntryBytes) {
        throw new ToolError(
          "RESOURCE_LIMIT",
          `member ${info.name} declares ${info.uncompressedBytes} bytes, over limit ${this.m.archiveMaxEntryBytes}`
        );
      }
      const data = await withDeadline(
        arc.readEntry(info, this.m.archiveMaxEntryBytes),
        this.m.mediaTimeoutMs,
        "member decompression"
      );
      if (bufferHasKeyMaterial(data)) {
        throw new ToolError("ACCESS_DENIED", `member contains private-key material (content-class refusal): ${info.name}`);
      }
      const kind = detectKind(data.subarray(0, Math.min(data.length, 8192)));
      if (kind === "zip" || kind === "ooxml") {
        throw new ToolError("UNSUPPORTED_FORMAT", `nested archives are not traversed: ${info.name}`);
      }
      if (kind === "text") {
        const head = data.subarray(0, Math.min(data.length, 262_144)).toString("utf8");
        if (hasPrivateKeyMaterial(head)) {
          throw new ToolError("ACCESS_DENIED", `member contains private-key material: ${info.name}`);
        }
      }
      return { rel: r.rel, info, buf: data, kind };
    } finally {
      arc.close();
    }
  }
}
