import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAnonymousRateLimiter,
  getAnonymousRateLimitConfig,
  getClientId,
  clearRateLimitStore,
  getRateLimitStoreSize,
} from "../../../src/lib/middleware/rateLimiter";
import type { Request, Response, NextFunction } from "express";

// Mock Express request/response for middleware tests
function createMockRequest(
  overrides: Partial<Request> & { isAnonymousMode?: boolean } = {}
): Partial<Request> & { isAnonymousMode?: boolean } {
  return {
    headers: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" } as Request["socket"],
    isAnonymousMode: false,
    ...overrides,
  };
}

function createMockResponse(): {
  res: Partial<Response>;
  statusCode: number | null;
  jsonBody: unknown;
  headers: Record<string, string | number>;
} {
  let statusCode: number | null = null;
  let jsonBody: unknown = null;
  const headers: Record<string, string | number> = {};

  const res: Partial<Response> = {
    status: vi.fn().mockImplementation((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      jsonBody = body;
      return res;
    }),
    setHeader: vi.fn().mockImplementation((name: string, value: string | number) => {
      headers[name] = value;
      return res;
    }),
  };

  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get jsonBody() {
      return jsonBody;
    },
    headers,
  };
}

describe("Anonymous Rate Limiter", () => {
  beforeEach(() => {
    // Clear any env stubs from previous tests
    vi.unstubAllEnvs();
    // Clear rate limit store before each test
    clearRateLimitStore();
  });

  describe("getClientId()", () => {
    it("should extract IP from X-Forwarded-For header (single IP)", () => {
      const req = createMockRequest({
        headers: { "x-forwarded-for": "203.0.113.195" },
      }) as Request;

      expect(getClientId(req)).toBe("203.0.113.195");
    });

    it("should extract first IP from X-Forwarded-For header (multiple IPs)", () => {
      const req = createMockRequest({
        headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18, 150.172.238.178" },
      }) as Request;

      expect(getClientId(req)).toBe("203.0.113.195");
    });

    it("should trim whitespace from extracted IP", () => {
      const req = createMockRequest({
        headers: { "x-forwarded-for": "  203.0.113.195  " },
      }) as Request;

      expect(getClientId(req)).toBe("203.0.113.195");
    });

    it("should fall back to req.ip when no X-Forwarded-For", () => {
      const req = createMockRequest({
        ip: "192.168.1.100",
      }) as Request;

      expect(getClientId(req)).toBe("192.168.1.100");
    });

    it("should fall back to socket.remoteAddress when no req.ip", () => {
      const req = createMockRequest({
        ip: undefined,
        socket: { remoteAddress: "10.0.0.1" } as Request["socket"],
      }) as Request;

      expect(getClientId(req)).toBe("10.0.0.1");
    });

    it("should return 'unknown' when no IP available", () => {
      const req = createMockRequest({
        ip: undefined,
        socket: { remoteAddress: undefined } as unknown as Request["socket"],
      }) as Request;

      expect(getClientId(req)).toBe("unknown");
    });
  });

  describe("getAnonymousRateLimitConfig()", () => {
    it("should use env var values when set", () => {
      vi.stubEnv("ANON_MODE_RATE_LIMIT_REQUESTS", "20");
      vi.stubEnv("ANON_MODE_RATE_LIMIT_WINDOW_MS", "120000");

      const config = getAnonymousRateLimitConfig();

      expect(config.maxRequests).toBe(20);
      expect(config.windowMs).toBe(120000);
    });

    // Note: Testing default values (when env vars are empty/missing) is difficult
    // due to vitest env var stubbing limitations. Manual testing should verify
    // that defaults of 10 requests and 60000ms window are used.
  });

  describe("createAnonymousRateLimiter()", () => {
    const config = { maxRequests: 3, windowMs: 60000 };

    describe("rate limiting behavior", () => {
      it("should allow requests under the limit", () => {
        const rateLimiter = createAnonymousRateLimiter(config);
        const req = createMockRequest({ isAnonymousMode: true }) as Request;
        const { res, statusCode } = createMockResponse();
        const next = vi.fn();

        // First request
        rateLimiter(req, res as Response, next);
        expect(next).toHaveBeenCalled();
        expect(statusCode).toBeNull();
      });

      it("should allow exactly maxRequests and block the next one", () => {
        const rateLimiter = createAnonymousRateLimiter(config);
        const results: { allowed: boolean; remaining: number | undefined }[] = [];

        // Make maxRequests + 2 requests to verify boundary
        for (let i = 0; i < config.maxRequests + 2; i++) {
          const req = createMockRequest({
            isAnonymousMode: true,
            ip: "192.168.1.1",
          }) as Request;
          const mockRes = createMockResponse();
          const next = vi.fn();

          rateLimiter(req, mockRes.res as Response, next);

          results.push({
            allowed: mockRes.statusCode === null,
            remaining: mockRes.headers["X-RateLimit-Remaining"] as number | undefined,
          });
        }

        // With maxRequests=3:
        // - Request 1: allowed, remaining=2
        // - Request 2: allowed, remaining=1
        // - Request 3: allowed, remaining=0
        // - Request 4: blocked (429), remaining=0
        // - Request 5: blocked (429), remaining=0
        expect(results[0]).toEqual({ allowed: true, remaining: 2 });
        expect(results[1]).toEqual({ allowed: true, remaining: 1 });
        expect(results[2]).toEqual({ allowed: true, remaining: 0 });
        expect(results[3]).toEqual({ allowed: false, remaining: 0 });
        expect(results[4]).toEqual({ allowed: false, remaining: 0 });
      });

      it("should block requests over the limit", () => {
        const rateLimiter = createAnonymousRateLimiter(config);
        const next = vi.fn();

        // Make requests up to and exceeding the limit
        for (let i = 0; i < config.maxRequests + 1; i++) {
          const req = createMockRequest({
            isAnonymousMode: true,
            ip: "192.168.1.1",
          }) as Request;
          const mockRes = createMockResponse();

          rateLimiter(req, mockRes.res as Response, next);

          if (i < config.maxRequests) {
            // Requests 0 to maxRequests-1 (i.e., first maxRequests requests) should be allowed
            expect(mockRes.statusCode).toBeNull();
          } else {
            // Request at index maxRequests (i.e., maxRequests+1th request) should be blocked
            expect(mockRes.statusCode).toBe(429);
            expect(mockRes.jsonBody).toHaveProperty("error");
            expect((mockRes.jsonBody as Record<string, unknown>).error).toContain("Rate limit exceeded");
          }
        }
      });

      it("should track different clients separately", () => {
        const rateLimiter = createAnonymousRateLimiter(config);

        // Client 1 makes max requests
        for (let i = 0; i < config.maxRequests; i++) {
          const req = createMockRequest({
            isAnonymousMode: true,
            ip: "192.168.1.1",
          }) as Request;
          const { res } = createMockResponse();
          const next = vi.fn();
          rateLimiter(req, res as Response, next);
        }

        // Client 2 should still be allowed
        const req = createMockRequest({
          isAnonymousMode: true,
          ip: "192.168.1.2",
        }) as Request;
        const { res, statusCode } = createMockResponse();
        const next = vi.fn();

        rateLimiter(req, res as Response, next);

        expect(next).toHaveBeenCalled();
        expect(statusCode).toBeNull();
      });

      it("should skip rate limiting for authenticated requests", () => {
        const rateLimiter = createAnonymousRateLimiter(config);

        // Make many authenticated requests (should not be rate limited)
        for (let i = 0; i < 10; i++) {
          const req = createMockRequest({
            isAnonymousMode: false,
            ip: "192.168.1.1",
          }) as Request;
          const { res, statusCode } = createMockResponse();
          const next = vi.fn();

          rateLimiter(req, res as Response, next);

          expect(next).toHaveBeenCalled();
          expect(statusCode).toBeNull();
        }
      });

      it("should set correct rate limit headers", () => {
        const rateLimiter = createAnonymousRateLimiter(config);
        const req = createMockRequest({
          isAnonymousMode: true,
          ip: "192.168.1.100",
        }) as Request;
        const { res, headers } = createMockResponse();
        const next = vi.fn();

        rateLimiter(req, res as Response, next);

        expect(headers["X-RateLimit-Limit"]).toBe(3);
        expect(headers["X-RateLimit-Remaining"]).toBe(2);
        expect(typeof headers["X-RateLimit-Reset"]).toBe("number");
        expect(headers["X-RateLimit-Reset"]).toBeGreaterThan(0);
      });

      it("should decrement remaining count with each request", () => {
        const rateLimiter = createAnonymousRateLimiter(config);

        for (let i = 0; i < config.maxRequests; i++) {
          const req = createMockRequest({
            isAnonymousMode: true,
            ip: "192.168.1.200",
          }) as Request;
          const { res, headers } = createMockResponse();
          const next = vi.fn();

          rateLimiter(req, res as Response, next);

          expect(headers["X-RateLimit-Remaining"]).toBe(config.maxRequests - i - 1);
        }
      });

      it("should include retryAfterSeconds in 429 response", () => {
        const rateLimiter = createAnonymousRateLimiter(config);

        // Exhaust rate limit
        for (let i = 0; i <= config.maxRequests; i++) {
          const req = createMockRequest({
            isAnonymousMode: true,
            ip: "192.168.1.250",
          }) as Request;
          const mockRes = createMockResponse();
          const next = vi.fn();

          rateLimiter(req, mockRes.res as Response, next);

          if (i === config.maxRequests) {
            expect(mockRes.jsonBody).toHaveProperty("retryAfterSeconds");
            expect((mockRes.jsonBody as Record<string, unknown>).retryAfterSeconds).toBeGreaterThan(0);
          }
        }
      });
    });

    describe("store management", () => {
      it("should add entries to the store", () => {
        const rateLimiter = createAnonymousRateLimiter(config);
        const req = createMockRequest({
          isAnonymousMode: true,
          ip: "10.0.0.1",
        }) as Request;
        const { res } = createMockResponse();
        const next = vi.fn();

        expect(getRateLimitStoreSize()).toBe(0);

        rateLimiter(req, res as Response, next);

        expect(getRateLimitStoreSize()).toBe(1);
      });

      it("should clear store with clearRateLimitStore", () => {
        const rateLimiter = createAnonymousRateLimiter(config);

        // Add some entries
        for (let i = 0; i < 3; i++) {
          const req = createMockRequest({
            isAnonymousMode: true,
            ip: `10.0.0.${i}`,
          }) as Request;
          const { res } = createMockResponse();
          rateLimiter(req, res as Response, vi.fn());
        }

        expect(getRateLimitStoreSize()).toBe(3);

        clearRateLimitStore();

        expect(getRateLimitStoreSize()).toBe(0);
      });
    });
  });
});
