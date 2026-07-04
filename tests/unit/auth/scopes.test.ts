import { describe, it, expect } from "vitest";
import {
  parseGrantedScopes,
  isToolPermitted,
  buildScopeDenial,
} from "../../../src/lib/auth/scopes";

describe("enterprise scope enforcement", () => {
  describe("parseGrantedScopes()", () => {
    it("returns undefined when no scope claim was present (unrestricted)", () => {
      expect(parseGrantedScopes(undefined)).toBeUndefined();
    });

    it("splits space-delimited scopes", () => {
      expect(parseGrantedScopes("de-identify re-identify")).toEqual([
        "de-identify",
        "re-identify",
      ]);
    });

    it("returns an empty array for an empty scope claim (nothing granted)", () => {
      expect(parseGrantedScopes("")).toEqual([]);
      expect(parseGrantedScopes("  ")).toEqual([]);
    });
  });

  describe("isToolPermitted()", () => {
    it("permits everything when scopes are undefined", () => {
      expect(isToolPermitted("de-identify", undefined)).toBe(true);
      expect(isToolPermitted("re-identify", undefined)).toBe(true);
    });

    it("permits only the named tools when scopes are present", () => {
      expect(isToolPermitted("de-identify", ["de-identify"])).toBe(true);
      expect(isToolPermitted("re-identify", ["de-identify"])).toBe(false);
    });

    it("permits nothing for an empty scope list", () => {
      expect(isToolPermitted("de-identify", [])).toBe(false);
    });
  });

  describe("buildScopeDenial()", () => {
    it("returns an insufficient_scope error naming the tool and granted scopes", () => {
      const denial = buildScopeDenial("re-identify", ["de-identify"]);
      expect(denial.error).toBe("insufficient_scope");
      expect(denial.message).toContain('"re-identify"');
      expect(denial.message).toContain("de-identify");
    });

    it("explains when no tool scopes were granted at all", () => {
      const denial = buildScopeDenial("de-identify", []);
      expect(denial.error).toBe("insufficient_scope");
      expect(denial.message).toContain("no tool scopes");
    });
  });
});
