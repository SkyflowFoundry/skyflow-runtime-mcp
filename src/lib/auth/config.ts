/**
 * Configuration for the Enterprise-Managed Authorization extension
 * (io.modelcontextprotocol/enterprise-managed-authorization).
 *
 * When enabled, this server acts as the "Resource Authorization Server" for
 * its own /mcp endpoint: it validates Identity Assertion JWT Authorization
 * Grants (ID-JAGs) issued by an enterprise IdP and issues audience-restricted
 * access tokens that gate access to /mcp.
 *
 * The feature is entirely opt-in via ENTERPRISE_AUTH_ENABLED. When disabled,
 * server behavior is unchanged.
 */

export type EnterpriseAuthMode = "required" | "optional";

export interface EnterpriseAuthConfig {
  /**
   * Issuer identifier of this server's built-in authorization server —
   * the public base URL of this deployment (e.g. https://mcp.example.com).
   * Used as the expected `aud` of incoming ID-JAGs (unless overridden by
   * idpAudience) and as the `iss` of issued access tokens.
   */
  issuer: string;
  /**
   * Resource identifier of the MCP endpoint per RFC 9728. Used to validate
   * the ID-JAG `resource` claim and as the `aud` of issued access tokens.
   */
  resource: string;
  /** Enterprise IdP issuer identifier — expected `iss` of incoming ID-JAGs. */
  idpIssuer: string;
  /**
   * Explicit JWKS URI for the IdP's signing keys. When omitted, the JWKS URI
   * is discovered from `{idpIssuer}/.well-known/openid-configuration`.
   */
  idpJwksUri?: string;
  /** Expected `aud` of incoming ID-JAGs. Defaults to `issuer`. */
  idpAudience: string;
  /** HS256 secret used to sign and verify issued access tokens. */
  signingKey: string;
  /** Allowlisted MCP client IDs. Empty array = any client_id is accepted. */
  allowedClientIds: string[];
  /** Lifetime of issued access tokens, in seconds. */
  tokenTtlSeconds: number;
  /**
   * required — every /mcp request must present an enterprise access token.
   * optional — enterprise access tokens are accepted, but requests carrying
   * ordinary Skyflow credentials (or none, for anonymous mode) still work.
   */
  mode: EnterpriseAuthMode;
}

export class EnterpriseAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnterpriseAuthConfigError";
  }
}

const MIN_SIGNING_KEY_LENGTH = 32;

function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function requireUrl(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new EnterpriseAuthConfigError(
      `${name} is required when ENTERPRISE_AUTH_ENABLED is true`
    );
  }
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EnterpriseAuthConfigError(`${name} must be a valid URL, got: ${trimmed}`);
  }
  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new EnterpriseAuthConfigError(
      `${name} must use https (http is only allowed for localhost), got: ${trimmed}`
    );
  }
  return stripTrailingSlash(trimmed);
}

/**
 * Load and validate enterprise auth configuration from environment variables.
 *
 * @returns null when the feature is disabled (ENTERPRISE_AUTH_ENABLED unset/false)
 * @throws EnterpriseAuthConfigError when enabled but misconfigured (fail closed)
 */
export function loadEnterpriseAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): EnterpriseAuthConfig | null {
  if (!isEnabled(env.ENTERPRISE_AUTH_ENABLED)) {
    return null;
  }

  const issuer = requireUrl("ENTERPRISE_AUTH_ISSUER", env.ENTERPRISE_AUTH_ISSUER);
  const idpIssuer = requireUrl("ENTERPRISE_IDP_ISSUER", env.ENTERPRISE_IDP_ISSUER);

  const signingKey = env.ENTERPRISE_AUTH_SIGNING_KEY;
  if (!signingKey || signingKey.length < MIN_SIGNING_KEY_LENGTH) {
    throw new EnterpriseAuthConfigError(
      `ENTERPRISE_AUTH_SIGNING_KEY is required and must be at least ${MIN_SIGNING_KEY_LENGTH} characters`
    );
  }

  const mode = (env.ENTERPRISE_AUTH_MODE || "required").trim().toLowerCase();
  if (mode !== "required" && mode !== "optional") {
    throw new EnterpriseAuthConfigError(
      `ENTERPRISE_AUTH_MODE must be "required" or "optional", got: ${mode}`
    );
  }

  // Short default: leaked bearer tokens stay usable until expiry, and
  // clients can re-exchange an ID-JAG without user interaction anyway.
  // Strict digits-only parse: parseInt would silently accept "900abc".
  const ttlRaw = (env.ENTERPRISE_TOKEN_TTL_SECONDS || "900").trim();
  const tokenTtlSeconds = /^\d+$/.test(ttlRaw) ? parseInt(ttlRaw, 10) : NaN;
  if (isNaN(tokenTtlSeconds) || tokenTtlSeconds <= 0) {
    throw new EnterpriseAuthConfigError(
      "ENTERPRISE_TOKEN_TTL_SECONDS must be a positive integer"
    );
  }

  const resource = env.ENTERPRISE_MCP_RESOURCE
    ? requireUrl("ENTERPRISE_MCP_RESOURCE", env.ENTERPRISE_MCP_RESOURCE)
    : `${issuer}/mcp`;

  const idpJwksUri = env.ENTERPRISE_IDP_JWKS_URI
    ? requireUrl("ENTERPRISE_IDP_JWKS_URI", env.ENTERPRISE_IDP_JWKS_URI)
    : undefined;

  const allowedClientIds = (env.ENTERPRISE_ALLOWED_CLIENT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return {
    issuer,
    resource,
    idpIssuer,
    idpJwksUri,
    idpAudience: env.ENTERPRISE_IDP_AUDIENCE?.trim() || issuer,
    signingKey,
    allowedClientIds,
    tokenTtlSeconds,
    mode,
  };
}
