/**
 * Shared helpers for enterprise auth tests: a fake enterprise IdP that signs
 * ID-JAGs with a locally generated RSA key, plus config factories.
 */
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import type { EnterpriseAuthConfig } from "../../../src/lib/auth/config";
import { ID_JAG_TYP } from "../../../src/lib/auth/idJag";

export const TEST_IDP_ISSUER = "https://idp.example.com";
export const TEST_ISSUER = "https://mcp.example.com";
export const TEST_RESOURCE = "https://mcp.example.com/mcp";
export const TEST_SIGNING_KEY = "unit-test-signing-key-with-at-least-32-chars";

export function testConfig(
  overrides: Partial<EnterpriseAuthConfig> = {}
): EnterpriseAuthConfig {
  return {
    issuer: TEST_ISSUER,
    resource: TEST_RESOURCE,
    idpIssuer: TEST_IDP_ISSUER,
    idpAudience: TEST_ISSUER,
    signingKey: TEST_SIGNING_KEY,
    allowedClientIds: [],
    tokenTtlSeconds: 3600,
    mode: "required",
    ...overrides,
  };
}

/** Environment variables matching testConfig() for env-injected code paths */
export function enabledEnv(
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    ENTERPRISE_AUTH_ENABLED: "true",
    ENTERPRISE_AUTH_ISSUER: TEST_ISSUER,
    ENTERPRISE_IDP_ISSUER: TEST_IDP_ISSUER,
    ENTERPRISE_AUTH_SIGNING_KEY: TEST_SIGNING_KEY,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

export interface TestIdp {
  /** Resolves the fake IdP's public key, for injecting into validateIdJag */
  keyResolver: JWTVerifyGetKey;
  privateKey: CryptoKey;
  /**
   * Sign an ID-JAG with sensible default claims. Override individual claims
   * via `overrides` (set a claim to undefined to omit it). Override the JWT
   * typ header via `headerTyp` (pass null to omit the typ header).
   */
  signIdJag(
    overrides?: Record<string, unknown>,
    headerTyp?: string | null
  ): Promise<string>;
}

let jtiCounter = 0;

export async function createTestIdp(): Promise<TestIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-idp-key";
  jwk.alg = "RS256";
  const keyResolver = createLocalJWKSet({ keys: [jwk] });

  async function signIdJag(
    overrides: Record<string, unknown> = {},
    headerTyp: string | null = ID_JAG_TYP
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: TEST_IDP_ISSUER,
      aud: TEST_ISSUER,
      sub: "okta-user-123",
      email: "employee@example.com",
      resource: TEST_RESOURCE,
      client_id: "mcp-client-1",
      scope: "de-identify re-identify",
      jti: `jag-${++jtiCounter}-${Date.now()}`,
      iat: now,
      exp: now + 300,
      ...overrides,
    };
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) {
        delete payload[key];
      }
    }
    const header: Record<string, unknown> = { alg: "RS256", kid: "test-idp-key" };
    if (headerTyp !== null) {
      header.typ = headerTyp;
    }
    return new SignJWT(payload)
      .setProtectedHeader(header as { alg: string })
      .sign(privateKey);
  }

  return { keyResolver, privateKey, signIdJag };
}
