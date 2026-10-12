# Multimodal file access — implementation spec (v0.2.0)

Date: 2026-10-11. Branch: `feat/multimodal-file-access`. Base: `8ac23da` (main).

Goal: let connected AI hosts inspect images, ZIP archives, PDFs and common
Office documents inside authorized workspaces as **native MCP content blocks**,
without weakening any existing boundary. Motivating case: an agent must see the
actual pixels of a design screenshot — filename and metadata are not enough.

## Invariants (inherited, unchanged)

- Operator-authorized roots only; lexical + canonical (realpath) containment.
- Deny policy applies to every path this feature can reach — including paths
  of entries _inside_ archives.
- Read-oriented: no writes to the workspace, no extraction to disk, no exec,
  no network calls, no new listeners.
- Content-class refusals (private-key armor markers) apply to binary payloads
  too — including inside PNG `tEXt` chunks and archive members.
- Bounded input bytes, decoded pixels, members, pages, output bytes, and
  concurrency; honest `CODE: message` errors; metadata-only audit.
- No silent transforms: a returned image is either the original bytes or an
  explicitly requested, reported re-encode (source sha256 ≠ returned sha256
  is always disclosed alongside the transform description).

## New dependencies (all pinned, >7 days old, permissive licenses)

| Dep              | Ver    | Role                                | Why this one                                                                                                                                                                                    |
| ---------------- | ------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image-size`     | 2.0.4  | magic-byte format + dimension sniff | pure JS, zero deps, MIT, ~50M/wk; safer than hand-rolled JPEG SOF walking                                                                                                                       |
| `sharp`          | 0.35.5 | decode/encode/resize/composite      | Apache-2.0, libvips — the standard; `limitInputPixels` bomb guard; prebuilt binaries (no build script needed)                                                                                   |
| `yauzl`          | 3.4.0  | lazy random-access ZIP reader       | MIT, the reference lazy parser — reads central dir only, streams one entry at a time, detects encryption + CRC/size mismatches                                                                  |
| `@hyzyla/pdfium` | 2.1.13 | PDF page render + text extract      | MIT; PDFium (Chromium's engine) as WASM — battle-tested parser in a memory sandbox, no native dep, no canvas needed. (3.0.0 published <7d ago — refused by minimum-release-age; 2.1.13 pinned.) |

## New tools (+9 → 23 total)

| Tool               | Output                    | Notes                                                                                                                                                                                                                             |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs_inspect`       | text/structured           | kind detection (image/zip/ooxml/pdf/text/binary), mime, size, sha256 (≤cap), image dims, animated flag, zip member count, pdf page count; `openWith` tool hints                                                                   |
| `fs_image`         | text meta + `image` block | PNG/JPEG/WebP/GIF (+AVIF/TIFF/BMP where decoder supports); `frame` selects animated frame (default 0, reported); `fitMaxDim` opt-in bounded resize (reported transform); SVG rasterized only after strict external-reference scan |
| `fs_contact_sheet` | text meta + `image` block | explicit `paths` or `directory`+`glob` selection, ≤24 items, per-item status (ok/denied/missing/unsupported), labeled cells, one PNG (or JPEG if PNG exceeds cap)                                                                 |
| `fs_archive_list`  | text/structured           | ZIP member table: name, type, compressed/uncompressed sizes, ratio, encrypted, denied flag; paginated, member cap                                                                                                                 |
| `fs_archive_entry` | text or text+image        | one named member routed through the file pipeline: image → native block, text → bounded text, other → metadata + refusal. No recursion into nested archives                                                                       |
| `fs_pdf_info`      | text/structured           | page count, metadata fields, encrypted flag, text-layer presence                                                                                                                                                                  |
| `fs_pdf_page`      | text meta + image blocks  | `pages` array, ≤4 per call, scale bounded to pixel cap; reports per-page render dims                                                                                                                                              |
| `fs_pdf_text`      | text/structured           | bounded page range → extracted text; image-only PDFs report `textChars:0` honestly                                                                                                                                                |

`fs_inspect` on `.docx/.pptx/.xlsx` reports `kind:"ooxml"`; `fs_office_text`
extracts paragraphs/slides/sheets via the same ZIP layer (macros flagged,
never executed; legacy `.doc/.xls/.ppt` → explicit UNSUPPORTED_FORMAT).

## Content contract

Image-returning tools respond:

```text
content: [ {type:"text", text:<metadata json>}, {type:"image", data:b64, mimeType, annotations:{audience:["user","assistant"]}}, … ]
structuredContent: <same metadata object, no image bytes>
```

Metadata always carries: `workspace`, `path` (workspace-relative), `sha256`,
`sizeBytes`, detected `format`, `mimeType`, dimensions, and — when the
workspace is a git toplevel — `headSha`. Transformed payloads add
`transform:{kind, sourceSha256, returnedSha256, detail}`. Derived previews
are carved out: `fs_contact_sheet` and `fs_pdf_page` outputs are composites
by design — they carry per-item/page and source `sha256` values instead.

