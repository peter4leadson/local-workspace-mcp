import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeFixture, cleanup, type Fixture } from "./helpers.js";
import { TaskRunner } from "../src/tasks.js";

let f: Fixture;
let tasks: TaskRunner;

beforeAll(async () => {
  f = await makeFixture();
  tasks = new TaskRunner(f.index, f.cfg.tasks, f.cfg.limits);
});
afterAll(() => cleanup(f));

describe("task_run", () => {
  it("executes an enabled task", async () => {
    const r = await tasks.run("test", "echo-ok");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("task-ok");
  });

  it("rejects unlisted task ids (fail closed)", async () => {
    await expect(tasks.run("test", "unlisted-task")).rejects.toMatchObject({ code: "TASK_DENIED" });
    await expect(tasks.run("test", "pwned")).rejects.toMatchObject({ code: "TASK_DENIED" });
  });

  it("rejects malformed/injection task ids", async () => {
    for (const id of ["rm -rf /", "echo-ok; id", "$(id)", "env-dump && cat /etc/passwd", "a|b", "x`id`"]) {
      await expect(tasks.run("test", id)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("times out long-running tasks", async () => {
    const r = await tasks.run("test", "slow");
    expect(r.timedOut).toBe(true);
  }, 20_000);

  it("sanitizes inherited environment", async () => {
    process.env.LWM_TEST_SECRET = "should-not-leak";
    const r = await tasks.run("test", "env-dump");
    expect(r.stdout).not.toContain("LWM_TEST_SECRET");
    expect(r.stdout).toMatch(/^PATH=/m);
    expect(r.stdout).not.toMatch(/^AWS_/m);
  });
});
