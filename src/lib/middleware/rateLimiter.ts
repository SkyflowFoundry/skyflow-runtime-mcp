import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

// In-memory store for rate limiting (suitable for single-instance deployment)
// For production multi-instance deployment, consider Redis
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Get client identifier for rate limiting
 * Uses IP address, falling back to a combination of headers
 */
export function getClientId(req: Request): string {
  // Prefer X-Forwarded-For for proxied requests (Vercel, etc.)
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded.split(",")[0];
    return ips.trim();
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
const cleanupInterval = setInterval(cleanupExpiredEntries, 60000);

// Allow cleanup interval to not prevent process exit
cleanupInterval.unref();

/**
 * Create rate limiter middleware for anonymous mode
 * Only applies rate limiting to requests where req.isAnonymousMode is true
 */
export function createAnonymousRateLimiter(config: RateLimiterConfig) {
  return function anonymousRateLimiter(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    // Only apply rate limiting to anonymous mode requests
    if (!req.isAnonymousMode) {
      return next();
    }

    const clientId = getClientId(req);
    const key = `anon:${clientId}`;
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
      console.log(`Rate limit exceeded for anonymous client: ${clientId}`);
      res.setHeader("X-RateLimit-Limit", config.maxRequests);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("X-RateLimit-Reset", resetSeconds);
      return res.status(429).json({
        error: "Rate limit exceeded for anonymous mode",
        message:
          "You have exceeded the rate limit for anonymous mode. " +
          "Please try again later or configure your Skyflow credentials for unlimited access.",
        retryAfterSeconds: resetSeconds,
        helpUrl: "https://docs.skyflow.com/",
      });
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
 * Get rate limit configuration from environment variables
 */
export function getAnonymousRateLimitConfig(): RateLimiterConfig {
  return {
    maxRequests: parseInt(process.env.ANON_MODE_RATE_LIMIT_REQUESTS || "10", 10),
    windowMs: parseInt(process.env.ANON_MODE_RATE_LIMIT_WINDOW_MS || "60000", 10),
  };
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
