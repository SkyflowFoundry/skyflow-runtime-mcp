/**
 * Express middleware gating /mcp with enterprise-managed authorization.
 *
 * When enterprise auth is enabled, requests must present an access token
 * issued by this server's /token endpoint (obtained via the ID-JAG flow) in
 * the Authorization header. Skyflow vault credentials are then resolved from,
 * in order of precedence:
 *
 *   1. X-Skyflow-Authorization header (per-user Skyflow bearer token/API key)
 *   2. SKYFLOW_API_KEY environment variable (server-wide service credential)
 *   3. Existing fallbacks in authenticateBearer (apiKey query param, anonymous mode)
 *
 * When enterprise auth is disabled this middleware is a no-op.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  loadEnterpriseAuthConfig,
  EnterpriseAuthConfigError,
  type EnterpriseAuthConfig,
} from "../auth/config.js";
import {
  verifyAccessToken,
  looksLikeEnterpriseToken,
} from "../auth/accessTokens.js";
import { extractCredentials } from "./authenticateBearer.js";

/** Header for passing Skyflow credentials alongside an enterprise token */
export const SKYFLOW_AUTH_HEADER = "x-skyflow-authorization";

export interface EnterpriseAuthMiddlewareDeps {
  /** Environment source, defaults to process.env (injectable for tests) */
  env?: NodeJS.ProcessEnv;
}

/**
 * 401 response with the WWW-Authenticate challenge required by the MCP
 * authorization spec (RFC 9728 §5.1), pointing clients at the protected
 * resource metadata for discovery.
 */
function unauthorized(
  res: Response,
  config: EnterpriseAuthConfig,
  options: { error?: string; description?: string } = {}
): void {
  // Callers pass constants, but escape defensively anyway so a future
  // request-derived value cannot break out of the quoted header parameter.
  const headerParam = (value: string) => value.replace(/["\\\r\n]/g, "");
  const challengeParts: string[] = [];
  if (options.error) {
    challengeParts.push(`error="${headerParam(options.error)}"`);
  }
  if (options.description) {
    challengeParts.push(`error_description="${headerParam(options.description)}"`);
  }
  // RFC 9728 path-suffixed metadata URL for a resource with a path component
  // (e.g. .../oauth-protected-resource/mcp). The bare URL is also served.
  const resourcePath = new URL(config.resource).pathname;
  challengeParts.push(
    `resource_metadata="${config.issuer}/.well-known/oauth-protected-resource${
      resourcePath === "/" ? "" : resourcePath
    }"`
  );
  res.set("WWW-Authenticate", `Bearer ${challengeParts.join(", ")}`);
  // Body mirrors the RFC 6749 §5.2 shape used by /token so programmatic
  // clients get a machine-readable code, not just the header challenge.
  res.status(401).json({
    error: options.error || "unauthorized",
    error_description:
      options.description ||
      "Enterprise authorization required. Obtain an access token via the ID-JAG flow described in the protected resource metadata.",
  });
}

/**
 * Resolve Skyflow credentials for a request that passed enterprise auth.
 * Returns false (after sending a 401) when an X-Skyflow-Authorization header
 * is present but malformed.
 */
function resolveSkyflowCredentials(
  req: Request,
  res: Response,
  config: EnterpriseAuthConfig,
  env: NodeJS.ProcessEnv
): boolean {
  const skyflowHeader = req.headers[SKYFLOW_AUTH_HEADER];
  const headerValue = Array.isArray(skyflowHeader) ? skyflowHeader[0] : skyflowHeader;

  if (headerValue && headerValue.trim().length > 0) {
    // Accept the credential bare or Bearer-prefixed in any casing (RFC 7235
    // auth schemes are case-insensitive), tolerating surrounding whitespace.
    const trimmed = headerValue.trim();
    const value = /^bearer(\s|$)/i.test(trimmed)
      ? trimmed.replace(/^bearer\s*/i, "")
      : trimmed;
    const result = extractCredentials(
      value ? `Bearer ${value}` : undefined,
      undefined
    );
    if (!result.isPresent || !result.credentials) {
      unauthorized(res, config, {
        error: "invalid_request",
        description: "X-Skyflow-Authorization header is malformed",
      });
      return false;
    }
    // SECURITY: req.skyflowCredentials contains secrets — never log or serialize the request object.
    req.skyflowCredentials = result.credentials;
    req.isAnonymousMode = false;
    return true;
  }

  if (env.SKYFLOW_API_KEY) {
    // SECURITY: req.skyflowCredentials contains secrets — never log or serialize the request object.
    req.skyflowCredentials = { apiKey: env.SKYFLOW_API_KEY };
    req.isAnonymousMode = false;
    return true;
  }

  // Leave credentials unresolved: authenticateBearer will fall back to the
  // apiKey query parameter or anonymous mode. Deliberate trade-off: an
  // enterprise-authenticated user without Skyflow credentials degrades to
  // anonymous mode (clearly marked via anonymousMode:true in tool responses)
  // rather than being rejected. Deployments that don't want this should set
  // SKYFLOW_API_KEY or leave ANON_MODE_* unconfigured (yielding a 401).
  return true;
}

/**
 * Create the enterprise auth middleware for /mcp.
 *
 * required mode: every request must carry a valid enterprise access token.
 * optional mode: tokens issued by this server are verified and consumed;
 * anything else (Skyflow JWTs, API keys, no credentials) falls through to
 * the existing authentication chain unchanged.
 */
export function createEnterpriseAuthMiddleware(
  deps: EnterpriseAuthMiddlewareDeps = {}
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const env = deps.env ?? process.env;

    let config: EnterpriseAuthConfig | null;
    try {
      config = loadEnterpriseAuthConfig(env);
    } catch (error) {
      if (error instanceof EnterpriseAuthConfigError) {
        // Fail closed: a misconfigured deployment must not silently skip auth
        console.error("Enterprise auth configuration error:", error.message);
        return res.status(500).json({
          error: "server_error",
          error_description: "Enterprise-managed authorization is misconfigured",
        });
      }
      throw error;
    }

    if (!config) {
      return next(); // feature disabled — no behavior change
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7).trim()
      : undefined;

    if (!token) {
      if (config.mode === "optional") {
        return next();
      }
      return unauthorized(res, config);
    }

    // In optional mode, bearer values not issued by this server (Skyflow
    // JWTs, API keys) flow through to the ordinary credential chain.
    if (config.mode === "optional" && !looksLikeEnterpriseToken(token, config)) {
      return next();
    }

    try {
      req.enterpriseAuth = await verifyAccessToken(token, config);
    } catch {
      return unauthorized(res, config, {
        error: "invalid_token",
        description: "Enterprise access token is invalid or expired",
      });
    }

    // The Authorization header held the enterprise token, now consumed.
    // Remove it so authenticateBearer doesn't mistake it for Skyflow credentials.
    delete req.headers.authorization;

    if (!resolveSkyflowCredentials(req, res, config, env)) {
      return;
    }

    next();
  };
}
