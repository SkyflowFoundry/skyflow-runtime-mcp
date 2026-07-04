import { describe, it, expect } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  issueAccessToken,
  verifyAccessToken,
  looksLikeEnterpriseToken,
  ACCESS_TOKEN_TYP,
} from "../../../src/lib/auth/accessTokens";
import { testConfig, TEST_ISSUER, TEST_RESOURCE } from "./helpers";

const identity = {
  subject: "okta-user-123",
  email: "employee@example.com",
  scope: "de-identify re-identify",
  clientId: "mcp-client-1",
};

describe("enterprise access tokens", () => {
  describe("issueAccessToken()", () => {
    it("issues a token that verifies and round-trips the identity", async () => {
      const issued = await issueAccessToken(identity, testConfig());
      expect(issued.expiresIn).toBe(3600);
      expect(issued.scope).toBe(identity.scope);

      const verified = await verifyAccessToken(issued.accessToken, testConfig());
      expect(verified).toEqual(identity);
    });

    it("is audience-restricted to the MCP resource identifier", async () => {
      const issued = await issueAccessToken(identity, testConfig());
      const payload = decodeJwt(issued.accessToken);
      expect(payload.aud).toBe(TEST_RESOURCE);
      expect(payload.iss).toBe(TEST_ISSUER);
      expect(payload.jti).toBeTruthy();
    });

    it(`uses the ${ACCESS_TOKEN_TYP} typ header`, async () => {
      const issued = await issueAccessToken(identity, testConfig());
      expect(decodeProtectedHeader(issued.accessToken).typ).toBe(ACCESS_TOKEN_TYP);
    });

    it("omits optional claims that were not present", async () => {
      const issued = await issueAccessToken(
        { subject: "user-1" },
        testConfig()
      );
      const verified = await verifyAccessToken(issued.accessToken, testConfig());
      expect(verified.subject).toBe("user-1");
      expect(verified.email).toBeUndefined();
      expect(verified.scope).toBeUndefined();
      expect(verified.clientId).toBeUndefined();
    });

    it("preserves an empty scope claim (deny-all) instead of dropping it", async () => {
      // scope: "" means the IdP granted no tool scopes — dropping the claim
      // would invert that into an unrestricted token
      const issued = await issueAccessToken(
        { subject: "user-1", scope: "" },
        testConfig()
      );
      const payload = decodeJwt(issued.accessToken);
      expect(payload.scope).toBe("");
      const verified = await verifyAccessToken(issued.accessToken, testConfig());
      expect(verified.scope).toBe("");
    });

    it("honors the configured TTL", async () => {
      const issued = await issueAccessToken(
        identity,
        testConfig({ tokenTtlSeconds: 900 })
      );
      expect(issued.expiresIn).toBe(900);
      const payload = decodeJwt(issued.accessToken);
      expect(payload.exp! - payload.iat!).toBe(900);
    });
  });

  describe("verifyAccessToken()", () => {
    it("rejects a tampered token", async () => {
      const issued = await issueAccessToken(identity, testConfig());
      const tampered = issued.accessToken.slice(0, -4) + "AAAA";
      await expect(
        verifyAccessToken(tampered, testConfig())
      ).rejects.toThrow();
    });

    it("rejects a token signed with a different key", async () => {
      const issued = await issueAccessToken(identity, testConfig());
      const otherConfig = testConfig({
        signingKey: "a-completely-different-signing-key-32ch",
      });
      await expect(
        verifyAccessToken(issued.accessToken, otherConfig)
      ).rejects.toThrow();
    });

    it("rejects an expired token", async () => {
      // TTL beyond the 60s clock tolerance in the past
      const issued = await issueAccessToken(
        identity,
        testConfig({ tokenTtlSeconds: -120 })
      );
      await expect(
        verifyAccessToken(issued.accessToken, testConfig())
      ).rejects.toThrow();
    });

    it("rejects a token issued for a different resource", async () => {
      const issued = await issueAccessToken(
        identity,
        testConfig({ resource: "https://other.example.com/mcp" })
      );
      await expect(
        verifyAccessToken(issued.accessToken, testConfig())
      ).rejects.toThrow();
    });

    it("rejects arbitrary bearer values", async () => {
      await expect(
        verifyAccessToken("sky-api-key-123", testConfig())
      ).rejects.toThrow();
    });
  });

  describe("looksLikeEnterpriseToken()", () => {
    it("recognizes tokens issued by this server", async () => {
      const issued = await issueAccessToken(identity, testConfig());
      expect(looksLikeEnterpriseToken(issued.accessToken, testConfig())).toBe(true);
    });

    it("does not match JWTs from other issuers", async () => {
      const issued = await issueAccessToken(
        identity,
        testConfig({ issuer: "https://other.example.com" })
      );
      expect(looksLikeEnterpriseToken(issued.accessToken, testConfig())).toBe(false);
    });

    it("does not match non-JWT values", () => {
      expect(looksLikeEnterpriseToken("sky-api-key-123", testConfig())).toBe(false);
      expect(looksLikeEnterpriseToken("", testConfig())).toBe(false);
    });
  });
});
