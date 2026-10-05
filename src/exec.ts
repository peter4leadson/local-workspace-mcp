import { spawn } from "node:child_process";
import { ToolError } from "./paths.js";

export interface BoundedResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface BoundedOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string | undefined>;
}

/**
 * Bounded child-process execution. Always shell-free (`shell: false` semantics
 * via spawn with an argv array): the command string is never interpolated.
 * Kills with SIGKILL on timeout; output is capped at maxOutputBytes across
 * stdout+stderr combined.
 */
export function runBounded(file: string, args: string[], opts: BoundedOptions): Promise<BoundedResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // New process group so we can kill the whole tree on timeout.
      detached: true,
    });

    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const push = (sink: Buffer[], chunk: Buffer) => {
      if (outBytes + chunk.length <= opts.maxOutputBytes) {
        sink.push(chunk);
        outBytes += chunk.length;
      } else {
        const room = Math.max(0, opts.maxOutputBytes - outBytes);
        if (room > 0) sink.push(chunk.subarray(0, room));
        outBytes += chunk.length;
        truncated = true;
      }
    };

    child.stdout?.on("data", (c: Buffer) => push(stdout, c));
    child.stderr?.on("data", (c: Buffer) => push(stderr, c));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, opts.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ToolError("INTERNAL_ERROR", `failed to spawn ${file}: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code,
        signal,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Minimal sanitized environment inherited by git/task subprocesses. */
export function sanitizedEnv(extra?: Record<string, string>): Record<string, string> {
  const allow = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"];
  const env: Record<string, string> = {};
  for (const k of allow) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  // Node toolchain shims must resolve even when the host env is minimal.
  env.PATH = env.PATH && env.PATH.length > 0 ? env.PATH : "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin";
  if (extra) {
    // Operator-supplied task env: blocked names cover secrets AND the dynamic-
    // loader / interpreter / git injection surface. PATH is allowed (needed
    // for toolchain selection) — it is operator-configured, not repo data.
    const blocked = /key|token|secret|pass|^LD_|^DYLD_|^NODE_OPTIONS$|^BASH_ENV$|^ENV$|^GIT_DIR$|^GIT_WORK_TREE$|^GIT_SSH|^GIT_CONFIG|^GIT_EXEC_PATH/i;
    for (const [k, v] of Object.entries(extra)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) || blocked.test(k)) continue;
      // ${VAR} expands against the sanitized base env — lets task defs prepend
      // a toolchain dir to PATH without hardcoding the whole PATH.
      env[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");
    }
  }
  return env;
}

/** Sanitized env tuned for git read operations: no prompts, no credential
 *  helpers, no user/system git config (repo-local config remains — dangerous
 *  keys are neutralized with `-c` overrides in git.ts), literal pathspecs. */
export function gitEnv(): Record<string, string> {
  const env = sanitizedEnv();
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_LITERAL_PATHSPECS = "1";
  return env;
}
