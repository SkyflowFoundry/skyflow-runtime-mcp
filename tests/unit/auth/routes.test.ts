import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import type { Request, Response } from "express";
import {
  createAuthServerMetadataHandler,
  createProtectedResourceMetadataHandler,
  createTokenHandler,
  createEnterpriseAuthRouter,
} from "../../../src/lib/auth/routes";
import {
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT_TYPE,
  resetIdJagCaches,
} from "../../../src/lib/auth/idJag";
import { verifyAccessToken } from "../../../src/lib/auth/accessTokens";
import {
  createTestIdp,
  enabledEnv,
  testConfig,
  TEST_ISSUER,
  TEST_RESOURCE,
  type TestIdp,
} from "./helpers";

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return { headers: {}, query: {}, body: {}, ...overrides } as Request;
}

interface MockResponse {
  res: Response;
  statusCode: number;
  jsonBody: any;
  headers: Record<string, string>;
}

function createMockResponse(): MockResponse {
  const captured: MockResponse = {
    res: undefined as unknown as Response,
    statusCode: 200,
    jsonBody: null,
    headers: {},
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
  captured.res = res;
  return captured;
}

const disabledEnv = {} as NodeJS.ProcessEnv;
const brokenEnv = { ENTERPRISE_AUTH_ENABLED: "true" } as NodeJS.ProcessEnv;

describe("authorization server metadata endpoint", () => {
  it("returns 404 when enterprise auth is disabled", () => {
    const mock = createMockResponse();
    createAuthServerMetadataHandler({ env: disabledEnv })(
      createMockRequest(),
      mock.res,
      vi.fn()
    );
    expect(mock.statusCode).toBe(404);
  });

  it("returns 500 when enterprise auth is misconfigured", () => {
    const mock = createMockResponse();
    createAuthServerMetadataHandler({ env: brokenEnv })(
      createMockRequest(),
      mock.res,
      vi.fn()
    );
    expect(mock.statusCode).toBe(500);
    expect(mock.jsonBody.error).toBe("server_error");
  });

  it("advertises the ID-JAG grant profile per the extension spec", () => {
    const mock = createMockResponse();
    createAuthServerMetadataHandler({ env: enabledEnv() })(
      createMockRequest(),
      mock.res,
      vi.fn()
    );
    expect(mock.statusCode).toBe(200);
    expect(mock.jsonBody).toMatchObject({
      issuer: TEST_ISSUER,
      token_endpoint: `${TEST_ISSUER}/token`,
      grant_types_supported: [JWT_BEARER_GRANT_TYPE],
      authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
});

describe("protected resource metadata endpoint", () => {
  it("returns 404 when enterprise auth is disabled", () => {
    const mock = createMockResponse();
    createProtectedResourceMetadataHandler({ env: disabledEnv })(
      createMockRequest(),
      mock.res,
      vi.fn()
    );
    expect(mock.statusCode).toBe(404);
  });

  it("points clients at this server's authorization server", () => {
    const mock = createMockResponse();
    createProtectedResourceMetadataHandler({ env: enabledEnv() })(
      createMockRequest(),
      mock.res,
      vi.fn()
    );
    expect(mock.statusCode).toBe(200);
    expect(mock.jsonBody).toMatchObject({
      resource: TEST_RESOURCE,
      authorization_servers: [TEST_ISSUER],
      bearer_methods_supported: ["header"],
    });
  });
});

describe("createEnterpriseAuthRouter()", () => {
  it("does not crash at creation on invalid rate-limit env when the feature is disabled", () => {
    expect(() =>
      createEnterpriseAuthRouter({
        env: {
          ENTERPRISE_TOKEN_RATE_LIMIT_REQUESTS: "not-a-number",
        } as NodeJS.ProcessEnv,
      })
    ).not.toThrow();
  });
});

describe("token endpoint", () => {
  let idp: TestIdp;

  beforeAll(async () => {
    idp = await createTestIdp();
  });

  beforeEach(() => {
    resetIdJagCaches();
  });

  function tokenHandler(env = enabledEnv()) {
    return createTokenHandler({ env, keyResolver: idp.keyResolver });
  }

  async function postToken(body: Record<string, unknown>, env?: NodeJS.ProcessEnv) {
    const mock = createMockResponse();
    await tokenHandler(env)(
      createMockRequest({ body } as Partial<Request>),
      mock.res,
      vi.fn()
    );
    return mock;
  }

  it("returns 404 when enterprise auth is disabled", async () => {
    const mock = await postToken({}, disabledEnv);
    expect(mock.statusCode).toBe(404);
  });

  it("rejects unsupported grant types", async () => {
    const mock = await postToken({
      grant_type: "authorization_code",
      code: "abc",
    });
    expect(mock.statusCode).toBe(400);
    expect(mock.jsonBody.error).toBe("unsupported_grant_type");
  });

  it("rejects a missing assertion", async () => {
    const mock = await postToken({ grant_type: JWT_BEARER_GRANT_TYPE });
    expect(mock.statusCode).toBe(400);
    expect(mock.jsonBody.error).toBe("invalid_request");
  });

  it("rejects an invalid assertion with invalid_grant", async () => {
    const mock = await postToken({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion: "not-a-jwt",
    });
    expect(mock.statusCode).toBe(400);
    expect(mock.jsonBody.error).toBe("invalid_grant");
  });

  it("propagates unauthorized_client for non-allowlisted clients", async () => {
    const assertion = await idp.signIdJag({ client_id: "rogue-client" });
    const mock = await postToken(
      { grant_type: JWT_BEARER_GRANT_TYPE, assertion },
      enabledEnv({ ENTERPRISE_ALLOWED_CLIENT_IDS: "mcp-client-1" })
    );
    expect(mock.statusCode).toBe(400);
    expect(mock.jsonBody.error).toBe("unauthorized_client");
  });

  it("exchanges a valid ID-JAG for an enterprise access token", async () => {
    const assertion = await idp.signIdJag();
    const mock = await postToken({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
    });

    expect(mock.statusCode).toBe(200);
    expect(mock.jsonBody.token_type).toBe("Bearer");
    expect(mock.jsonBody.expires_in).toBe(3600);
    expect(mock.jsonBody.scope).toBe("de-identify re-identify");
    expect(mock.headers["cache-control"]).toBe("no-store");

    // The issued token must verify against this server's own config
    const identity = await verifyAccessToken(
      mock.jsonBody.access_token,
      testConfig()
    );
    expect(identity.subject).toBe("okta-user-123");
    expect(identity.email).toBe("employee@example.com");
    expect(identity.clientId).toBe("mcp-client-1");
  });

  it("rejects reuse of the same ID-JAG (replay)", async () => {
    const assertion = await idp.signIdJag();
    const first = await postToken({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
    });
    expect(first.statusCode).toBe(200);

    const second = await postToken({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
    });
    expect(second.statusCode).toBe(400);
    expect(second.jsonBody.error).toBe("invalid_grant");
  });
});
