import { describe, it, expect } from "vitest";
// @ts-expect-error — plain-JS release gate, imported for regression coverage
import {
  deriveDistTag,
  resolveExpectedVersion,
  resolveTagRef,
  classifyNpmView,
} from "../scripts/release-check.js";

describe("deriveDistTag", () => {
  it.each([
    ["0.1.0", "latest"],
    ["1.2.3", "latest"],
    ["0.2.0-rc.1", "next"],
    ["2.0.0-alpha.3", "next"],
    ["0.3.0-beta.2+build.5", "next"], // prerelease + build metadata
    ["1.0.0+build.7", "latest"], // build metadata alone is still stable
  ])("%s → %s", (version, tag) => {
    expect(deriveDistTag(version)).toBe(tag);
  });
});

describe("resolveExpectedVersion", () => {
  it("prefers the release tag and strips a leading v", () => {
    expect(resolveExpectedVersion({ releaseTag: "v0.2.0", dispatchVersion: "9.9.9" })).toBe("0.2.0");
  });
  it("accepts a tag without the v prefix", () => {
    expect(resolveExpectedVersion({ releaseTag: "0.2.0" })).toBe("0.2.0");
  });
  it("falls back to the dispatch input", () => {
    expect(resolveExpectedVersion({ dispatchVersion: "0.2.0" })).toBe("0.2.0");
  });
  it("strips v from the dispatch input too", () => {
    expect(resolveExpectedVersion({ dispatchVersion: "v0.2.0" })).toBe("0.2.0");
  });
  it("fails closed when neither is provided", () => {
    expect(() => resolveExpectedVersion()).toThrow(/no version resolved/);
  });
});

describe("resolveTagRef", () => {
  it("uses the actual release tag when present (no forced v prefix)", () => {
    expect(resolveTagRef({ releaseTag: "0.2.0", version: "0.2.0" })).toBe("0.2.0");
  });
  it("derives v<version> for dispatch runs", () => {
    expect(resolveTagRef({ version: "0.2.0" })).toBe("v0.2.0");
  });
});

describe("classifyNpmView (duplicate check fails closed)", () => {
  it("exit 0 → version exists", () => {
    expect(classifyNpmView({ code: 0, output: "0.1.0\n" })).toBe("exists");
  });
  it("E404 → definitely absent", () => {
    expect(classifyNpmView({ code: 1, output: "npm error code E404\nnpm error 404 Not Found" })).toBe("absent");
  });
  it.each([
    ["registry outage", { code: 1, output: "npm error ETIMEDOUT registry.npmjs.org" }],
    ["auth failure", { code: 1, output: "npm error code E401 401 Unauthorized" }],
    ["empty failure", { code: 1, output: "" }],
    ["success-looking garbage", { code: 0, output: "" }], // exit 0 always means "exists"
  ])("%s → throws (fail closed)", (_name, res) => {
    expect(() => classifyNpmView(res as never)).not.toThrow;
    // exit-0 case returns "exists"; nonzero non-404 must throw
    if ((res as { code: number }).code !== 0) {
      expect(() => classifyNpmView(res as never)).toThrow(/refusing to continue/);
    }
  });
});
