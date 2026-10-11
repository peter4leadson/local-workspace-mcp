import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import yazl from "yazl";
import { makeFixture, cleanup, connectClient, type Fixture } from "./helpers.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Media-tool acceptance tests (docs/MULTIMODAL-SPEC.md P1–P31). All fixtures
 * are synthetic — no real credentials, documents, or user content.
 */

let f: Fixture;
let client: Client;

/** Content-call helper that keeps raw blocks so image payloads survive. */
const callRaw = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text?: string; data?: string; mimeType?: string }[];
  const text = content.find((c) => c.type === "text")?.text ?? "";
  const images = content.filter((c) => c.type === "image");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* error lines are CODE: message, not json */
  }
  return { isError: res.isError === true, text, parsed, images, content };
};

const pngCanary = async (w = 64, h = 64) => {
  // Left half red, right half blue — distinctive visual facts for hosts.
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (x < w / 2) [raw[i], raw[i + 1], raw[i + 2]] = [255, 0, 0];
      else [raw[i], raw[i + 1], raw[i + 2]] = [0, 0, 255];
    }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
};

const animatedGif = async () => {
  const mk = (rgb: number[]) => {
    const raw = Buffer.alloc(16 * 16 * 3);
    for (let i = 0; i < raw.length; i += 3) [raw[i], raw[i + 1], raw[i + 2]] = rgb as [number, number, number];
    return sharp(raw, { raw: { width: 16, height: 16, channels: 3 } }).png().toBuffer();
  };
  const [r, g, b] = await Promise.all([mk([255, 0, 0]), mk([0, 255, 0]), mk([0, 0, 255])]);
  return sharp([r, g, b], { join: { animated: true } }).gif({ delay: [200, 200, 200], loop: 0 }).toBuffer();
};

/** Hand-rolled CRC32 (Node 20 lacks zlib.crc32) for PNG chunk fixtures. */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Insert a tEXt chunk (with valid CRC) before IEND. */
const pngWithText = (png: Buffer, keyword: string, text: string) => {
  const payload = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from("tEXt"), payload])));
  const chunk = Buffer.concat([len, Buffer.from("tEXt"), payload, crc]);
  const iendAt = png.length - 12; // IEND is always last
  return Buffer.concat([png.subarray(0, iendAt), chunk, png.subarray(iendAt)]);
};

const buildZip = (entries: { name: string; data: Buffer | string; mode?: number }[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const e of entries)
      z.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name, e.mode ? { mode: e.mode } : {});
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    z.outputStream.on("error", reject);
    z.end();
  });

/** Rewrite every occurrence of a placeholder member name (same byte length)
 *  so hostile names can exist in fixtures — yazl refuses to write them. */
const patchZipName = (zip: Buffer, from: string, to: string) => {
  const f = Buffer.from(from, "latin1");
  const t = Buffer.from(to, "latin1");
  if (f.length !== t.length) throw new Error("name patch must be same length");
  const out = Buffer.from(zip);
  let idx = 0;
  while ((idx = out.indexOf(f, idx)) !== -1) {
    t.copy(out, idx);
    idx += t.length;
  }
  return out;
};

