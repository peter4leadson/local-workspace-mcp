import { minimatch } from "minimatch";

/**
 * Sensitive-material deny policy.
 *
 * Applied to the workspace-RELATIVE path (POSIX-style, "/" separators) and to
 * the basename. Deny wins over everything else. The policy lives here, in
 * code + the operator-owned config file, never inside a watched workspace.
 */

interface DenyRule {
  pattern: string;
  reason: string;
}

/** Patterns checked against the full workspace-relative path AND the basename. */
const DEFAULT_DENY: DenyRule[] = [
  // dotenv: real env files denied; templates allowed via ALLOW below
  { pattern: "**/.env", reason: "dotenv" },
  { pattern: "**/.env.*", reason: "dotenv" },
  { pattern: ".env", reason: "dotenv" },
  { pattern: ".env.*", reason: "dotenv" },
  // ssh / pgp / keys
  { pattern: "**/.ssh/**", reason: "ssh" },
  { pattern: "**/.gnupg/**", reason: "gnupg" },
  { pattern: "**/id_rsa*", reason: "private-key" },
  { pattern: "**/id_ed25519*", reason: "private-key" },
  { pattern: "**/id_ecdsa*", reason: "private-key" },
  { pattern: "**/id_dsa*", reason: "private-key" },
  { pattern: "**/*.pem", reason: "private-key-material" },
  { pattern: "**/*.key", reason: "private-key-material" },
  { pattern: "**/*.p12", reason: "private-key-material" },
  { pattern: "**/*.pfx", reason: "private-key-material" },
  { pattern: "**/*.keystore", reason: "private-key-material" },
  { pattern: "**/*.jks", reason: "private-key-material" },
  { pattern: "**/*.kdbx", reason: "private-key-material" },
  { pattern: "**/*.keychain", reason: "keychain" },
  { pattern: "**/*.keychain-db", reason: "keychain" },
  // cloud / cli credential stores
  { pattern: "**/.aws/**", reason: "cloud-credentials" },
  { pattern: "**/.kube/**", reason: "kube-credentials" },
  { pattern: "**/kubeconfig", reason: "kube-credentials" },
  { pattern: "**/kubeconfig.*", reason: "kube-credentials" },
  { pattern: "**/.docker/config.json", reason: "docker-credentials" },
  { pattern: "**/.dockercfg", reason: "docker-credentials" },
  { pattern: "**/.azure/**", reason: "cloud-credentials" },
  { pattern: "**/.config/gcloud/**", reason: "cloud-credentials" },
  { pattern: "**/credentials", reason: "credential-file" },
  { pattern: "**/credentials.*", reason: "credential-file" },
  { pattern: "**/*-credentials.json", reason: "credential-file" },
  { pattern: "**/*credentials*.json", reason: "credential-file" },
  { pattern: "**/*service-account*.json", reason: "credential-file" },
  { pattern: "**/serviceAccountKey*.json", reason: "credential-file" },
  { pattern: "**/gha-creds-*.json", reason: "credential-file" },
  // auth files
  { pattern: "**/.netrc", reason: "auth-file" },
  { pattern: "**/.pgpass", reason: "auth-file" },
  { pattern: "**/.npmrc", reason: "token-file" },
  { pattern: "**/.pypirc", reason: "token-file" },
  { pattern: "**/.git-credentials", reason: "git-credentials" },
  { pattern: "**/.gitconfig", reason: "git-config" },
  { pattern: "**/secrets.json", reason: "secrets-file" },
  { pattern: "**/secrets.yaml", reason: "secrets-file" },
  { pattern: "**/secrets.yml", reason: "secrets-file" },
  { pattern: "**/secrets.toml", reason: "secrets-file" },
  { pattern: "**/secrets.d/**", reason: "secrets-file" },
  { pattern: "**/.secrets/**", reason: "secrets-file" },
  // git internals: object store + possibly credentialed remote config
  { pattern: "**/.git/**", reason: "git-internals" },
  { pattern: ".git/**", reason: "git-internals" },
  { pattern: ".git", reason: "git-internals" },
];

/** Explicit template exceptions evaluated BEFORE deny rules. */
const DEFAULT_ALLOW: string[] = [
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
  "**/.env.*.example",
  "**/.env.*.sample",
  "**/.env.*.template",
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.*.example",
  ".env.*.sample",
  ".env.*.template",
];

export class DenyPolicy {
  private readonly deny: DenyRule[];
  private readonly allow: string[];
  private readonly extraCount: number;

  constructor(extraDenyPatterns: string[] = []) {
    this.deny = [...DEFAULT_DENY, ...extraDenyPatterns.map((p) => ({ pattern: p, reason: "operator-deny" }))];
    this.allow = [...DEFAULT_ALLOW];
    this.extraCount = extraDenyPatterns.length;
  }

  get extraRuleCount(): number {
    return this.extraCount;
  }

  /**
   * Returns the deny reason class when the workspace-relative path is denied,
   * or null when allowed. `relPath` must use "/" separators.
   */
  check(relPath: string): string | null {
    const rel = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    const base = rel.split("/").pop() ?? rel;
    for (const allow of this.allow) {
      if (minimatch(rel, allow, { dot: true, nocase: true }) || minimatch(base, allow, { dot: true, nocase: true })) {
        return null;
      }
    }
    for (const rule of this.deny) {
      if (
        minimatch(rel, rule.pattern, { dot: true, nocase: true }) ||
        minimatch(base, rule.pattern, { dot: true, nocase: true })
      ) {
        return rule.reason;
      }
    }
    return null;
  }
}
