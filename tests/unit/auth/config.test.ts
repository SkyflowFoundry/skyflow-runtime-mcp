import { describe, it, expect } from "vitest";
import {
  loadEnterpriseAuthConfig,
  EnterpriseAuthConfigError,
} from "../../../src/lib/auth/config";
import { enabledEnv, TEST_ISSUER, TEST_IDP_ISSUER } from "./helpers";

describe("loadEnterpriseAuthConfig()", () => {
  describe("disabled states", () => {
    it("returns null when ENTERPRISE_AUTH_ENABLED is unset", () => {
      expect(loadEnterpriseAuthConfig({} as NodeJS.ProcessEnv)).toBeNull();
    });

    it("returns null when ENTERPRISE_AUTH_ENABLED is false", () => {
      expect(
        loadEnterpriseAuthConfig({
          ENTERPRISE_AUTH_ENABLED: "false",
        } as NodeJS.ProcessEnv)
      ).toBeNull();
    });

    it("ignores other enterprise vars while disabled", () => {
      expect(
        loadEnterpriseAuthConfig(
          enabledEnv({ ENTERPRISE_AUTH_ENABLED: "no" })
        )
      ).toBeNull();
    });
  });

  describe("enabled with minimal configuration", () => {
    it("returns config with defaults", () => {
      const config = loadEnterpriseAuthConfig(enabledEnv());
      expect(config).not.toBeNull();
      expect(config!.issuer).toBe(TEST_ISSUER);
      expect(config!.idpIssuer).toBe(TEST_IDP_ISSUER);
      expect(config!.resource).toBe(`${TEST_ISSUER}/mcp`);
      expect(config!.idpAudience).toBe(TEST_ISSUER);
      expect(config!.mode).toBe("required");
      expect(config!.tokenTtlSeconds).toBe(900);
      expect(config!.allowedClientIds).toEqual([]);
      expect(config!.idpJwksUri).toBeUndefined();
    });

    it('accepts "1" as enabled', () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({ ENTERPRISE_AUTH_ENABLED: "1" })
      );
      expect(config).not.toBeNull();
    });

    it("strips trailing slashes from URLs", () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({
          ENTERPRISE_AUTH_ISSUER: "https://mcp.example.com/",
          ENTERPRISE_IDP_ISSUER: "https://idp.example.com/",
        })
      );
      expect(config!.issuer).toBe("https://mcp.example.com");
      expect(config!.idpIssuer).toBe("https://idp.example.com");
      expect(config!.resource).toBe("https://mcp.example.com/mcp");
    });
  });

  describe("validation failures (fail closed)", () => {
    it("throws when ENTERPRISE_AUTH_ISSUER is missing", () => {
      const env = enabledEnv();
      delete env.ENTERPRISE_AUTH_ISSUER;
      expect(() => loadEnterpriseAuthConfig(env)).toThrow(
        EnterpriseAuthConfigError
      );
    });

    it("throws when ENTERPRISE_IDP_ISSUER is missing", () => {
      const env = enabledEnv();
      delete env.ENTERPRISE_IDP_ISSUER;
      expect(() => loadEnterpriseAuthConfig(env)).toThrow(
        EnterpriseAuthConfigError
      );
    });

    it("throws when the signing key is missing", () => {
      const env = enabledEnv();
      delete env.ENTERPRISE_AUTH_SIGNING_KEY;
      expect(() => loadEnterpriseAuthConfig(env)).toThrow(
        EnterpriseAuthConfigError
      );
    });

    it("throws when the signing key is too short", () => {
      expect(() =>
        loadEnterpriseAuthConfig(
          enabledEnv({ ENTERPRISE_AUTH_SIGNING_KEY: "short" })
        )
      ).toThrow(/32 characters/);
    });

    it("throws on a non-URL issuer", () => {
      expect(() =>
        loadEnterpriseAuthConfig(
          enabledEnv({ ENTERPRISE_AUTH_ISSUER: "not a url" })
        )
      ).toThrow(EnterpriseAuthConfigError);
    });

    it("throws on http URLs for non-localhost hosts", () => {
      expect(() =>
        loadEnterpriseAuthConfig(
          enabledEnv({ ENTERPRISE_IDP_ISSUER: "http://idp.example.com" })
        )
      ).toThrow(/https/);
    });

    it("allows http for localhost (local development)", () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({ ENTERPRISE_AUTH_ISSUER: "http://localhost:3000" })
      );
      expect(config!.issuer).toBe("http://localhost:3000");
    });

    it("throws on an invalid mode", () => {
      expect(() =>
        loadEnterpriseAuthConfig(
          enabledEnv({ ENTERPRISE_AUTH_MODE: "sometimes" })
        )
      ).toThrow(/required.*optional/);
    });

    it("throws on a non-positive token TTL", () => {
      expect(() =>
        loadEnterpriseAuthConfig(
          enabledEnv({ ENTERPRISE_TOKEN_TTL_SECONDS: "0" })
        )
      ).toThrow(/positive integer/);
    });
  });

  describe("overrides", () => {
    it("accepts optional mode", () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({ ENTERPRISE_AUTH_MODE: "optional" })
      );
      expect(config!.mode).toBe("optional");
    });

    it("accepts a custom resource identifier", () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({ ENTERPRISE_MCP_RESOURCE: "https://other.example.com/mcp" })
      );
      expect(config!.resource).toBe("https://other.example.com/mcp");
    });

    it("accepts a custom IdP audience", () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({ ENTERPRISE_IDP_AUDIENCE: "urn:example:mcp-auth" })
      );
      expect(config!.idpAudience).toBe("urn:example:mcp-auth");
    });

    it("accepts an explicit JWKS URI", () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({
          ENTERPRISE_IDP_JWKS_URI: "https://idp.example.com/oauth2/v1/keys",
        })
      );
      expect(config!.idpJwksUri).toBe("https://idp.example.com/oauth2/v1/keys");
    });

    it("parses the client allowlist CSV with whitespace", () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({
          ENTERPRISE_ALLOWED_CLIENT_IDS: " client-a , client-b ,,client-c",
        })
      );
      expect(config!.allowedClientIds).toEqual([
        "client-a",
        "client-b",
        "client-c",
      ]);
    });

    it("parses a custom token TTL", () => {
      const config = loadEnterpriseAuthConfig(
        enabledEnv({ ENTERPRISE_TOKEN_TTL_SECONDS: "900" })
      );
      expect(config!.tokenTtlSeconds).toBe(900);
    });
  });
});