/** Minimal valid multi-page PDF with text objects; offsets computed exactly. */
const makePdf = (pageTexts: string[]) => {
  const objs: string[] = [];
  const n = pageTexts.length;
  // obj numbering: 1 catalog, 2 pages, 3..3+n-1 pages, then contents, then font last
  const fontId = 3 + n * 2;
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pageTexts.map((_, i) => `${3 + i} 0 R`).join(" ");
  objs[1] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  pageTexts.forEach((_, i) => {
    objs[2 + i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${3 + n + i} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    const stream = `BT /F1 24 Tf 100 700 Td (${pageTexts[i]}) Tj ET`;
    objs[2 + n + i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objs[fontId - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
};

beforeAll(async () => {
  f = await makeFixture({ git: true });
  const w = f.wsDir;
  const canary = await pngCanary();
  fs.writeFileSync(path.join(w, "canary.png"), canary);
  fs.writeFileSync(path.join(w, "mislabeled.png"), await sharp(canary).jpeg().toBuffer());
  fs.writeFileSync(path.join(w, "anim.gif"), await animatedGif());
  fs.writeFileSync(path.join(w, "clean.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#00ff00"/><circle cx="10" cy="10" r="6" fill="#ff00ff"/></svg>`);
  fs.writeFileSync(
    path.join(w, "evil.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><image href="file:///etc/passwd" width="40" height="20"/><image href="https://evil.example/x.png"/></svg>`
  );
  // Nested data-URI SVG smuggling a file:// ref (review finding: data: must
  // not bypass the scan — only raster payloads are safe inline)
  const nested = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd" width="400" height="400"/></svg>`
  ).toString("base64");
  fs.writeFileSync(
    path.join(w, "nested.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><image href="data:image/svg+xml;base64,${nested}"/></svg>`
  );
  fs.writeFileSync(
    path.join(w, "wsurl.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><style>rect{fill:url(" file:///etc/passwd ")}</style></defs><rect width="40" height="20"/></svg>`
  );
  fs.writeFileSync(
    path.join(w, "cssescape.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><style>@impo\\72t "x.css";</style></defs><rect width="40" height="20"/></svg>`
  );
  // review-2c: `\<non-hex>` is a literal char escape — `@\import` → `@import`
  fs.writeFileSync(
    path.join(w, "cssnonhex.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><style>@\\import "x.css";</style></defs><rect width="40" height="20"/></svg>`
  );
  // review-2d: `u\rl(` decodes to `url(` — escape inside the function name
  fs.writeFileSync(
    path.join(w, "cssescurl.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><style>rect{fill:u\\rl(file:///etc/passwd)}</style></defs><rect width="40" height="20"/></svg>`
  );
  // review-2e: XML numeric refs inside <style> decode before CSS sees them
  fs.writeFileSync(
    path.join(w, "entityurl.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><style>rect{fill:url&#40;file:///etc/passwd&#41;}</style></defs><rect width="40" height="20"/></svg>`
  );
  fs.writeFileSync(
    path.join(w, "entityimport.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><style>@impo&#114;t "x.css";</style></defs><rect width="40" height="20"/></svg>`
  );
  // review-2f: xml:base re-anchors every same-document ref off-root
  fs.writeFileSync(
    path.join(w, "xmlbase.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" xml:base="file:///etc/" width="40" height="20"><defs><image id="x" href="#none"/></defs><use href="#x"/></svg>`
  );
  // review-2g: external DTD declaration
  fs.writeFileSync(
    path.join(w, "docext.svg"),
    `<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>`
  );
  fs.writeFileSync(path.join(w, "proper.jpg"), await sharp(canary).jpeg().toBuffer());
  fs.symlinkSync("canary.png", path.join(w, "imglink.png"));
  fs.writeFileSync(
    path.join(w, "scripted.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>alert(1)</script><rect width="40" height="20"/></svg>`
  );
  fs.writeFileSync(path.join(w, "keyed.png"), pngWithText(canary, "Comment", "-----BEGIN RSA PRIVATE KEY-----\nAAAA"));
  fs.writeFileSync(path.join(w, "corrupt.png"), Buffer.concat([Buffer.from("BADMAGIC"), canary.subarray(8)]));
  // >output-cap but well under pixel cap: gaussian noise barely compresses
  fs.writeFileSync(
    path.join(w, "noise.png"),
    await sharp({ create: { width: 1500, height: 1500, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer()
  );
  fs.writeFileSync(path.join(w, "renamed-secret.txt.png"), canary);
  fs.mkdirSync(path.join(w, "shots"), { recursive: true });
  fs.writeFileSync(path.join(w, "shots", "one.png"), canary);
  fs.writeFileSync(path.join(w, "shots", "two.png"), await pngCanary(32, 32));
  fs.writeFileSync(path.join(w, "shots", "three.txt"), "not an image\n");

  const inner = await buildZip([{ name: "inner.txt", data: "nested zip payload" }]);
  const archive = patchZipName(
    await buildZip([
      { name: "pics/pic.png", data: canary },
      { name: "notes/readme.txt", data: "inside archive hello\nline two\n" },
      // placeholder ZZZZZZ → patched to ../../ after build (yazl refuses "..")
      { name: "ZZZZZZescape.txt", data: "traversal" },
      // placeholder QQQQQQ → patched to /evil/ (absolute member name)
      { name: "QQQQQQabs.txt", data: "absolute member" },
      { name: ".env", data: "SECRET=inside-zip\n" },
      { name: ".env ", data: "SECRET=trailing-space\n" },
      { name: "keys/priv.pem", data: "-----BEGIN PRIVATE KEY-----\nMC4CAQ\n" },
      { name: "notes/report.txt", data: "benign name but -----BEGIN PRIVATE KEY-----\nMC4CAQ\n" },
      // review-N2: PuTTY-format key under a benign name, under 8KiB — the
      // size-gated text scan used to skip it
      { name: "keys/backup.txt", data: "PuTTY-User-Key-File-3: ssh-ed25519\nComment: test\nPublic-Lines: 1\nAAAA\nPrivate-Lines: 1\nBBBB\n" },
      // review-N8: armor marker split across a line boundary inside one member
      { name: "notes/split.txt", data: "-----BEGIN PRIVATE\nKEY-----\nMC4CAQ\n" },
      // review-R8: bare directory member — placeholder donlyX patched to
      // donly/ after build (yazl refuses trailing-slash names)
      { name: "donlyX", data: "x" },
      { name: "donly/file.txt", data: "inside dir\n" },
      { name: "zeros.bin", data: Buffer.alloc(2_000_000, 0x30) },
      { name: "nested.zip", data: inner },
      // symlink entry: unix mode S_IFLNK|0777
      { name: "linky.txt", data: "/etc/passwd", mode: 0o120777 },
    ]),
    "ZZZZZZ",
    "../../"
  );
  const patched = patchZipName(patchZipName(archive, "QQQQQQ", "/evil/"), "donlyX", "donly/");
  fs.writeFileSync(path.join(w, "archive.zip"), patched);

  // duplicate-name desync fixture: two members, same name, different bytes
  const dup = await buildZip([
    { name: "dup.txt", data: "FIRST member wins — declared small" },
    { name: "dup.txt", data: "SECOND member must never be served" },
  ]);
  fs.writeFileSync(path.join(w, "dupes.zip"), dup);
  // member-count cap fixture: 7 members, tested against an override of 5
  fs.writeFileSync(
    path.join(w, "many.zip"),
    await buildZip([1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `f${i}.txt`, data: `m${i}` })))
  );

  fs.writeFileSync(path.join(w, "armor.docx"), await buildZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="x"/>` },
    { name: "word/document.xml", data: `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>-----BEGIN PRIVATE KEY-----\nMC4CAQ</w:t></w:r></w:p></w:body></w:document>` },
  ]));
  fs.writeFileSync(path.join(w, "armor.pdf"), makePdf(["-----BEGIN PRIVATE KEY----- MC4CAQ"]));
  // review-N8: armor marker split across a page boundary
  fs.writeFileSync(path.join(w, "splitarmor.pdf"), makePdf(["-----BEGIN PRIVATE", "KEY----- MC4CAQ"]));
  // image-only page: no text operators at all
  fs.writeFileSync(path.join(w, "scan.pdf"), makePdf([""]));
  fs.writeFileSync(path.join(w, "corrupt.zip"), Buffer.concat([archive.subarray(0, 60), Buffer.from("TRUNCATED")]));

  fs.writeFileSync(path.join(w, "one.pdf"), makePdf(["CANARY PDF PAGE ONE 4242"]));
  fs.writeFileSync(path.join(w, "three.pdf"), makePdf(["PAGE ONE", "SECOND PAGE MARKER", "THIRD"]));
  fs.writeFileSync(path.join(w, "bad.pdf"), Buffer.from("%PDF-1.4\nthis is not a real document\n%%EOF"));

  const docx = await buildZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="x"/></Types>` },
    { name: "word/document.xml", data: `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>HELLO DOCX CANARY</w:t></w:r></w:p><w:p><w:r><w:t>second &amp; third</w:t></w:r></w:p></w:body></w:document>` },
    { name: "word/media/image1.png", data: canary },
  ]);
  fs.writeFileSync(path.join(w, "doc.docx"), docx);
  const xlsx = await buildZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0"?><workbook xmlns="x"/>` },
    { name: "xl/sharedStrings.xml", data: `<?xml version="1.0"?><sst xmlns="x"><si><t>XLSX_CANARY_CELL</t></si></sst>` },
    { name: "xl/worksheets/sheet1.xml", data: `<?xml version="1.0"?><worksheet xmlns="x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>` },
  ]);
  fs.writeFileSync(path.join(w, "book.xlsx"), xlsx);
  const pptx = await buildZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: "ppt/presentation.xml", data: `<?xml version="1.0"?><p:presentation xmlns:p="p"/>` },
    { name: "ppt/slides/slide1.xml", data: `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>PPTX SLIDE CANARY</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>` },
    { name: "ppt/vbaProject.bin", data: Buffer.from("fake macro") },
  ]);
  fs.writeFileSync(path.join(w, "deck.pptx"), pptx);
  fs.writeFileSync(path.join(w, "legacy.doc"), Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]));

  client = await connectClient(f);
});
afterAll(async () => {
  await client.close();
  cleanup(f);
});

describe("fs_inspect", () => {
  it("P1 triage: png reports kind/format/dims/sha256 + openWith", async () => {
    const r = await callRaw("fs_inspect", { workspace: "test", path: "canary.png" });
    expect(r.isError).toBe(false);
    expect(r.parsed!.kind).toBe("png");
    expect(r.parsed!.mimeType).toBe("image/png");
    expect(r.parsed!.width).toBe(64);
    expect(r.parsed!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.parsed!.openWith).toContain("fs_image");
  });

  it("N6 ext/mime mismatch reported honestly", async () => {
    const r = await callRaw("fs_inspect", { workspace: "test", path: "mislabeled.png" });
    expect(r.parsed!.kind).toBe("jpeg");
    expect(r.parsed!.mimeType).toBe("image/jpeg");
  });

  it("zip reports member counts and openWith archive tools", async () => {
    const r = await callRaw("fs_inspect", { workspace: "test", path: "archive.zip" });
    expect(r.parsed!.kind).toBe("zip");
    expect(r.parsed!.memberCount).toBeGreaterThan(5);
    expect(r.parsed!.unsafeCount).toBeGreaterThan(0);
    expect(r.parsed!.openWith).toContain("fs_archive_list");
  });

  it("ooxml subtype detected via content types", async () => {
    const r = await callRaw("fs_inspect", { workspace: "test", path: "doc.docx" });
    expect(r.parsed!.kind).toBe("ooxml");
    expect(r.parsed!.officeFormat).toBe("docx");
    expect(r.parsed!.openWith).toContain("fs_office_text");
  });

  it("denied path refuses before sniffing", async () => {
    const r = await callRaw("fs_inspect", { workspace: "test", path: ".env" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });
});

describe("fs_image", () => {
  it("P1 returns original bytes as a native image block", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "canary.png" });
    expect(r.isError).toBe(false);
    expect(r.images.length).toBe(1);
    expect(r.images[0]!.mimeType).toBe("image/png");
    const served = Buffer.from(r.images[0]!.data!, "base64");
    const disk = fs.readFileSync(path.join(f.wsDir, "canary.png"));
    expect(served.equals(disk)).toBe(true); // byte-identical evidence
    expect(r.parsed!.sha256).toBeTruthy();
    expect(r.parsed!.transform).toBeUndefined();
  });

  it("P9 animated gif frame selection reported", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "anim.gif", frame: 2 });
    expect(r.isError).toBe(false);
    expect(r.images[0]!.mimeType).toBe("image/png");
    expect(r.parsed!.frames).toBe(3);
    expect(r.parsed!.animated).toBe(true);
    expect((r.parsed!.transform as { detail: string }).detail).toContain("frame 2");
  });

  it("frame out of range fails with bounded error", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "anim.gif", frame: 9 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^INVALID_ARGUMENT/);
  });

  it("P10 clean svg rasterized with disclosed transform", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "clean.svg" });
    expect(r.isError).toBe(false);
    expect(r.images[0]!.mimeType).toBe("image/png");
    expect((r.parsed!.transform as { kind: string }).kind).toBe("svg-rasterize");
  });

  it("N10 svg with external refs refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "evil.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).toContain("external-href");
  });

  it("svg containing script refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "scripted.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-1: data:image/svg+xml nested doc refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "nested.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-2: whitespace-inside-quotes url() refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "wsurl.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-2b: css-escaped @import refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "cssescape.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-2c: non-hex css escape @\\import refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "cssnonhex.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-2d: escaped u\\rl() refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "cssescurl.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-2e: xml entity-encoded url() refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "entityurl.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    const r2 = await callRaw("fs_image", { workspace: "test", path: "entityimport.svg" });
    expect(r2.isError).toBe(true);
    expect(r2.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-2f: xml:base refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "xmlbase.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).toContain("xml-base");
  });

  it("REG review-2g: external doctype refused", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "docext.svg" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("clean svg still rasterizes (no false positive from decode passes)", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "clean.svg" });
    expect(r.isError).toBe(false);
    expect(r.images.length).toBe(1);
    expect(r.images[0]!.mimeType).toBe("image/png");
  });

  it("P2 jpeg serves natively; P3 in-root symlinked image serves", async () => {
    const j = await callRaw("fs_image", { workspace: "test", path: "proper.jpg" });
    expect(j.isError).toBe(false);
    expect(j.images[0]!.mimeType).toBe("image/jpeg");
    const l = await callRaw("fs_image", { workspace: "test", path: "imglink.png" });
    expect(l.isError).toBe(false);
    expect(l.images.length).toBe(1);
  });

  it("N11 armor marker inside PNG tEXt refused by content class", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "keyed.png" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).toContain("private-key material");
  });

  it("N4 symlink escape refused; N5 denied file refused", async () => {
    const esc = await callRaw("fs_image", { workspace: "test", path: "link-out/pwned.txt" });
    expect(esc.isError).toBe(true);
    const denied = await callRaw("fs_image", { workspace: "test", path: ".env" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/^ACCESS_DENIED/);
  });

  it("N7 corrupt image errors honestly", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "corrupt.png" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^(INVALID_ARGUMENT|UNSUPPORTED_FORMAT|INTERNAL_ERROR)/);
  });

  it("non-image routed to correct tool hint", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "src/hello.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^UNSUPPORTED_FORMAT/);
    expect(r.text).toContain("fs_read");
  });

  it("N8 pixel cap refuses oversized decodes (even with fit)", async () => {
    // Re-connect a client with a tiny pixel cap to exercise the boundary.
    const tight = await connectClient(f, { maxImagePixels: 2000 });
    try {
      const over = await tight.callTool({ name: "fs_image", arguments: { workspace: "test", path: "canary.png" } });
      expect(over.isError).toBe(true);
      expect(JSON.stringify(over.content)).toContain("RESOURCE_LIMIT");
      const fit = await tight.callTool({ name: "fs_image", arguments: { workspace: "test", path: "canary.png", fitMaxDim: 32 } });
      expect(fit.isError).toBe(true); // decode cost is the bomb vector — fit cannot rescue
    } finally {
      await tight.close();
    }
  });

  it("N28 over-output-cap image requires explicit fitMaxDim", async () => {
    const plain = await callRaw("fs_image", { workspace: "test", path: "noise.png" });
    expect(plain.isError).toBe(true);
    expect(plain.text).toMatch(/^RESOURCE_LIMIT/);
    expect(plain.text).toContain("fitMaxDim");
    const fit = await callRaw("fs_image", { workspace: "test", path: "noise.png", fitMaxDim: 256 });
    expect(fit.isError).toBe(false);
    expect(fit.images.length).toBe(1);
    expect((fit.parsed!.transform as { kind: string }).kind).toBe("re-encode");
    expect((fit.parsed!.transform as { detail: string }).detail).toContain("resized");
  });

  it("audit/error text never leaks absolute host paths", async () => {
    const r = await callRaw("fs_image", { workspace: "test", path: "canary.png" });
    expect(JSON.stringify(r.parsed)).not.toContain(f.tmp);
  });
});

