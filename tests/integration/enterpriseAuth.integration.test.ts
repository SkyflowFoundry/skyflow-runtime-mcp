/**
 * Integration test for the enterprise-managed authorization HTTP flow,
 * exercising the real Express app (src/server.ts) over the wire:
 *
 *   mock enterprise IdP (OIDC discovery + JWKS)
 *     → GET /.well-known/* discovery metadata
 *     → POST /token (ID-JAG exchange, RFC 7523 jwt-bearer)
 *     → POST /mcp gated by the issued token
 *     → tool-level scope enforcement
 *
 * This locks in the middleware ordering and header handling in server.ts
 * that unit tests can't see (enterprise auth → authenticateBearer → rate
 * limiter, Authorization header consumption, router-before-json-parser).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey, type JWK } from "jose";
import http from "node:http";
import type { AddressInfo } from "node:net";

const SIGNING_KEY = "integration-test-signing-key-32-chars!";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

let idpServer: http.Server;
let appServer: http.Server;
let idpIssuer: string;
let baseUrl: string;
let privateKey: CryptoKey;
let jtiCounter = 0;

async function signIdJag(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: idpIssuer,
    aud: baseUrl,
    sub: "okta-user-42",
    email: "employee@example.com",
    resource: `${baseUrl}/mcp`,
    client_id: "integration-client",
    scope: "de-identify re-identify",
    jti: `integration-${++jtiCounter}-${Date.now()}`,
    iat: now,
    exp: now + 300,
    ...overrides,
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "integration-key", typ: "oauth-id-jag+jwt" })
    .sign(privateKey);
}

async function exchangeToken(assertion: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_BEARER, assertion }),
  });
  return { status: res.status, body: await res.json() };
}

async function callMcp(
  body: Record<string, unknown>,
  accessToken?: string
): Promise<{ status: number; body: any; wwwAuthenticate: string | null }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    wwwAuthenticate: res.headers.get("www-authenticate"),
  };
}

beforeAll(async () => {
  // Mock enterprise IdP: OIDC discovery + JWKS over localhost HTTP
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const jwk: JWK = await exportJWK(keys.publicKey);
  jwk.kid = "integration-key";
  jwk.alg = "RS256";

  idpServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer: idpIssuer, jwks_uri: `${idpIssuer}/jwks` }));
    } else if (req.url === "/jwks") {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => idpServer.listen(0, resolve));
  idpIssuer = `http://localhost:${(idpServer.address() as AddressInfo).port}`;

  // Enterprise auth env must be in place before importing the app; the
  // issuer is corrected to the real port after listen (config is read
  // per request, so this is safe).
  process.env.ENTERPRISE_AUTH_ENABLED = "true";
  process.env.ENTERPRISE_AUTH_ISSUER = "http://localhost:9";
  process.env.ENTERPRISE_IDP_ISSUER = idpIssuer;
  process.env.ENTERPRISE_AUTH_SIGNING_KEY = SIGNING_KEY;
  process.env.VAULT_ID = "integration-vault";
  process.env.VAULT_URL = "https://abc123.vault.skyflowapis.com";
  process.env.SKYFLOW_API_KEY = "sky-integration-dummy-key";
  delete process.env.ENTERPRISE_AUTH_MODE;

  const { default: app } = await import("../../src/server.js");
  appServer = app.listen(0);
  await new Promise((resolve) => appServer.on("listening", resolve));
  baseUrl = `http://localhost:${(appServer.address() as AddressInfo).port}`;
  process.env.ENTERPRISE_AUTH_ISSUER = baseUrl;
}, 30000);

afterAll(async () => {
  appServer?.close();
  idpServer?.close();
  for (const key of [
    "ENTERPRISE_AUTH_ENABLED",
    "ENTERPRISE_AUTH_ISSUER",
    "ENTERPRISE_IDP_ISSUER",
    "ENTERPRISE_AUTH_SIGNING_KEY",
    "ENTERPRISE_AUTH_MODE",
    "VAULT_ID",
    "VAULT_URL",
    "SKYFLOW_API_KEY",
  ]) {
    delete process.env[key];
  }
});

describe("enterprise auth HTTP flow (integration)", () => {
  it("serves discovery metadata advertising the ID-JAG grant profile", async () => {
    const asMeta = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`).then((r) =>
      r.json()
    );
    expect(asMeta.issuer).toBe(baseUrl);
    expect(asMeta.token_endpoint).toBe(`${baseUrl}/token`);
    expect(asMeta.authorization_grant_profiles_supported).toContain(
      "urn:ietf:params:oauth:grant-profile:id-jag"
    );

    const prm = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`).then((r) =>
      r.json()
    );
    expect(prm.resource).toBe(`${baseUrl}/mcp`);
    expect(prm.authorization_servers).toEqual([baseUrl]);
  });

  it("rejects /mcp without a token, advertising the resource metadata", async () => {
    const res = await callMcp({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(res.status).toBe(401);
    expect(res.wwwAuthenticate).toContain(
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`
    );
    expect(res.body.error).toBe("unauthorized");
  });

  it("exchanges an ID-JAG for a token that unlocks /mcp; replay is rejected", async () => {
    const assertion = await signIdJag();
    const first = await exchangeToken(assertion);
    expect(first.status).toBe(200);
    expect(first.body.token_type).toBe("Bearer");

    const tools = await callMcp(
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
      first.body.access_token
    );
    expect(tools.status).toBe(200);
    const names = tools.body?.result?.tools?.map((t: { name: string }) => t.name);
    expect(names).toContain("de-identify");
    expect(names).toContain("re-identify");

    const replay = await exchangeToken(assertion);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });

  it("rejects tampered tokens on /mcp", async () => {
    const { body } = await exchangeToken(await signIdJag());
    const res = await callMcp(
      { jsonrpc: "2.0", method: "tools/list", id: 3 },
      `${body.access_token}tampered`
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("enforces tool scopes from the granted token", async () => {
    const { body } = await exchangeToken(await signIdJag({ scope: "de-identify" }));
    expect(body.scope).toBe("de-identify");

    const denied = await callMcp(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "re-identify", arguments: { inputString: "[EMAIL_ADDRESS_1]" } },
        id: 4,
      },
      body.access_token
    );
    expect(denied.status).toBe(200);
    expect(denied.body?.result?.isError).toBe(true);
    expect(denied.body?.result?.structuredContent?.error).toBe("insufficient_scope");
  });

  it("treats an empty scope claim as deny-all, not unrestricted", async () => {
    const { status, body } = await exchangeToken(await signIdJag({ scope: "" }));
    expect(status).toBe(200);
    expect(body.scope).toBe("");

    const denied = await callMcp(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "de-identify", arguments: { inputString: "test" } },
        id: 5,
      },
      body.access_token
    );
    expect(denied.body?.result?.isError).toBe(true);
    expect(denied.body?.result?.structuredContent?.error).toBe("insufficient_scope");
  });

  it("ignores placeholder vault params for enterprise requests with env vault config", async () => {
    // An enterprise client whose URL template left ${...} placeholders
    // unsubstituted must use the server-side vault config, not demote to
    // anonymous mode or fail
    const { body } = await exchangeToken(await signIdJag());
    const params = new URLSearchParams({
      vaultId: "${SKYFLOW_VAULT_ID}",
      vaultUrl: "${SKYFLOW_VAULT_URL}",
    });
    const res = await fetch(`${baseUrl}/mcp?${params}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${body.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 8 }),
    });
    expect(res.status).toBe(200);
    const listBody = await res.json();
    expect(listBody?.result?.tools?.length).toBeGreaterThan(0);
  });

  it("rejects placeholder vault params when per-user credentials are supplied", async () => {
    // Per-user credentials must not be paired with the server's vault, and
    // enterprise requests never demote to the anonymous vault: broken client
    // template + X-Skyflow-Authorization is a clear 400
    const { body } = await exchangeToken(await signIdJag());
    const params = new URLSearchParams({
      vaultId: "${SKYFLOW_VAULT_ID}",
      vaultUrl: "${SKYFLOW_VAULT_URL}",
    });
    const res = await fetch(`${baseUrl}/mcp?${params}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${body.access_token}`,
        "x-skyflow-authorization": "Bearer sky-per-user-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 10 }),
    });
    expect(res.status).toBe(400);
    const errBody = await res.json();
    expect(errBody.error).toContain("unsubstituted placeholders");
  });

  it("returns 401 when enterprise auth passes but no Skyflow credentials resolve", async () => {
    // Without SKYFLOW_API_KEY, X-Skyflow-Authorization, apiKey param, or
    // anonymous mode, the documented hard-failure path is a credentials 401.
    const { body } = await exchangeToken(await signIdJag());
    delete process.env.SKYFLOW_API_KEY;
    try {
      const res = await callMcp(
        { jsonrpc: "2.0", method: "tools/list", id: 7 },
        body.access_token
      );
      expect(res.status).toBe(401);
      // The failure comes from Skyflow credential resolution, not the
      // enterprise token (which was valid and consumed)
      expect(res.wwwAuthenticate).toBeNull();
      expect(res.body.error).toBe("missing_skyflow_credentials");
    } finally {
      process.env.SKYFLOW_API_KEY = "sky-integration-dummy-key";
    }
  });

  it("honors the apiKey query parameter in required mode (no SKYFLOW_API_KEY)", async () => {
    // Locks in the handoff: the enterprise middleware leaves credentials
    // unresolved and authenticateBearer consumes the query parameter
    const { body } = await exchangeToken(await signIdJag());
    delete process.env.SKYFLOW_API_KEY;
    try {
      const res = await fetch(`${baseUrl}/mcp?apiKey=sky-param-key`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${body.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 9 }),
      });
      expect(res.status).toBe(200);
    } finally {
      process.env.SKYFLOW_API_KEY = "sky-integration-dummy-key";
    }
  });

  it("lets legacy Skyflow credentials fall through in optional mode", async () => {
    process.env.ENTERPRISE_AUTH_MODE = "optional";
    try {
      const res = await callMcp(
        { jsonrpc: "2.0", method: "tools/list", id: 6 },
        "sky-legacy-api-key"
      );
      expect(res.status).toBe(200);
    } finally {
      delete process.env.ENTERPRISE_AUTH_MODE;
    }
  });
});
