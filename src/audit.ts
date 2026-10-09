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

  /**
   * Never write through a symlink: if an attacker-in-root managed to place a
   * link at the audit path — or at ANY parent component (e.g. the operator
   * points the log at `ws/logs/audit.jsonl` and `ws/logs` is a link) —
   * appending must not become a write primitive outside the intended file.
   */
  private safeToWrite(): boolean {
    if (!this.file) return false;
    try {
      if (fs.lstatSync(this.file).isSymbolicLink()) return false;
    } catch {
      /* ENOENT: file does not exist yet — append will create it */
    }
    const dir = path.dirname(this.file);
    let cur = path.isAbsolute(dir) ? path.parse(dir).root : ".";
    for (const seg of dir.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, seg);
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) return false;
      } catch {
        return false; // unreadable/missing component — fail closed
      }
    }
    return true;
  }

  record(e: AuditEvent): void {
    if (!this.file || !this.safeToWrite()) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n";
    try {
      fs.appendFile(this.file, line, { mode: 0o600 }, () => {});
    } catch {
      /* best-effort */
    }
  }
}
