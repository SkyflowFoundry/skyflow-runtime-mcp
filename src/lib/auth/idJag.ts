/**
 * Identity Assertion JWT Authorization Grant (ID-JAG) validation.
 *
 * Implements the Resource Authorization Server side of the MCP
 * Enterprise-Managed Authorization extension, which profiles
 * draft-ietf-oauth-identity-assertion-authz-grant:
 * the enterprise IdP issues an ID-JAG (a JWT with typ "oauth-id-jag+jwt"),
 * and this server validates it before issuing its own access token.
 */
import {
  jwtVerify,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
} from "jose";
import type { EnterpriseAuthConfig } from "./config.js";

/** JWT typ header required on ID-JAGs */
export const ID_JAG_TYP = "oauth-id-jag+jwt";
/** Grant profile URN advertised in authorization server metadata */
export const ID_JAG_GRANT_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";
/** Grant type used to exchange an ID-JAG for an access token (RFC 7523) */
export const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Asymmetric signature algorithms accepted on ID-JAGs */
const ALLOWED_ID_JAG_ALGORITHMS = [
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
  "EdDSA",
];

/** Clock skew tolerance for exp/iat validation, in seconds */
const CLOCK_TOLERANCE_SECONDS = 60;

export type OAuthTokenErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type";

/**
 * Validation failure carrying the OAuth 2.0 token error code to return
 * per Section 5.2 of RFC 6749.
 */
export class IdJagValidationError extends Error {
  constructor(
    public readonly oauthError: OAuthTokenErrorCode,
    message: string
  ) {
    super(message);
    this.name = "IdJagValidationError";
  }
}

/** Claims extracted from a validated ID-JAG */
export interface IdJagClaims {
  /** Stable subject identifier of the enterprise user */
  subject: string;
  /** User email, when the IdP includes it (useful for account linking) */
  email?: string;
  /** Space-delimited scopes granted by the IdP policy */
  scope?: string;
  /** MCP client the IdP issued the grant to */
  clientId?: string;
  /** Unique token identifier (used for replay detection) */
  jti: string;
}

// ---------------------------------------------------------------------------
// IdP JWKS resolution (cached per process instance)
// ---------------------------------------------------------------------------

const discoveredJwksUris = new Map<string, string>();
let cachedRemoteJwks: { uri: string; resolver: JWTVerifyGetKey } | null = null;

/**
 * Discover the IdP's JWKS URI from its OIDC discovery document.
 * Results are cached for the lifetime of the process.
 */
async function discoverJwksUri(idpIssuer: string): Promise<string> {
  const cached = discoveredJwksUris.get(idpIssuer);
  if (cached) return cached;

  const discoveryUrl = `${idpIssuer}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(discoveryUrl);
  } catch (error) {
    throw new Error(
      `Failed to reach IdP discovery endpoint ${discoveryUrl}: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
  if (!response.ok) {
    throw new Error(
      `IdP discovery endpoint ${discoveryUrl} returned HTTP ${response.status}`
    );
  }
  const metadata = (await response.json()) as { jwks_uri?: unknown };
  if (typeof metadata.jwks_uri !== "string" || metadata.jwks_uri.length === 0) {
    throw new Error(`IdP discovery document at ${discoveryUrl} has no jwks_uri`);
  }

  discoveredJwksUris.set(idpIssuer, metadata.jwks_uri);
  return metadata.jwks_uri;
}

/**
 * Get a jose key resolver for the enterprise IdP's signing keys.
 * Uses ENTERPRISE_IDP_JWKS_URI when set, otherwise OIDC discovery.
 * The remote JWKS is cached and refreshed by jose as needed.
 */
export async function getIdpKeyResolver(
  config: EnterpriseAuthConfig
): Promise<JWTVerifyGetKey> {
  const uri = config.idpJwksUri ?? (await discoverJwksUri(config.idpIssuer));
  if (!cachedRemoteJwks || cachedRemoteJwks.uri !== uri) {
    cachedRemoteJwks = { uri, resolver: createRemoteJWKSet(new URL(uri)) };
  }
  return cachedRemoteJwks.resolver;
}

/** Clear cached discovery/JWKS state (useful for testing) */
export function resetIdJagCaches(): void {
  discoveredJwksUris.clear();
  cachedRemoteJwks = null;
  seenJtis.clear();
}

