import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import {
  createEnterpriseAuthMiddleware,
  SKYFLOW_AUTH_HEADER,
} from "../../../src/lib/middleware/enterpriseAuth";
import { issueAccessToken } from "../../../src/lib/auth/accessTokens";
import {
  enabledEnv,
  testConfig,
  TEST_ISSUER,
} from "../auth/helpers";

const identity = {
  subject: "okta-user-123",
  email: "employee@example.com",
  scope: "de-identify",
  clientId: "mcp-client-1",
};

// Structurally valid Skyflow JWT (not issued by the enterprise AS)
const SKYFLOW_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"; // gitleaks:allow

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return { headers: {}, query: {}, ...overrides } as Request;
}

function createMockResponse() {
  const captured = {
    statusCode: 200,
    jsonBody: null as any,
    headers: {} as Record<string, string>,
  };
  const res = {
    status: vi.fn().mockImplementation((code: number) => {
      captured.statusCode = code;
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      captured.jsonBody = body;
      return res;
    }),
    set: vi.fn().mockImplementation((name: string, value: string) => {
      captured.headers[name.toLowerCase()] = value;
      return res;
    }),
  } as unknown as Response;
  return { res, captured };
}

async function runMiddleware(env: NodeJS.ProcessEnv, req: Request) {
  const { res, captured } = createMockResponse();
  const next = vi.fn();
  await createEnterpriseAuthMiddleware({ env })(req, res, next);
  return { next, captured };
}

async function validToken(): Promise<string> {
  const issued = await issueAccessToken(identity, testConfig());
  return issued.accessToken;
}