describe("fs_contact_sheet", () => {
  it("P31 multi-image sheet with layout map", async () => {
    const r = await callRaw("fs_contact_sheet", {
      workspace: "test",
      paths: ["canary.png", "shots/one.png", "shots/two.png"],
    });
    expect(r.isError).toBe(false);
    expect(r.images.length).toBe(1);
    expect(r.parsed!.itemCount).toBe(3);
    const items = r.parsed!.items as { status: string; position: { row: number; col: number } }[];
    expect(items.every((i) => i.status === "ok")).toBe(true);
    expect(items[0]!.position).toEqual({ row: 0, col: 0 });
  });

  it("per-item failures degrade the cell, not the call", async () => {
    const r = await callRaw("fs_contact_sheet", {
      workspace: "test",
      paths: ["canary.png", ".env", "does-not-exist.png", "shots/three.txt"],
    });
    expect(r.isError).toBe(false);
    const items = r.parsed!.items as { status: string; path: string }[];
    expect(items.filter((i) => i.status === "ok").length).toBe(1);
    expect(items.filter((i) => i.status === "failed").length).toBe(3);
  });

  it("directory+glob selection works", async () => {
    const r = await callRaw("fs_contact_sheet", { workspace: "test", directory: "shots", glob: "*.png" });
    expect(r.isError).toBe(false);
    expect(r.parsed!.itemCount).toBe(2);
  });
});

