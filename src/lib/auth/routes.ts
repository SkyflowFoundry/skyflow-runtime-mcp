/**
 * HTTP endpoints for the built-in Resource Authorization Server:
 *
 * - GET /.well-known/oauth-authorization-server        (RFC 8414 metadata)
 * - GET /.well-known/oauth-protected-resource[/mcp]    (RFC 9728 metadata)
 * - POST /token                                        (RFC 7523 jwt-bearer grant)
 *
 * All endpoints return 404 when enterprise auth is disabled, so they have no
 * effect on existing deployments.
 */
import express, { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import type { JWTVerifyGetKey } from "jose";
import {
  loadEnterpriseAuthConfig,
  EnterpriseAuthConfigError,
  type EnterpriseAuthConfig,
} from "./config.js";
import {
  validateIdJag,
  IdJagValidationError,
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT_TYPE,
} from "./idJag.js";
import { issueAccessToken } from "./accessTokens.js";
import {
  createTokenEndpointRateLimiter,
  getTokenEndpointRateLimitConfig,
} from "../middleware/rateLimiter.js";

export interface EnterpriseAuthRouteDeps {
  /** Environment source, defaults to process.env (injectable for tests) */
  env?: NodeJS.ProcessEnv;
  /** Override for the IdP JWKS key resolver (injectable for tests) */
  keyResolver?: JWTVerifyGetKey;
}

/**
 * Resolve config for a request, translating outcomes to HTTP:
 * disabled → 404, misconfigured → 500, otherwise returns the config.
 */
function configForRequest(
  res: Response,
  env: NodeJS.ProcessEnv
): EnterpriseAuthConfig | null {
  let config: EnterpriseAuthConfig | null;
  try {
    config = loadEnterpriseAuthConfig(env);
  } catch (error) {
    if (error instanceof EnterpriseAuthConfigError) {
      console.error("Enterprise auth configuration error:", error.message);
      res.status(500).json({
        error: "server_error",
        error_description: "Enterprise-managed authorization is misconfigured",
      });
      return null;
    }
    throw error;
  }
  if (!config) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return config;
}

/** RFC 8414 authorization server metadata handler */
export function createAuthServerMetadataHandler(
  deps: EnterpriseAuthRouteDeps = {}
): RequestHandler {
  return (req: Request, res: Response) => {
    const config = configForRequest(res, deps.env ?? process.env);
    if (!config) return;
    res.json({
      issuer: config.issuer,
      token_endpoint: `${config.issuer}/token`,
      grant_types_supported: [JWT_BEARER_GRANT_TYPE],
      // Advertises support for the enterprise-managed-authorization extension
      authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
      token_endpoint_auth_methods_supported: ["none"],
      response_types_supported: [],
    });
  };
}

/** RFC 9728 protected resource metadata handler */
export function createProtectedResourceMetadataHandler(
  deps: EnterpriseAuthRouteDeps = {}
): RequestHandler {
  return (req: Request, res: Response) => {
    const config = configForRequest(res, deps.env ?? process.env);
    if (!config) return;
    res.json({
      resource: config.resource,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      resource_name: "Skyflow Runtime MCP Server",
    });
  };
}

/**
 * Token endpoint handler: exchanges a valid ID-JAG (presented via the RFC 7523
 * jwt-bearer grant) for an enterprise access token. Errors follow Section 5.2
 * of RFC 6749.
 */
export function createTokenHandler(
  deps: EnterpriseAuthRouteDeps = {}
): RequestHandler {
  return async (req: Request, res: Response) => {
    const config = configForRequest(res, deps.env ?? process.env);
    if (!config) return;

    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");

    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = body.grant_type;
    if (grantType !== JWT_BEARER_GRANT_TYPE) {
      return res.status(400).json({
        error: "unsupported_grant_type",
        error_description: `Only ${JWT_BEARER_GRANT_TYPE} is supported`,
      });
    }

    const assertion = body.assertion;
    if (typeof assertion !== "string" || assertion.length === 0) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Missing assertion parameter",
      });
    }

    try {
      const claims = await validateIdJag(assertion, config, deps.keyResolver);
      const issued = await issueAccessToken(claims, config);
      return res.json({
        token_type: "Bearer",
        access_token: issued.accessToken,
        expires_in: issued.expiresIn,
        // Included even when empty: "" means the IdP granted no tool scopes,
        // which is different from omitting the claim (unrestricted).
        ...(issued.scope !== undefined && { scope: issued.scope }),
      });
    } catch (error) {
      if (error instanceof IdJagValidationError) {
        return res.status(400).json({
          error: error.oauthError,
          error_description: error.message,
        });
      }
      // JWKS/discovery failures and other unexpected errors
      console.error(
        "Token endpoint error:",
        error instanceof Error ? error.message : "unknown error"
      );
      return res.status(500).json({
        error: "server_error",
        error_description: "Failed to process the authorization grant",
      });
    }
  };
}

/**
 * Router exposing the authorization server endpoints. Safe to mount
 * unconditionally — every endpoint 404s when enterprise auth is disabled.
 */
export function createEnterpriseAuthRouter(
  deps: EnterpriseAuthRouteDeps = {}
): Router {
  const router = Router();

  router.get(
    "/.well-known/oauth-authorization-server",
    createAuthServerMetadataHandler(deps)
  );
  // RFC 9728 allows path-suffixed metadata URLs for resources with a path
  // component (our resource identifier ends in /mcp), so serve both.
  router.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    createProtectedResourceMetadataHandler(deps)
  );
  router.post(
    "/token",
    createLazyTokenRateLimiter(deps),
    express.urlencoded({ extended: false, limit: "100kb" }),
    createTokenHandler(deps)
  );

  return router;
}

/**
 * Rate limiter for /token that defers reading ENTERPRISE_TOKEN_RATE_LIMIT_*
 * until enterprise auth is known-enabled, so invalid values can't crash
 * startup (or change /token's 404) for deployments with the feature disabled.
 * With the feature enabled, an invalid rate-limit config fails closed (500).
 */
function createLazyTokenRateLimiter(
  deps: EnterpriseAuthRouteDeps
): RequestHandler {
  let limiter: RequestHandler | undefined;
  return (req, res, next) => {
    const env = deps.env ?? process.env;
    let enabled: boolean;
    try {
      enabled = loadEnterpriseAuthConfig(env) !== null;
    } catch {
      enabled = true; // enabled but misconfigured — let the handler 500
    }
    if (!enabled) {
      return next(); // handler responds 404 without touching limiter config
    }
    if (!limiter) {
      try {
        limiter = createTokenEndpointRateLimiter(
          getTokenEndpointRateLimitConfig(env)
        );
      } catch (error) {
        console.error(
          "Invalid token endpoint rate limit configuration:",
          error instanceof Error ? error.message : "unknown error"
        );
        return res.status(500).json({
          error: "server_error",
          error_description: "Enterprise-managed authorization is misconfigured",
        });
      }
    }
    return limiter(req, res, next);
  };
}
