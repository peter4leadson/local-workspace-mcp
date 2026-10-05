import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeFixture, cleanup, type Fixture } from "./helpers.js";
import { GitOps, assertRef } from "../src/git.js";
import { ToolError } from "../src/paths.js";

let f: Fixture;
let gitOps: GitOps;

beforeAll(async () => {
  f = await makeFixture({ git: true });
  gitOps = new GitOps(15_000, 262_144, f.policy);
});
afterAll(() => cleanup(f));

describe("git_status", () => {
  it("reports branch, HEAD, and uncommitted working tree truth", async () => {
    const s = await gitOps.status(f.wsDir);
    expect(s.repo).toBe(true);
    if (!s.repo) return;
    expect(s.branch).toBe("main");
    expect(s.head).toMatch(/^[0-9a-f]{40}$/);
    expect(s.clean).toBe(false);
    expect(s.modified).toContain("src/index.ts");
    expect(s.untracked).toContain("uncommitted.txt");
  });
});

describe("git_diff / log / show / branches", () => {
  it("diff reflects working-tree changes", async () => {
    const d = await gitOps.diff(f.wsDir, {});
    expect(d.diff).toContain("export const x = 2");
  });
  it("diff redacts hunks for tracked denied files", async () => {
    const d = await gitOps.diff(f.wsDir, {});
    expect(d.diff).not.toContain("SECRET=two");
    expect(d.diff).toContain("denied-content");
  });
  it("diff pathspec filter works through -- separator", async () => {
    const d = await gitOps.diff(f.wsDir, { paths: ["src/index.ts"] });
    expect(d.diff).toContain("export const x = 2");
    expect(d.diff).not.toContain("diff --git a/.env.tracked");
  });
  it("log accepts a valid ref", async () => {
    const l = await gitOps.log(f.wsDir, { ref: "main" });
    expect(l.commits.length).toBe(1);
  });
  it("stat mode summarizes", async () => {
    const d = await gitOps.diff(f.wsDir, { stat: true });
    expect(d.diff).toContain("src/index.ts");
    expect(d.diff).not.toContain("export const x = 2");
  });
  it("log returns commits", async () => {
    const l = await gitOps.log(f.wsDir, {});
    expect(l.commits[0]?.subject).toBe("initial");
  });
  it("show returns commit metadata", async () => {
    const s = await gitOps.show(f.wsDir, "HEAD");
    expect(s.output).toContain("initial");
  });
  it("show ref:path returns blob content", async () => {
    const s = await gitOps.show(f.wsDir, "HEAD:src/hello.txt");
    expect(s.output).toContain("hello workspace world");
  });
  it("branches lists current branch", async () => {
    const b = await gitOps.branches(f.wsDir);
    expect(b.current).toBe("main");
    expect(b.branches.some((br) => br.name === "main" && br.current)).toBe(true);
  });
});

describe("ref validation (option-injection defense)", () => {
  it.each([
    "--help",
    "-u",
    "--output=/tmp/evil",
    "--exec=rm -rf ~",
    "HEAD; rm -rf /",
    "HEAD && cat /etc/passwd",
    "HEAD`id`",
    "$(cat /etc/passwd)",
    "@{u}",
    "..\\..",
    "a..b",
    "-",
    "--",
    "ref name",
    "HEAD~`x`",
  ])("rejects %s", (ref) => {
    expect(() => assertRef(ref)).toThrow(ToolError);
  });
  it.each(["HEAD", "main", "v1.2.3", "feature/foo-bar", "abc1234", "HEAD~2", "HEAD^", "refs/heads/main"])(
    "accepts %s",
    (ref) => {
      expect(assertRef(ref)).toBe(ref);
    }
  );
  it("injected refs also fail at the git layer", async () => {
    await expect(gitOps.log(f.wsDir, { ref: "--all" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(gitOps.show(f.wsDir, "--output=/tmp/x")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
