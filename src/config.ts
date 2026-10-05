import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

export const CONFIG_ENV = "WORKSPACE_MCP_CONFIG";

export function defaultConfigDir(): string {
  return process.env.WORKSPACE_MCP_CONFIG_DIR ?? path.join(os.homedir(), ".config", "local-workspace-mcp");
}

export function defaultConfigPath(): string {
  return process.env[CONFIG_ENV] ?? path.join(defaultConfigDir(), "config.json");
}

export function defaultAuditLogPath(): string {
  return path.join(defaultConfigDir(), "audit.jsonl");
}

const TaskDefinitionSchema = z.object({
  description: z.string().max(300).optional(),
  command: z.array(z.string().min(1).max(500)).min(1).max(16),
  // cwd is interpreted relative to the workspace root; "." = root.
  cwd: z.string().max(500).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  // Extra environment variables merged over the sanitized base env.
  // Values are literals only; never reference secrets here.
  env: z.record(z.string().max(200)).optional(),
});

const WorkspaceSchema = z.object({
  path: z.string().min(1),
  description: z.string().max(300).optional(),
  tasks: z.array(z.string()).default([]),
});

const LimitsSchema = z.object({
  maxReadBytes: z.number().int().min(1024).max(2_000_000).default(256_000),
  defaultReadBytes: z.number().int().min(512).max(256_000).default(65_536),
  maxReadFileBytes: z.number().int().min(65_536).max(50_000_000).default(5_000_000),
  maxListEntries: z.number().int().min(10).max(10_000).default(500),
  maxSearchResults: z.number().int().min(10).max(5_000).default(200),
  maxSearchMatchesPerFile: z.number().int().min(1).max(200).default(20),
  searchDeadlineMs: z.number().int().min(1000).max(120_000).default(20_000),
  maxReadManyFiles: z.number().int().min(1).max(100).default(32),
  maxReadManyTotalBytes: z.number().int().min(4096).max(1_000_000).default(256_000),
  maxTaskOutputBytes: z.number().int().min(1024).max(1_000_000).default(65_536),
  gitTimeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
  maxGitOutputBytes: z.number().int().min(4096).max(2_000_000).default(262_144),
  walkEntryCap: z.number().int().min(1000).max(500_000).default(50_000),
  walkDepthCap: z.number().int().min(1).max(64).default(20),
});

const ConfigSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(WorkspaceSchema),
  tasks: z.record(TaskDefinitionSchema).default({}),
  // Additional deny globs matched against workspace-relative paths and basenames.
  deny: z.array(z.string().max(300)).default([]),
  limits: LimitsSchema.default({}),
  auditLog: z.string().optional(),
});

export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type RawConfig = z.infer<typeof ConfigSchema>;

export interface LoadedConfig extends RawConfig {
  configPath: string;
}

export function loadConfig(configPath = defaultConfigPath()): LoadedConfig {
  let rawText: string;
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `CONFIG_ERROR: cannot read config at ${configPath} (${code ?? String(err)}). ` +
        `Create it with \`workspace-mcp init-config\`.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`CONFIG_ERROR: ${configPath} is not valid JSON`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`CONFIG_ERROR: ${configPath} failed validation: ${result.error.message}`);
  }
  const cfg = result.data;
  for (const [id, ws] of Object.entries(cfg.workspaces)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
      throw new Error(`CONFIG_ERROR: workspace id ${JSON.stringify(id)} must match ^[a-z0-9][a-z0-9_-]{0,63}$`);
    }
    for (const t of ws.tasks) {
      if (!cfg.tasks[t]) {
        throw new Error(`CONFIG_ERROR: workspace ${id} enables unknown task ${JSON.stringify(t)}`);
      }
    }
  }
  return { ...cfg, configPath };
}
