import fs from "node:fs";
import path from "node:path";

export interface AuditEvent {
  tool: string;
  workspace?: string;
  target?: string; // workspace-relative path or task id — never absolute host paths
  ok: boolean;
  code?: string; // error class e.g. ACCESS_DENIED — never the raw message
  durationMs?: number;
  truncated?: boolean;
}

/**
 * Metadata-only audit log (JSONL). Never logs file contents, absolute host
 * paths, environment values, or tool arguments beyond a workspace-relative
 * target identifier.
 */
export class AuditLog {
  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch {
        /* audit is best-effort; never crash the server over logging */
      }
    }
  }

  record(e: AuditEvent): void {
    if (!this.file) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n";
    try {
      fs.appendFile(this.file, line, { mode: 0o600 }, () => {});
    } catch {
      /* best-effort */
    }
  }
}