describe("fs_archive_list / fs_archive_entry", () => {
  it("P12 lists members with flags", async () => {
    const r = await callRaw("fs_archive_list", { workspace: "test", path: "archive.zip" });
    expect(r.isError).toBe(false);
    const entries = r.parsed!.entries as { name: string; unsafe?: string; denied?: string }[];
    const names = entries.map((e) => e.name);
    expect(names).toContain("pics/pic.png");
    const traversal = entries.find((e) => e.unsafe === "traversal");
    expect(traversal).toBeTruthy();
    const env = entries.find((e) => e.name === ".env");
    expect(env?.denied).toBeTruthy();
  });

  it("P12 previews image member as native image block", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "pics/pic.png" });
    expect(r.isError).toBe(false);
    expect(r.images.length).toBe(1);
    const disk = fs.readFileSync(path.join(f.wsDir, "canary.png"));
    expect(Buffer.from(r.images[0]!.data!, "base64").equals(disk)).toBe(true);
  });

  it("previews text member as bounded text", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "notes/readme.txt" });
    expect(r.isError).toBe(false);
    expect((r.parsed!.text as string)).toContain("inside archive hello");
  });

  it("N13 traversal member rejected (and even direct request refused)", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "../../escape.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^(INVALID_ARGUMENT|ACCESS_DENIED)/);
  });

  it("N16 .env member denied by policy", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: ".env" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).not.toContain("inside-zip");
  });

  it("N17 renamed private-key member refused by content class", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "keys/priv.pem" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("N14 absolute member name refused at preview and flagged in list", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "/evil/abs.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^(INVALID_ARGUMENT|ACCESS_DENIED)/);
    const list = await callRaw("fs_archive_list", { workspace: "test", path: "archive.zip" });
    const abs = (list.parsed!.entries as { unsafe?: string }[]).find((e) => e.unsafe === "absolute-path");
    expect(abs).toBeTruthy();
  });

  it("deny evasion via trailing-space member name refused", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: ".env " });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).not.toContain("trailing-space");
  });

  it("N17b armor under a benign member name refused by content class", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "notes/report.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-5: duplicate member — second flagged, first served", async () => {
    const list = await callRaw("fs_archive_list", { workspace: "test", path: "dupes.zip" });
    const dupes = (list.parsed!.entries as { name: string; unsafe?: string }[]).filter((e) => e.name === "dup.txt");
    expect(dupes.length).toBe(2);
    expect(dupes.filter((d) => d.unsafe === "duplicate-name").length).toBe(1);
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "dupes.zip", member: "dup.txt" });
    expect(r.isError).toBe(false);
    expect(r.parsed!.text).toContain("FIRST member");
    expect(r.parsed!.text).not.toContain("SECOND");
  });

  it("REG review-N2: small PuTTY-key member under benign name refused", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "keys/backup.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).not.toContain("Public-Lines");
  });

  it("REG review-N8: armor marker split across lines refused", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "notes/split.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("REG review-R8: bare directory member classified as directory", async () => {
    const list = await callRaw("fs_archive_list", { workspace: "test", path: "archive.zip" });
    // Listing name is normalized ("donly"); classification uses the raw name.
    const dir = (list.parsed!.entries as { name: string; type: string }[]).find((e) => e.name === "donly");
    expect(dir?.type).toBe("directory");
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "donly/" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^INVALID_ARGUMENT/);
  });

  it("N19 member-count cap truncates listing", async () => {
    const tight = await connectClient(f, { archiveMaxMembers: 5 });
    try {
      const r = await tight.callTool({ name: "fs_archive_list", arguments: { workspace: "test", path: "many.zip" } });
      const p = JSON.parse((r.content as { text: string }[])[0]!.text);
      expect(p.truncated).toBe(true);
    } finally {
      await tight.close();
    }
  });

  it("N15 symlink member refused at preview", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "linky.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).toContain("symlink");
  });

  it("N18 high-ratio member capped", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "zeros.bin" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^RESOURCE_LIMIT/);
  });

  it("N20 nested archive refused at preview", async () => {
    const r = await callRaw("fs_archive_entry", { workspace: "test", path: "archive.zip", member: "nested.zip" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^UNSUPPORTED_FORMAT/);
  });

  it("N21 corrupt zip fails with bounded error", async () => {
    const r = await callRaw("fs_archive_list", { workspace: "test", path: "corrupt.zip" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^(INVALID_ARGUMENT|UNSUPPORTED_FORMAT|NOT_FOUND)/);
  });

  it("archive tools refuse denied host path", async () => {
    const r = await callRaw("fs_archive_list", { workspace: "test", path: ".env" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });
});

describe("fs_pdf_*", () => {
  it("P22 single-page pdf: info + render + text", async () => {
    const info = await callRaw("fs_pdf_info", { workspace: "test", path: "one.pdf" });
    expect(info.isError).toBe(false);
    expect(info.parsed!.pageCount).toBe(1);
    expect(info.parsed!.hasTextLayer).toBe(true);

    const page = await callRaw("fs_pdf_page", { workspace: "test", path: "one.pdf", pages: [1] });
    expect(page.isError).toBe(false);
    expect(page.images.length).toBe(1);
    expect(page.images[0]!.mimeType).toBe("image/png");
    const rendered = Buffer.from(page.images[0]!.data!, "base64");
    const meta = await sharp(rendered).metadata();
    expect(meta.width).toBeGreaterThan(100);

    const text = await callRaw("fs_pdf_text", { workspace: "test", path: "one.pdf" });
    expect(text.parsed!.pages[0].text).toContain("CANARY PDF PAGE ONE 4242");
  });

  it("P23 multipage selective render", async () => {
    const r = await callRaw("fs_pdf_page", { workspace: "test", path: "three.pdf", pages: [1, 3] });
    expect(r.isError).toBe(false);
    expect(r.images.length).toBe(2);
    const pages = (r.parsed!.renderedPages as { page: number }[]).map((p) => p.page);
    expect(pages).toEqual([1, 3]);
  });

  it("N25 malformed pdf errors honestly", async () => {
    const r = await callRaw("fs_pdf_info", { workspace: "test", path: "bad.pdf" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^INVALID_ARGUMENT/);
  });

  it("N27 page cap enforced", async () => {
    const r = await callRaw("fs_pdf_page", { workspace: "test", path: "three.pdf", pages: [1, 2, 3, 4, 5] });
    expect(r.isError).toBe(true);
  });

  it("P24 image-only pdf reports no text layer honestly", async () => {
    const info = await callRaw("fs_pdf_info", { workspace: "test", path: "scan.pdf" });
    expect(info.isError).toBe(false);
    expect(info.parsed!.hasTextLayer).toBe(false);
    const text = await callRaw("fs_pdf_text", { workspace: "test", path: "scan.pdf" });
    expect(text.parsed!.textChars).toBe(0);
  });

  it("armor marker inside pdf text layer refused", async () => {
    const r = await callRaw("fs_pdf_text", { workspace: "test", path: "armor.pdf" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).not.toContain("MC4CAQ");
  });

  it("REG review-N8: armor marker split across pages refused", async () => {
    const r = await callRaw("fs_pdf_text", { workspace: "test", path: "splitarmor.pdf" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).not.toContain("MC4CAQ");
  });

  it("endPage before startPage is INVALID_ARGUMENT", async () => {
    const r = await callRaw("fs_pdf_text", { workspace: "test", path: "three.pdf", startPage: 3, endPage: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^INVALID_ARGUMENT/);
  });

  it("pdf tools refuse non-pdf and denied paths", async () => {
    const r = await callRaw("fs_pdf_info", { workspace: "test", path: "canary.png" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^UNSUPPORTED_FORMAT/);
    const denied = await callRaw("fs_pdf_info", { workspace: "test", path: ".env" });
    expect(denied.isError).toBe(true);
  });
});

describe("fs_office_text", () => {
  it("P29 docx paragraphs extracted", async () => {
    const r = await callRaw("fs_office_text", { workspace: "test", path: "doc.docx" });
    expect(r.isError).toBe(false);
    expect(r.parsed!.officeFormat).toBe("docx");
    const all = JSON.stringify(r.parsed!.sections);
    expect(all).toContain("HELLO DOCX CANARY");
    expect(all).toContain("second & third");
  });

  it("pptx slides extracted + macros flagged", async () => {
    const r = await callRaw("fs_office_text", { workspace: "test", path: "deck.pptx" });
    expect(r.parsed!.officeFormat).toBe("pptx");
    expect(r.parsed!.macrosPresent).toBe(true);
    expect(JSON.stringify(r.parsed!.sections)).toContain("PPTX SLIDE CANARY");
  });

  it("xlsx cells resolved through shared strings", async () => {
    const r = await callRaw("fs_office_text", { workspace: "test", path: "book.xlsx" });
    expect(r.parsed!.officeFormat).toBe("xlsx");
    const all = JSON.stringify(r.parsed!.sections);
    expect(all).toContain("XLSX_CANARY_CELL");
    expect(all).toContain("42");
  });

  it("armor marker inside docx section refused", async () => {
    const r = await callRaw("fs_office_text", { workspace: "test", path: "armor.docx" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).not.toContain("MC4CAQ");
  });

  it("legacy OLE refused explicitly", async () => {
    const r = await callRaw("fs_office_text", { workspace: "test", path: "legacy.doc" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^UNSUPPORTED_FORMAT/);
    expect(r.text).toContain("OOXML");
  });
});
