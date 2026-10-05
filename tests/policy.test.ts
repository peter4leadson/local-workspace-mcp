import { describe, it, expect } from "vitest";
import { DenyPolicy } from "../src/policy.js";

const policy = new DenyPolicy(["**/blocked-dir/**"]);
const denied = (p: string) => policy.check(p);

describe("deny policy", () => {
  it.each([
    [".env"],
    ["api/.env"],
    [".env.local"],
    ["deep/.env.production"],
    ["keys/id_rsa"],
    ["keys/id_rsa.pub"],
    ["id_ed25519"],
    ["cert.pem"],
    ["server.key"],
    ["bundle.p12"],
    ["wallet.pfx"],
    ["store.jks"],
    ["db.kdbx"],
    ["secrets.json"],
    ["app/secrets.yaml"],
    [".netrc"],
    [".pgpass"],
    [".npmrc"],
    [".git-credentials"],
    [".git/config"],
    [".git/objects/ab/cdef"],
    ["node_modules/x/.env"],
    ["aws-credentials.json"],
    ["sa-service-account.json"],
    ["blocked-dir/file.ts"],
    [".ssh/config"],
    [".kube/config"],
  ])("denies %s", (p) => {
    expect(denied(p)).not.toBeNull();
  });

  it.each([
    [".env.example"],
    [".env.sample"],
    [".env.template"],
    ["config/.env.staging.example"],
    ["src/index.ts"],
    ["README.md"],
    ["package.json"],
    ["docs/secrets-runbook.md"], // prose about secrets is data, not a secret store
    ["src/environment.ts"],
    ["src/keys.ts"],
    ["public.key.pub.pem.txt"],
  ])("allows %s", (p) => {
    expect(denied(p)).toBeNull();
  });

  it("is case-insensitive (macOS FS)", () => {
    expect(denied(".ENV")).not.toBeNull();
    expect(denied("KEYS/ID_RSA")).not.toBeNull();
    expect(denied(".env.EXAMPLE")).toBeNull();
  });
});
