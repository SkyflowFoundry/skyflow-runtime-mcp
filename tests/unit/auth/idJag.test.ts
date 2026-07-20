import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import {
  validateIdJag,
  IdJagValidationError,
  resetIdJagCaches,
  getIdpKeyResolver,
  ID_JAG_TYP,
} from "../../../src/lib/auth/idJag";
import {
  createTestIdp,
  testConfig,
  TEST_RESOURCE,
  type TestIdp,
} from "./helpers";

describe("validateIdJag()", () => {
  let idp: TestIdp;

  beforeAll(async () => {
    idp = await createTestIdp();
  });

  beforeEach(() => {
    resetIdJagCaches();
  });

  async function expectOAuthError(
    promise: Promise<unknown>,
    oauthError: string,
    messagePattern?: RegExp
  ) {
    const error = await promise.then(
      () => null,
      (e) => e
    );
    expect(error).toBeInstanceOf(IdJagValidationError);
    expect((error as IdJagValidationError).oauthError).toBe(oauthError);
    if (messagePattern) {
      expect((error as IdJagValidationError).message).toMatch(messagePattern);
    }
  }

  describe("valid grants", () => {
    it("returns the claims from a valid ID-JAG", async () => {
      const assertion = await idp.signIdJag();
      const claims = await validateIdJag(assertion, testConfig(), idp.keyResolver);
      expect(claims.subject).toBe("okta-user-123");
      expect(claims.email).toBe("employee@example.com");
      expect(claims.scope).toBe("de-identify re-identify");
      expect(claims.clientId).toBe("mcp-client-1");
      expect(claims.jti).toBeTruthy();
    });

    it("accepts an ID-JAG without a resource claim", async () => {
      const assertion = await idp.signIdJag({ resource: undefined });
      const claims = await validateIdJag(assertion, testConfig(), idp.keyResolver);
      expect(claims.subject).toBe("okta-user-123");
    });

    it("accepts a resource claim array containing this server", async () => {
      const assertion = await idp.signIdJag({
        resource: ["https://other.example.com/mcp", TEST_RESOURCE],
      });
      const claims = await validateIdJag(assertion, testConfig(), idp.keyResolver);
      expect(claims.subject).toBe("okta-user-123");
    });

    it("accepts an ID-JAG without optional email/scope claims", async () => {
      const assertion = await idp.signIdJag({
        email: undefined,
        scope: undefined,
      });
      const claims = await validateIdJag(assertion, testConfig(), idp.keyResolver);
      expect(claims.email).toBeUndefined();
      expect(claims.scope).toBeUndefined();
    });

    it("accepts an allowlisted client", async () => {
      const assertion = await idp.signIdJag({ client_id: "mcp-client-1" });
      const config = testConfig({ allowedClientIds: ["mcp-client-1", "other"] });
      const claims = await validateIdJag(assertion, config, idp.keyResolver);
      expect(claims.clientId).toBe("mcp-client-1");
    });
  });

  describe("JWT-level rejections (invalid_grant)", () => {
    it("rejects a wrong typ header", async () => {
      const assertion = await idp.signIdJag({}, "JWT");
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant"
      );
    });

    it("rejects a missing typ header", async () => {
      const assertion = await idp.signIdJag({}, null);
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant"
      );
    });

    it("rejects a wrong issuer", async () => {
      const assertion = await idp.signIdJag({ iss: "https://evil.example.com" });
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant"
      );
    });

    it("rejects a wrong audience", async () => {
      const assertion = await idp.signIdJag({ aud: "https://other-as.example.com" });
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant"
      );
    });

    it("rejects an ID-JAG without an exp claim (would otherwise never expire)", async () => {
      const assertion = await idp.signIdJag({ exp: undefined });
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant",
        /exp/
      );
    });

    it("rejects an ID-JAG without an iat claim", async () => {
      const assertion = await idp.signIdJag({ iat: undefined });
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant",
        /iat/
      );
    });

    it("rejects an expired ID-JAG", async () => {
      const now = Math.floor(Date.now() / 1000);
      const assertion = await idp.signIdJag({ iat: now - 600, exp: now - 300 });
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant"
      );
    });

    it("rejects a signature from an unknown key", async () => {
      const otherIdp = await createTestIdp();
      const assertion = await otherIdp.signIdJag();
      // Validated against the first IdP's JWKS
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant"
      );
    });

    it("rejects symmetric (HS256) signatures", async () => {
      const now = Math.floor(Date.now() / 1000);
      const secret = new TextEncoder().encode(testConfig().signingKey);
      const assertion = await new SignJWT({
        iss: testConfig().idpIssuer,
        aud: testConfig().idpAudience,
        sub: "okta-user-123",
        jti: "hs256-attack",
        iat: now,
        exp: now + 300,
      })
        .setProtectedHeader({ alg: "HS256", typ: ID_JAG_TYP })
        .sign(secret);
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant"
      );
    });

    it("rejects garbage assertions", async () => {
      await expectOAuthError(
        validateIdJag("not-a-jwt", testConfig(), idp.keyResolver),
        "invalid_grant"
      );
    });
  });

  describe("JWKS discovery", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubDiscovery(jwksUri: unknown) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ jwks_uri: jwksUri }),
        })
      );
    }

    it("accepts an https jwks_uri from the discovery document", async () => {
      stubDiscovery("https://idp.example.com/oauth2/v1/keys");
      const resolver = await getIdpKeyResolver(testConfig());
      expect(typeof resolver).toBe("function");
    });

    it("rejects a non-https jwks_uri from the discovery document", async () => {
      stubDiscovery("http://idp.example.com/oauth2/v1/keys");
      await expect(getIdpKeyResolver(testConfig())).rejects.toThrow(
        /non-https jwks_uri/
      );
    });

    it("rejects a discovery document without a jwks_uri", async () => {
      stubDiscovery(undefined);
      await expect(getIdpKeyResolver(testConfig())).rejects.toThrow(
        /no jwks_uri/
      );
    });
  });

  describe("claim-level rejections", () => {
    it("rejects a missing sub claim", async () => {
      const assertion = await idp.signIdJag({ sub: undefined });
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant",
        /sub/
      );
    });

    it("rejects a resource claim for a different server", async () => {
      const assertion = await idp.signIdJag({
        resource: "https://other.example.com/mcp",
      });
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant",
        /resource/
      );
    });

    it("rejects a missing jti claim", async () => {
      const assertion = await idp.signIdJag({ jti: undefined });
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant",
        /jti/
      );
    });

    it("rejects a replayed ID-JAG", async () => {
      const assertion = await idp.signIdJag();
      await validateIdJag(assertion, testConfig(), idp.keyResolver);
      await expectOAuthError(
        validateIdJag(assertion, testConfig(), idp.keyResolver),
        "invalid_grant",
        /already been used/
      );
    });

    it("rejects a non-allowlisted client (unauthorized_client)", async () => {
      const assertion = await idp.signIdJag({ client_id: "rogue-client" });
      const config = testConfig({ allowedClientIds: ["mcp-client-1"] });
      await expectOAuthError(
        validateIdJag(assertion, config, idp.keyResolver),
        "unauthorized_client"
      );
    });

    it("rejects a missing client_id when an allowlist is configured", async () => {
      const assertion = await idp.signIdJag({ client_id: undefined });
      const config = testConfig({ allowedClientIds: ["mcp-client-1"] });
      await expectOAuthError(
        validateIdJag(assertion, config, idp.keyResolver),
        "unauthorized_client"
      );
    });
  });
});
