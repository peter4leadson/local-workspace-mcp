import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeFixture, cleanup, type Fixture } from "./helpers.js";
import { isInsideCanonical } from "../src/paths.js";
import { GitOps } from "../src/git.js";
import { DenyPolicy } from "../src/policy.js";
import { WorkspaceIndex } from "../src/paths.js";
import { FsOps } from "../src/fsOps.js";
import { gitEnv } from "../src/exec.js";
import { makeLimits } from "./helpers.js";

let f: Fixture;
let ops: FsOps;
let gitOps: GitOps;

beforeAll(async () => {
  f = await makeFixture({ git: true });
  ops = new FsOps(f.index, f.policy, f.cfg.limits, gitEnv, 15_000);
  gitOps = new GitOps(15_000, 262_144, f.policy);
});
afterAll(() => cleanup(f));

describe("canonical containment is case-strict", () => {
  it("rejects case-variant siblings on canonical paths", () => {
    expect(isInsideCanonical("/a/WORK/secret", "/a/work")).toBe(false);
    expect(isInsideCanonical("/a/work/secret", "/a/work")).toBe(true);
    expect(isInsideCanonical("/a/work", "/a/work")).toBe(true);
  });
});

describe("nested-repo exposure (finding: parent repo must not leak)", () => {
  let nested: string;
  let nestedIndex: WorkspaceIndex;
  let nestedOps: FsOps;
  beforeAll(async () => {
    nested = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-nested-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: nested });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: nested });
    execFileSync("git", ["config", "user.name", "T"], { cwd: nested });
    fs.mkdirSync(path.join(nested, "sub"), { recursive: true });
    fs.writeFileSync(path.join(nested, "parent-secret.txt"), "parent content\n");
    fs.writeFileSync(path.join(nested, "sub", "child.txt"), "child content\n");
    execFileSync("git", ["add", "."], { cwd: nested });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: nested });
    const policy = new DenyPolicy([]);
    nestedIndex = new WorkspaceIndex({ sub: { path: path.join(nested, "sub"), tasks: [] } }, policy);
    await nestedIndex.init();
    nestedOps = new FsOps(nestedIndex, policy, makeLimits(), gitEnv, 15_000);
  });
  afterAll(() => fs.rmSync(nested, { recursive: true, force: true }));

  it("git_status refuses to operate on the parent repo", async () => {
    const s = await gitOps.status(path.join(nested, "sub"));
    expect(s.repo).toBe(false);
  });
  it("git show refuses parent-repo objects", async () => {
    const s = await gitOps.show(path.join(nested, "sub"), "HEAD");
    expect(s.repo).toBe(false);
  });
  it("search universe falls back to walk — no ../parent files", async () => {
    const r = await nestedOps.searchFiles("sub", "*.txt");
    expect(r.matches.every((m) => !m.path.startsWith(".."))).toBe(true);
    expect(r.matches.some((m) => m.path.includes("parent-secret"))).toBe(false);
  });
});

describe("denied dirs and new deny classes", () => {
  it("fs_list on .ssh dir is denied (bare-dir rule)", async () => {
    await expect(ops.list("test", ".ssh")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("fs_stat on .ssh dir is denied", async () => {
    await expect(ops.stat("test", ".ssh")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("fs_read .envrc / prod.env / .zsh_history / tfvars denied", async () => {
    for (const p of [".envrc", "prod.env", ".zsh_history", "deploy.tfvars"]) {
      await expect(ops.read("test", p)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    }
  });
});

describe("ENOTDIR handling", () => {
  it("path through a regular file reports NOT_FOUND", async () => {
    await expect(f.index.resolve("test", "src/hello.txt/sub")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("searchContent is not a denied-content oracle", () => {
  it("response omits denied-match counters", async () => {
    const r = await ops.searchContent("test", "SECRET");
    expect("deniedFiltered" in r).toBe(false);
    expect("rawMatches" in r).toBe(false);
  });
});