// ---------------------------------------------------------------------------
// Replay detection (best effort, per process instance)
// ---------------------------------------------------------------------------

// In-memory jti cache. On serverless/multi-instance deployments this is
// best-effort only: each instance tracks its own set. ID-JAGs are short-lived
// (typically 5 minutes), which bounds the replay window regardless.
const seenJtis = new Map<string, number>();

function isReplayedJti(jti: string, expiresAtMs: number): boolean {
  const now = Date.now();
  for (const [key, expiry] of seenJtis.entries()) {
    if (now > expiry) {
      seenJtis.delete(key);
    }
  }
  if (seenJtis.has(jti)) {
    return true;
  }
  seenJtis.set(jti, expiresAtMs);
  return false;
}

// ---------------------------------------------------------------------------
// ID-JAG validation
// ---------------------------------------------------------------------------

/**
 * Validate an ID-JAG presented to the token endpoint as an RFC 7523
 * authorization grant, per the enterprise-managed-authorization extension:
 *
 * - `typ` header must be "oauth-id-jag+jwt"
 * - signature must verify against the enterprise IdP's JWKS
 * - `iss` must be the configured IdP issuer
 * - `aud` must be this authorization server's issuer identifier
 * - `exp`/`iat` must be valid (with small clock tolerance)
 * - `resource`, when present, must match this server's MCP resource identifier
 * - `client_id` must be allowlisted when an allowlist is configured
 * - `jti` must be present and not previously seen (best-effort replay check)
 *
 * @param assertion - The ID-JAG JWT from the token request's `assertion` param
 * @param config - Enterprise auth configuration
 * @param keyResolver - Override for the IdP key resolver (used in tests)
 * @throws IdJagValidationError with the appropriate OAuth error code
 */
export async function validateIdJag(
  assertion: string,
  config: EnterpriseAuthConfig,
  keyResolver?: JWTVerifyGetKey
): Promise<IdJagClaims> {
  let resolver: JWTVerifyGetKey;
  try {
    resolver = keyResolver ?? (await getIdpKeyResolver(config));
  } catch (error) {
    // IdP discovery failure is a server-side problem, not a bad grant
    throw error instanceof Error ? error : new Error("IdP key resolution failed");
  }

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(assertion, resolver, {
      issuer: config.idpIssuer,
      audience: config.idpAudience,
      typ: ID_JAG_TYP,
      algorithms: ALLOWED_ID_JAG_ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = result.payload;
  } catch (error) {
    throw new IdJagValidationError(
      "invalid_grant",
      `ID-JAG validation failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }

  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new IdJagValidationError("invalid_grant", "ID-JAG is missing a sub claim");
  }

  // The resource claim, when present, MUST be this MCP server's resource
  // identifier — the issued access token is audience-restricted to it.
  const resource = payload.resource;
  if (resource !== undefined) {
    const matches = Array.isArray(resource)
      ? resource.includes(config.resource)
      : resource === config.resource;
    if (!matches) {
      throw new IdJagValidationError(
        "invalid_grant",
        `ID-JAG resource claim does not match this MCP server (expected ${config.resource})`
      );
    }
  }

  const clientId = typeof payload.client_id === "string" ? payload.client_id : undefined;
  if (config.allowedClientIds.length > 0) {
    if (!clientId || !config.allowedClientIds.includes(clientId)) {
      throw new IdJagValidationError(
        "unauthorized_client",
        "ID-JAG client_id is not authorized for this MCP server"
      );
    }
  }

  const jti = payload.jti;
  if (typeof jti !== "string" || jti.length === 0) {
    throw new IdJagValidationError("invalid_grant", "ID-JAG is missing a jti claim");
  }
  const expiresAtMs =
    typeof payload.exp === "number"
      ? payload.exp * 1000 + CLOCK_TOLERANCE_SECONDS * 1000
      : Date.now() + 5 * 60 * 1000;
  if (isReplayedJti(`${config.idpIssuer}:${jti}`, expiresAtMs)) {
    throw new IdJagValidationError("invalid_grant", "ID-JAG has already been used");
  }

  return {
    subject,
    email: typeof payload.email === "string" ? payload.email : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    clientId,
    jti,
  };
}
