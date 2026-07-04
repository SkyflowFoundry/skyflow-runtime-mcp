import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

/** Interval for cleaning up expired rate limit entries (1 minute) */
const CLEANUP_INTERVAL_MS = 60_000;

// In-memory store for rate limiting (suitable for single-instance deployment)
// WARNING: This Map can grow with unique client IPs. For high-traffic production
// deployments, consider using Redis to avoid memory issues and support multi-instance.
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Get client identifier for rate limiting
 * Uses IP address, falling back to a combination of headers
 */
export function getClientId(req: Request): string {
  // Use X-Forwarded-For for proxied requests (Vercel, etc.)
  // SECURITY: Use the rightmost IP - the one that connected to our trusted proxy.
  // Left-most IPs are client-controlled and can be spoofed to bypass rate limiting.
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    // Normalize both forms — a repeated header (array) and a comma-delimited
    // list — so the rightmost entry is always a single address.
    const entries = (Array.isArray(forwarded) ? forwarded : [forwarded]).flatMap(
      (value) => value.split(",")
    );
    const rightmost = entries[entries.length - 1]?.trim();
    if (rightmost) {
      return rightmost;
    }
  }

  // Fall back to direct IP
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * Clean up expired entries periodically
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}

// Run cleanup every minute
const cleanupInterval = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);

// Allow cleanup interval to not prevent process exit
cleanupInterval.unref();

interface RateLimiterOptions {
  /** Namespace for store keys so different limiters don't collide */
  keyPrefix: string;
  /** Return true to bypass rate limiting for this request */
  skip?: (req: Request) => boolean;
  /** Body for the 429 response */
  errorBody: (retryAfterSeconds: number) => Record<string, unknown>;
}

/**
 * Create a generic per-client-IP rate limiter middleware.
 * Shared implementation behind the anonymous-mode and token-endpoint limiters.
 */
function createIpRateLimiter(
  config: RateLimiterConfig,
  options: RateLimiterOptions
) {
  return function ipRateLimiter(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    if (options.skip?.(req)) {
      return next();
    }

    const clientId = getClientId(req);
    const key = `${options.keyPrefix}:${clientId}`;
    const now = Date.now();

    let entry = rateLimitStore.get(key);

    if (!entry || now > entry.resetTime) {
      // Create new entry or reset expired one
      // count represents "requests made so far" (before this one)
      entry = {
        count: 0,
        resetTime: now + config.windowMs,
      };
      rateLimitStore.set(key, entry);
    }

    const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

    // Check if this request would exceed the limit BEFORE incrementing
    if (entry.count >= config.maxRequests) {
      res.setHeader("X-RateLimit-Limit", config.maxRequests);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("X-RateLimit-Reset", resetSeconds);
      return res.status(429).json(options.errorBody(resetSeconds));
    }

    // Request allowed - increment count AFTER the check
    entry.count++;

    // Set rate limit headers for successful request
    const remaining = config.maxRequests - entry.count;
    res.setHeader("X-RateLimit-Limit", config.maxRequests);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetSeconds);

    next();
  };
}

/**
 * Create rate limiter middleware for anonymous mode
 * Only applies rate limiting to requests where req.isAnonymousMode is true
 */
export function createAnonymousRateLimiter(config: RateLimiterConfig) {
  return createIpRateLimiter(config, {
    keyPrefix: "anon",
    skip: (req) => !req.isAnonymousMode,
    errorBody: (retryAfterSeconds) => ({
      error: "Rate limit exceeded for anonymous mode",
      message:
        "You have exceeded the rate limit for anonymous mode. " +
        "Please try again later or configure your Skyflow credentials for unlimited access.",
      retryAfterSeconds,
      helpUrl: "https://docs.skyflow.com/",
    }),
  });
}

/**
 * Create rate limiter middleware for the enterprise auth /token endpoint.
 * The endpoint is unauthenticated by design (clients present ID-JAGs), so a
 * per-IP limit bounds how fast a caller can drive signature verifications.
 * Errors follow the RFC 6749 §5.2 body shape used by the endpoint itself.
 */
export function createTokenEndpointRateLimiter(config: RateLimiterConfig) {
  return createIpRateLimiter(config, {
    keyPrefix: "token",
    errorBody: (retryAfterSeconds) => ({
      error: "rate_limit_exceeded",
      error_description: `Too many token requests. Try again in ${retryAfterSeconds} seconds.`,
    }),
  });
}

/**
 * Get token endpoint rate limit configuration from environment variables
 * @throws Error if environment variables contain invalid values
 */
export function getTokenEndpointRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env
): RateLimiterConfig {
  const maxRequests = parseInt(
    env.ENTERPRISE_TOKEN_RATE_LIMIT_REQUESTS || "30",
    10
  );
  const windowMs = parseInt(
    env.ENTERPRISE_TOKEN_RATE_LIMIT_WINDOW_MS || "60000",
    10
  );

  if (isNaN(maxRequests) || maxRequests <= 0) {
    throw new Error(
      "Invalid ENTERPRISE_TOKEN_RATE_LIMIT_REQUESTS: must be a positive integer"
    );
  }
  if (isNaN(windowMs) || windowMs <= 0) {
    throw new Error(
      "Invalid ENTERPRISE_TOKEN_RATE_LIMIT_WINDOW_MS: must be a positive integer"
    );
  }

  return { maxRequests, windowMs };
}

/**
 * Get rate limit configuration from environment variables
 * @throws Error if environment variables contain invalid values
 */
export function getAnonymousRateLimitConfig(): RateLimiterConfig {
  const maxRequests = parseInt(process.env.ANON_MODE_RATE_LIMIT_REQUESTS || "10", 10);
  const windowMs = parseInt(process.env.ANON_MODE_RATE_LIMIT_WINDOW_MS || "60000", 10);

  if (isNaN(maxRequests) || maxRequests <= 0) {
    throw new Error("Invalid ANON_MODE_RATE_LIMIT_REQUESTS: must be a positive integer");
  }
  if (isNaN(windowMs) || windowMs <= 0) {
    throw new Error("Invalid ANON_MODE_RATE_LIMIT_WINDOW_MS: must be a positive integer");
  }

  return { maxRequests, windowMs };
}

/**
 * Clear the rate limit store (useful for testing)
 */
export function clearRateLimitStore(): void {
  rateLimitStore.clear();
}

/**
 * Get the current rate limit store size (useful for testing)
 */
export function getRateLimitStoreSize(): number {
  return rateLimitStore.size;
}