describe("enterprise auth middleware", () => {
  describe("disabled", () => {
    it("is a no-op when enterprise auth is not enabled", async () => {
      const req = createMockRequest({
        headers: { authorization: "Bearer some-skyflow-key" },
      });
      const { next } = await runMiddleware({} as NodeJS.ProcessEnv, req);
      expect(next).toHaveBeenCalled();
      expect(req.headers.authorization).toBe("Bearer some-skyflow-key");
      expect(req.enterpriseAuth).toBeUndefined();
    });

    it("fails closed (500) when enabled but misconfigured", async () => {
      const req = createMockRequest();
      const { next, captured } = await runMiddleware(
        { ENTERPRISE_AUTH_ENABLED: "true" } as NodeJS.ProcessEnv,
        req
      );
      expect(next).not.toHaveBeenCalled();
      expect(captured.statusCode).toBe(500);
    });
  });

  describe("required mode", () => {
    it("rejects requests without a token, advertising resource metadata", async () => {
      const req = createMockRequest();
      const { next, captured } = await runMiddleware(enabledEnv(), req);
      expect(next).not.toHaveBeenCalled();
      expect(captured.statusCode).toBe(401);
      expect(captured.headers["www-authenticate"]).toContain(
        `resource_metadata="${TEST_ISSUER}/.well-known/oauth-protected-resource"`
      );
      // Body follows the RFC 6749 §5.2 shape for programmatic clients
      expect(captured.jsonBody.error).toBe("unauthorized");
      expect(captured.jsonBody.error_description).toBeTruthy();
    });

    it("rejects Skyflow credentials that are not enterprise tokens", async () => {
      const req = createMockRequest({
        headers: { authorization: `Bearer ${SKYFLOW_JWT}` },
      });
      const { next, captured } = await runMiddleware(enabledEnv(), req);
      expect(next).not.toHaveBeenCalled();
      expect(captured.statusCode).toBe(401);
      expect(captured.headers["www-authenticate"]).toContain('error="invalid_token"');
      expect(captured.jsonBody.error).toBe("invalid_token");
    });

    it("rejects expired enterprise tokens", async () => {
      const issued = await issueAccessToken(
        identity,
        testConfig({ tokenTtlSeconds: -120 })
      );
      const req = createMockRequest({
        headers: { authorization: `Bearer ${issued.accessToken}` },
      });
      const { next, captured } = await runMiddleware(enabledEnv(), req);
      expect(next).not.toHaveBeenCalled();
      expect(captured.statusCode).toBe(401);
    });

    it("accepts a valid token and records the enterprise identity", async () => {
      const req = createMockRequest({
        headers: { authorization: `Bearer ${await validToken()}` },
      });
      const { next } = await runMiddleware(enabledEnv(), req);
      expect(next).toHaveBeenCalled();
      expect(req.enterpriseAuth).toEqual(identity);
      // The enterprise token must not leak downstream as a Skyflow credential
      expect(req.headers.authorization).toBeUndefined();
    });
  });

  describe("Skyflow credential resolution after enterprise auth", () => {
    it("uses a JWT from X-Skyflow-Authorization as a bearer token", async () => {
      const req = createMockRequest({
        headers: {
          authorization: `Bearer ${await validToken()}`,
          [SKYFLOW_AUTH_HEADER]: `Bearer ${SKYFLOW_JWT}`,
        },
      });
      const { next } = await runMiddleware(enabledEnv(), req);
      expect(next).toHaveBeenCalled();
      expect(req.skyflowCredentials).toEqual({ token: SKYFLOW_JWT });
      expect(req.isAnonymousMode).toBe(false);
    });

    it("accepts a raw API key in X-Skyflow-Authorization without Bearer prefix", async () => {
      const req = createMockRequest({
        headers: {
          authorization: `Bearer ${await validToken()}`,
          [SKYFLOW_AUTH_HEADER]: "sky-abc123-def456", // gitleaks:allow
        },
      });
      const { next } = await runMiddleware(enabledEnv(), req);
      expect(next).toHaveBeenCalled();
      expect(req.skyflowCredentials).toEqual({ apiKey: "sky-abc123-def456" }); // gitleaks:allow
    });

    it("rejects a malformed X-Skyflow-Authorization header", async () => {
      const req = createMockRequest({
        headers: {
          authorization: `Bearer ${await validToken()}`,
          [SKYFLOW_AUTH_HEADER]: "Bearer ",
        },
      });
      const { next, captured } = await runMiddleware(enabledEnv(), req);
      expect(next).not.toHaveBeenCalled();
      expect(captured.statusCode).toBe(401);
    });

    it("falls back to the SKYFLOW_API_KEY service credential", async () => {
      const req = createMockRequest({
        headers: { authorization: `Bearer ${await validToken()}` },
      });
      const env = enabledEnv({ SKYFLOW_API_KEY: "service-api-key" });
      const { next } = await runMiddleware(env, req);
      expect(next).toHaveBeenCalled();
      expect(req.skyflowCredentials).toEqual({ apiKey: "service-api-key" });
      expect(req.isAnonymousMode).toBe(false);
    });

    it("leaves credentials unresolved for downstream fallbacks when none provided", async () => {
      const req = createMockRequest({
        headers: { authorization: `Bearer ${await validToken()}` },
      });
      const { next } = await runMiddleware(enabledEnv(), req);
      expect(next).toHaveBeenCalled();
      expect(req.skyflowCredentials).toBeUndefined();
    });

    it("prefers X-Skyflow-Authorization over SKYFLOW_API_KEY", async () => {
      const req = createMockRequest({
        headers: {
          authorization: `Bearer ${await validToken()}`,
          [SKYFLOW_AUTH_HEADER]: "per-user-key",
        },
      });
      const env = enabledEnv({ SKYFLOW_API_KEY: "service-api-key" });
      const { next } = await runMiddleware(env, req);
      expect(next).toHaveBeenCalled();
      expect(req.skyflowCredentials).toEqual({ apiKey: "per-user-key" });
    });
  });

  describe("optional mode", () => {
    const optionalEnv = () => enabledEnv({ ENTERPRISE_AUTH_MODE: "optional" });

    it("lets requests without credentials through unchanged", async () => {
      const req = createMockRequest();
      const { next } = await runMiddleware(optionalEnv(), req);
      expect(next).toHaveBeenCalled();
      expect(req.enterpriseAuth).toBeUndefined();
    });

    it("lets Skyflow JWTs from other issuers fall through", async () => {
      const req = createMockRequest({
        headers: { authorization: `Bearer ${SKYFLOW_JWT}` },
      });
      const { next } = await runMiddleware(optionalEnv(), req);
      expect(next).toHaveBeenCalled();
      expect(req.headers.authorization).toBe(`Bearer ${SKYFLOW_JWT}`);
      expect(req.enterpriseAuth).toBeUndefined();
    });

    it("lets Skyflow API keys fall through", async () => {
      const req = createMockRequest({
        headers: { authorization: "Bearer sky-abc123" },
      });
      const { next } = await runMiddleware(optionalEnv(), req);
      expect(next).toHaveBeenCalled();
      expect(req.headers.authorization).toBe("Bearer sky-abc123");
    });

    it("verifies and consumes tokens issued by this server", async () => {
      const req = createMockRequest({
        headers: { authorization: `Bearer ${await validToken()}` },
      });
      const { next } = await runMiddleware(optionalEnv(), req);
      expect(next).toHaveBeenCalled();
      expect(req.enterpriseAuth).toEqual(identity);
      expect(req.headers.authorization).toBeUndefined();
    });

    it("still rejects invalid tokens that claim this server as issuer", async () => {
      const issued = await issueAccessToken(
        identity,
        testConfig({ signingKey: "wrong-signing-key-that-is-32-chars-x" }) // gitleaks:allow
      );
      const req = createMockRequest({
        headers: { authorization: `Bearer ${issued.accessToken}` },
      });
      const { next, captured } = await runMiddleware(optionalEnv(), req);
      expect(next).not.toHaveBeenCalled();
      expect(captured.statusCode).toBe(401);
    });
  });
});
