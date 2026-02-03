import type { Request, Response, NextFunction } from "express";

export interface TokenExtractionResult {
  isPresent: boolean;
  token?: string;
  error?: string;
}

export interface CredentialsExtractionResult {
  isPresent: boolean;
  credentials?: { token: string } | { apiKey: string };
  error?: string;
}

/**
 * Check if a string looks like a JWT (JSON Web Token)
 * JWTs have 3 base64url-encoded parts separated by dots
 *
 * @param value - The string to check
 * @returns true if the string appears to be a JWT
 */
export function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3) {
    return false;
  }
  // Check that each part looks like base64url (alphanumeric, -, _)
  const base64urlRegex = /^[A-Za-z0-9_-]+$/;
  return parts.every((part) => part.length > 0 && base64urlRegex.test(part));
}

/**
 * Extract bearer token from Authorization header and check format
 * Pure function for easier testing
 * Note: This only validates format, not authenticity. Skyflow API validates the actual token.
 *
 * @param authHeader - The Authorization header value
 * @returns TokenExtractionResult with isPresent, optional token, and optional error
 *
 * @example
 * extractBearerToken("Bearer abc123") // => { isPresent: true, token: "abc123" }
 * extractBearerToken("Invalid") // => { isPresent: false, error: "..." }
 * extractBearerToken(undefined) // => { isPresent: false, error: "..." }
 */
export function extractBearerToken(
  authHeader: string | undefined
): TokenExtractionResult {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      isPresent: false,
      error: "Missing or invalid Authorization header",
    };
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix

  if (!token || token.trim().length === 0) {
    return {
      isPresent: false,
      error: "Bearer token is empty",
    };
  }

  return {
    isPresent: true,
    token,
  };
}

/**
 * Extract API key from query parameter and check format
 * Pure function for easier testing
 * Note: This only validates format, not authenticity. Skyflow API validates the actual key.
 *
 * @param apiKeyParam - The apiKey query parameter value
 * @returns TokenExtractionResult with isPresent, optional token (apiKey), and optional error
 *
 * @example
 * extractApiKey("my-api-key-123") // => { isPresent: true, token: "my-api-key-123" }
 * extractApiKey("") // => { isPresent: false, error: "..." }
 * extractApiKey(undefined) // => { isPresent: false, error: "..." }
 */
export function extractApiKey(
  apiKeyParam: string | undefined
): TokenExtractionResult {
  if (!apiKeyParam || typeof apiKeyParam !== "string") {
    return {
      isPresent: false,
      error: "Missing or invalid apiKey query parameter",
    };
  }

  const apiKey = apiKeyParam.trim();

  if (apiKey.length === 0) {
    return {
      isPresent: false,
      error: "API key is empty",
    };
  }

  return {
    isPresent: true,
    token: apiKey,
  };
}

/**
 * Extract credentials from either Authorization header (bearer token or API key) or query parameter (API key)
 * The Authorization header can contain either a JWT bearer token or an API key.
 * If the value looks like a JWT (3 dot-separated base64url parts), it's treated as a bearer token.
 * Otherwise, it's treated as an API key.
 * Falls back to apiKey query parameter if no Authorization header is provided.
 * Note: This only checks format/presence, not authenticity. Skyflow API validates the actual credentials.
 *
 * @param authHeader - The Authorization header value
 * @param apiKeyParam - The apiKey query parameter value
 * @returns CredentialsExtractionResult with credentials in Skyflow SDK format
 *
 * @example
 * // JWT bearer token in header
 * extractCredentials("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", undefined)
 * // => { isPresent: true, credentials: { token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." } }
 *
 * // API key in header (not a JWT)
 * extractCredentials("Bearer sky-abc123-def456", undefined)
 * // => { isPresent: true, credentials: { apiKey: "sky-abc123-def456" } }
 *
 * // API key in query parameter
 * extractCredentials(undefined, "my-api-key")
 * // => { isPresent: true, credentials: { apiKey: "my-api-key" } }
 *
 * extractCredentials(undefined, undefined)
 * // => { isPresent: false, error: "..." }
 */
export function extractCredentials(
  authHeader: string | undefined,
  apiKeyParam: string | undefined
): CredentialsExtractionResult {
  // Try Authorization header first
  const bearerResult = extractBearerToken(authHeader);
  if (bearerResult.isPresent && bearerResult.token) {
    // Determine if this is a JWT (bearer token) or an API key
    if (looksLikeJwt(bearerResult.token)) {
      return {
        isPresent: true,
        credentials: { token: bearerResult.token },
      };
    } else {
      // Not a JWT, treat as API key
      return {
        isPresent: true,
        credentials: { apiKey: bearerResult.token },
      };
    }
  }

  // Fallback to API key from query parameter
  const apiKeyResult = extractApiKey(apiKeyParam);
  if (apiKeyResult.isPresent && apiKeyResult.token) {
    return {
      isPresent: true,
      credentials: { apiKey: apiKeyResult.token },
    };
  }

  // Both failed
  return {
    isPresent: false,
    error: "Missing or invalid credentials. Provide either Authorization header with Bearer token/API key, or apiKey query parameter.",
  };
}

/**
 * Express middleware for credentials authentication
 * Supports both bearer token (from Authorization header) and API key (from query parameter)
 * Bearer token takes precedence if both are provided
 * Note: Only validates format/presence. Skyflow API validates authenticity when SDK is initialized.
 */
export function authenticateBearer(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Debug logging - indicate presence without logging sensitive values
  console.log("Auth Debug:", {
    authHeader: req.headers.authorization ? "present" : "missing",
    apiKeyQuery: req.query.apiKey ? "present" : "missing",
    vaultId: req.query.vaultId,
    vaultUrl: req.query.vaultUrl,
    path: req.path,
  });

  const result = extractCredentials(
    req.headers.authorization,
    req.query.apiKey as string | undefined
  );

  if (!result.isPresent) {
    // Check if anonymous mode is configured
    const anonApiKey = process.env.ANON_MODE_API_KEY;
    const anonVaultId = process.env.ANON_MODE_VAULT_ID;
    const anonVaultUrl = process.env.ANON_MODE_VAULT_URL;

    if (anonApiKey && anonVaultId && anonVaultUrl) {
      console.log("No credentials provided, entering anonymous mode");
      req.isAnonymousMode = true;
      req.skyflowCredentials = { apiKey: anonApiKey };
      req.anonVaultConfig = { vaultId: anonVaultId, vaultUrl: anonVaultUrl };
      return next();
    }

    // Anonymous mode not configured, return 401
    console.log("Credentials not found:", result.error);
    return res.status(401).json({ error: result.error });
  }

  req.isAnonymousMode = false;
  const credentialType = result.credentials && "token" in result.credentials
    ? "bearer token (JWT)"
    : "API key";
  console.log("Credentials found, type:", credentialType);
  req.skyflowCredentials = result.credentials;
  next();
}
