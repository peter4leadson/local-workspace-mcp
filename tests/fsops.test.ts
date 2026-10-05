import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeFixture, cleanup, type Fixture } from "./helpers.js";
import { FsOps } from "../src/fsOps.js";
import { gitEnv } from "../src/exec.js";

let f: Fixture;
let ops: FsOps;

beforeAll(async () => {
  f = await makeFixture({ git: true });
  ops = new FsOps(f.index, f.policy, f.cfg.limits, gitEnv, 15_000);
});
afterAll(() => cleanup(f));

describe("fs_read", () => {
  it("reads text with metadata", async () => {
    const r = await ops.read("test", "src/hello.txt");
    expect(r.content).toContain("hello workspace world");
    expect(r.truncated).toBe(false);
    expect(r.totalLines).toBe(2);
  });
  it("paginates by line range", async () => {
    const r = await ops.read("test", "src/index.ts", { startLine: 3, maxLines: 2 });
    expect(r.startLine).toBe(3);
    expect(r.content.split("\n")).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.nextStartLine).toBe(5);
  });
  it("refuses binary", async () => {
    await expect(ops.read("test", "big.bin")).rejects.toMatchObject({ code: "BINARY_FILE" });
  });
  it("refuses over-limit files", async () => {
    await expect(ops.read("test", "huge.txt")).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });
});

describe("fs_read_many", () => {
  it("reads multiple with inline per-file errors", async () => {
    const r = await ops.readMany("test", ["src/hello.txt", ".env", "nope.txt", "src/index.ts"]);
    expect(r.files).toHaveLength(4);
    const files = r.files as { path?: string; error?: string }[];
    expect(files[1]!.error).toMatch(/^ACCESS_DENIED/);
    expect(files[2]!.error).toMatch(/^NOT_FOUND/);
  });
});

describe("fs_list", () => {
  it("lists entries and flags denied/symlink entries", async () => {
    const r = await ops.list("test", ".");
    const names = r.entries.map((e) => e.name);
    expect(names).toContain("src");
    const env = r.entries.find((e) => e.name === ".env");
    expect(env?.denied).toBe("dotenv");
    const link = r.entries.find((e) => e.name === "link-out");
    expect(link?.type).toBe("symlink");
  });
});

describe("fs_search_files", () => {
  it("finds by basename glob via git universe", async () => {
    const r = await ops.searchFiles("test", "*.txt");
    const paths = r.matches.map((m) => m.path);
    expect(paths).toContain("uncommitted.txt");
    expect(paths).toContain("src/hello.txt");
  });
  it("filters denied files and reports the count", async () => {
    const r = await ops.searchFiles("test", "*");
    const paths = r.matches.map((m) => m.path);
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("keys/id_rsa");
    expect(paths).not.toContain("secrets.json");
    expect(paths).not.toContain("cert.pem");
    expect(paths).toContain(".env.example");
    expect(r.deniedFiltered).toBeGreaterThan(0);
  });
  it("scopes to subdirectory", async () => {
    const r = await ops.searchFiles("test", "*.ts", "src");
    expect(r.matches.every((m) => m.path.startsWith("src/"))).toBe(true);
  });
});

describe("fs_search_content", () => {
  it("finds literal matches", async () => {
    const r = await ops.searchContent("test", "hello workspace world");
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0]!.path).toBe("src/hello.txt");
  });
  it("does not surface denied file contents", async () => {
    const r = await ops.searchContent("test", "supersecret");
    expect(r.matches).toHaveLength(0);
  });
  it("supports regex", async () => {
    const r = await ops.searchContent("test", "x = \\d+", { regex: true });
    expect(r.matches.length).toBeGreaterThan(0);
  });
});