## Limits (config `limits.*` additions, all schema-bounded)

`maxMediaFileBytes` 32 MB input · `maxImagePixels` 40 MP ·
`maxImageOutputBytes` 3.5 MB returned image bytes · `mediaConcurrency` 2 ·
`contactSheetMaxItems` 24 · `archiveMaxMembers` 5000 listed / `archiveMaxEntryBytes`
32 MB expanded per member · `archiveMaxRatio` 200:1 flag+refuse beyond absolute cap ·
`pdfMaxPagesPerCall` 4 render / 50 text · `mediaTimeoutMs` 30 s deadline.

## Security design notes

- **ZIP**: reject absolute/`..`/drive-letter/backslash-normalized member
  names, symlink+special entries (unix mode), encrypted members, method≠0/8;
  stream-decompress under a byte counter (declared sizes are adversarial);
  ratio flagged and capped; nested archives refused at preview.
- **SVG**: rasterize only when a strict scan finds no external references
  (`http(s):`, `file:`, protocol-relative, non-fragment `url()`, `<script`,
  `foreignObject`, `<!ENTITY`, `<?xml-stylesheet`, `@import`, non-data
  `<image href>`). Clean files rasterize at bounded density → PNG.
- **PDF**: PDFium WASM sandbox; no JS execution; no remote-resource fetch;
  attachments never exposed; encrypted files fail honestly.
- **OOXML**: text extracted by scanning `<w:t>`/`<a:t>`/shared-strings nodes;
  only builtin XML entities decoded; no DTD, no external links followed.
- **Bombs**: dims checked from headers _before_ decode; `limitInputPixels`
  enforced at decode; cumulative byte budgets per call.
- **Prompt injection**: document text is data; it cannot widen policy —
  same property as fs_read today.

## Acceptance tests (each maps to `tests/*.test.ts`)

P1 in-root PNG → image block decodes byte-identical · P2 JPEG · P3 symlinked
in-root image ok · N4 symlink escape refused · N5 `.env`-renamed refused by
path, secret-renamed refused by content scan · N6 ext/mime mismatch reported
honestly · N7 corrupt image → INVALID_ARGUMENT · N8 >pixel cap →
RESOURCE_LIMIT · P9 animated GIF frame selection + report · N10 SVG with
external ref refused, clean SVG rasterized+reported · N11 armor marker in
PNG tEXt refused · P12 ZIP of images lists + previews one entry · N13 `../`
entry rejected · N14 absolute entry rejected · N15 symlink entry refused ·
N16 `.env` member denied · N17 renamed key member content-refused · N18 bomb
(ratio/declared-size) capped · N19 member-count cap · N20 nested zip refused ·
N21 corrupt/encrypted zip honest errors · P22 single-page PDF render+text ·
P23 multipage selective pages · P24 image-only PDF reports no text layer ·
N25 malformed PDF error · N26 embedded-JS PDF renders without executing ·
N27 page-cap enforcement · N28 oversized output requires explicit fit ·
P29 office docx/pptx/xlsx text+structure · N30 denied audit leak check ·
P31 contact sheet multi-image + per-item failures reported.

## Host boundary honesty

Image blocks are spec-native (`ImageContent`). MCP Inspector + Claude/Codex
hosts render or model-consume them. ChatGPT's connector layer has documented
history of dropping image blocks (returns `{}` or text-serialized base64);
the tunnel forwards responses verbatim (verified in `tunnel-client` source:
`payload.JSONResponse = rawResponse`). End-to-end ChatGPT acceptance is
verified separately and recorded — a server-side PASS is not a host claim.

## Host verification status (2026-10-11, HEAD 070e932)

- Stdio protocol smoke: PASS — 23 tools listed, `fs_image` returns a
  byte-identical native `image` block plus metadata text/structuredContent.
- Tunnel datapath: PASS — forwarded `initialize` (server 0.2.0, protocol
  2025-11-25) and `tools/call` execute against the rebuilt child; Codex
  app-server `local_workspace_fs_stat` returned real data end-to-end.
- ChatGPT connector catalog: STALE — `codex_apps__local_workspace` retains
  the 14-tool pre-feature snapshot; the control plane never forwards
  `tools/list` in this flow and the daemon skips stdio startup probing.
  Connector re-discovery requires a ChatGPT-side refresh (edit/re-save the
  "Local Workspace" connector, or a new conversation that re-lists tools).
- Image-through-connector acceptance: **PENDING_CONNECTOR_REFRESH** — do not
  claim ChatGPT consumes `fs_image` pixels until the refreshed catalog
  exposes all 23 tools and a synthetic canary returns visual input.
