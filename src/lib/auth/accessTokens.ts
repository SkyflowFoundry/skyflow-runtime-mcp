/**
 * Access tokens issued by this server's built-in Resource Authorization Server.
 *
 * After a valid ID-JAG is presented to the /token endpoint, the server issues
 * a short-lived HS256-signed JWT access token, audience-restricted to the MCP
 * resource identifier as required by the enterprise-managed-authorization
 * extension. The same server later verifies these tokens on /mcp requests,
 * so a shared symmetric secret (ENTERPRISE_AUTH_SIGNING_KEY) is sufficient
 * and keeps stateless/serverless deployments simple.
 */
import { SignJWT, jwtVerify, decodeJwt } from "jose";
import { randomUUID } from "node:crypto";
import type { EnterpriseAuthConfig } from "./config.js";

/** JWT typ header for issued access tokens (RFC 9068 style) */
export const ACCESS_TOKEN_TYP = "at+jwt";

/** Clock skew tolerance for exp/iat validation, in seconds */
const CLOCK_TOLERANCE_SECONDS = 60;

/** Identity claims carried by an enterprise access token */
export interface EnterpriseIdentity {
  /** Stable subject identifier from the enterprise IdP */
  subject: string;
  /** User email, when the IdP provided one */
  email?: string;
  /** Space-delimited scopes granted by the IdP policy */
  scope?: string;
  /** MCP client the grant was issued to */
  clientId?: string;
}

export interface IssuedAccessToken {
  accessToken: string;
  /** Lifetime in seconds */
  expiresIn: number;
  scope?: string;
}

function signingSecret(config: EnterpriseAuthConfig): Uint8Array {
  return new TextEncoder().encode(config.signingKey);
}

/**
 * Issue an enterprise access token for a validated ID-JAG.
 * The token is audience-restricted to the MCP resource identifier.
 */
export async function issueAccessToken(
  identity: EnterpriseIdentity,
  config: EnterpriseAuthConfig
): Promise<IssuedAccessToken> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    ...(identity.email && { email: identity.email }),
    // Preserve an empty scope claim ("" = no tools granted) — dropping it
    // would invert the IdP's deny-all into an unrestricted token.
    ...(identity.scope !== undefined && { scope: identity.scope }),
    ...(identity.clientId && { client_id: identity.clientId }),
  })
    .setProtectedHeader({ alg: "HS256", typ: ACCESS_TOKEN_TYP })
    .setIssuer(config.issuer)
    .setAudience(config.resource)
    .setSubject(identity.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + config.tokenTtlSeconds)
    .setJti(randomUUID());

  return {
    accessToken: await jwt.sign(signingSecret(config)),
    expiresIn: config.tokenTtlSeconds,
    scope: identity.scope,
  };
}

/**
 * Verify an enterprise access token presented on an /mcp request.
 * Checks signature, issuer, audience (MCP resource identifier), typ, and expiry.
 *
 * @throws jose errors when the token is invalid
 */
export async function verifyAccessToken(
  token: string,
  config: EnterpriseAuthConfig
): Promise<EnterpriseIdentity> {
  const { payload } = await jwtVerify(token, signingSecret(config), {
    issuer: config.issuer,
    audience: config.resource,
    typ: ACCESS_TOKEN_TYP,
    algorithms: ["HS256"],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Enterprise access token is missing a sub claim");
  }

  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
  };
}

/**
 * Cheap structural check: does this bearer value claim to be a token issued
 * by this server? Used in "optional" mode to decide whether to verify it as
 * an enterprise token or fall through to ordinary Skyflow credential handling.
 * Does NOT validate the signature — callers must still verifyAccessToken().
 */
export function looksLikeEnterpriseToken(
  token: string,
  config: EnterpriseAuthConfig
): boolean {
  try {
    return decodeJwt(token).iss === config.issuer;
  } catch {
    return false;
  }
}
