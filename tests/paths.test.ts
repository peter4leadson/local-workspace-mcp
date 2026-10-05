import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeFixture, cleanup, type Fixture } from "./helpers.js";
import { ToolError } from "../src/paths.js";

let f: Fixture;
beforeAll(async () => {
  f = await makeFixture();
});
afterAll(() => cleanup(f));

const code = (e: unknown) => (e instanceof ToolError ? e.code : `threw ${e}`);

describe("containment", () => {
  it("resolves plain relative paths", async () => {
    const r = await f.index.resolve("test", "src/hello.txt");
    expect(r.rel).toBe("src/hello.txt");
  });

  it("rejects ../ traversal", async () => {
    await expect(f.index.resolve("test", "../outside/pwned.txt")).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
  });

  it("rejects nested traversal", async () => {
    await expect(f.index.resolve("test", "deep/../../outside/pwned.txt")).rejects.toMatchObject({
      code: "OUTSIDE_ROOT",
    });
  });

  it("rejects absolute escape", async () => {
    await expect(f.index.resolve("test", "/etc/passwd")).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
  });

  it("rejects encoded traversal attempts as literal names", async () => {
    const r = await f.index.resolve("test", "%2e%2e%2foutside").catch((e) => e);
    expect(r instanceof ToolError ? r.code : "ok").toMatch(/NOT_FOUND|OUTSIDE_ROOT/);
  });

  it("rejects symlink escape to outside dir", async () => {
    await expect(f.index.resolve("test", "link-out/pwned.txt")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("rejects reading through a symlink to a denied in-root file", async () => {
    await expect(f.index.resolve("test", "env-link")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("allows symlink that stays inside root", async () => {
    const r = await f.index.resolve("test", "link-src/hello.txt");
    expect(r.rel).toBe("src/hello.txt");
  });

  it("rejects home expansion", async () => {
    await expect(f.index.resolve("test", "~/.ssh/id_rsa")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("rejects NUL and control characters", async () => {
    await expect(f.index.resolve("test", "src/\0env")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(f.index.resolve("test", "src/\nindex.ts")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects Windows drive paths", async () => {
    await expect(f.index.resolve("test", "C:\\Windows\\system32")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("returns NOT_FOUND for missing in-root paths", async () => {
    await expect(f.index.resolve("test", "src/nope.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns NOT_FOUND for missing paths under missing dirs without leaking", async () => {
    await expect(f.index.resolve("test", "ghost/dir/file.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unknown workspaces without revealing others", async () => {
    await expect(f.index.resolve("nope", ".")).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" });
  });

  it("fails closed when workspace root is missing", async () => {
    await expect(f.index.resolve("missing", ".")).rejects.toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
  });

  it("handles case-variant paths on case-insensitive fs", async () => {
    const r = await f.index.resolve("test", "SRC/HELLO.TXT");
    expect(r.rel.toLowerCase()).toBe("src/hello.txt");
  });

  it("root path itself resolves to '.'", async () => {
    const r = await f.index.resolve("test", ".");
    expect(r.rel).toBe(".");
  });
});

describe("deny policy integration", () => {
  it("denies .env", async () => {
    expect(code(await f.index.resolve("test", ".env").catch((e) => e))).toBe("ACCESS_DENIED");
  });
  it("denies nested .env.local", async () => {
    expect(code(await f.index.resolve("test", "src/.env.local").catch((e) => e))).toMatch(/ACCESS_DENIED|NOT_FOUND/);
  });
  it("allows .env.example", async () => {
    const r = await f.index.resolve("test", ".env.example");
    expect(r.rel).toBe(".env.example");
  });
  it("denies private key", async () => {
    expect(code(await f.index.resolve("test", "keys/id_rsa").catch((e) => e))).toBe("ACCESS_DENIED");
  });
  it("denies pem", async () => {
    expect(code(await f.index.resolve("test", "cert.pem").catch((e) => e))).toBe("ACCESS_DENIED");
  });
  it("denies secrets.json", async () => {
    expect(code(await f.index.resolve("test", "secrets.json").catch((e) => e))).toBe("ACCESS_DENIED");
  });
});
