# Enterprise-Managed Authorization

This server supports the MCP [Enterprise-Managed Authorization extension](https://modelcontextprotocol.io/extensions/enterprise-managed-authorization) (`io.modelcontextprotocol/enterprise-managed-authorization`), which lets an organization control access to the MCP server centrally through its identity provider (IdP) — Okta, Azure AD/Entra, or any OIDC-compliant IdP that can issue Identity Assertion JWT Authorization Grants (ID-JAGs).

The feature is **entirely opt-in**. When `ENTERPRISE_AUTH_ENABLED` is not set, server behavior is unchanged.

## How it works

The extension profiles [draft-ietf-oauth-identity-assertion-authz-grant](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/). When enabled, this server plays two of the spec's roles at once:

- **MCP Resource Server** — the `/mcp` endpoint, now gated by enterprise access tokens
- **Resource Authorization Server** — a built-in, stateless authorization server that validates ID-JAGs from your IdP and issues the access tokens

```
MCP Client                Enterprise IdP           This server
    |                          |                        |
    |--- SSO login ----------->|                        |
    |<-- ID Token -------------|                        |
    |                          |                        |
    |--- Token Exchange ------>|  (RFC 8693,            |
    |    (ID Token in,         |   policy evaluated     |
    |     ID-JAG out)          |   by IdP admin rules)  |
    |<-- ID-JAG ---------------|                        |
    |                          |                        |
    |--- POST /token (RFC 7523 jwt-bearer grant) ------>|
    |<-- enterprise access token ----------------------|
    |                          |                        |
    |--- POST /mcp with Authorization: Bearer <token> ->|
    |<-- MCP responses ---------------------------------|
```

The IdP decides *who* may use *which MCP client* against this server (group membership, conditional access, etc.). This server validates the resulting ID-JAG — signature (against the IdP's JWKS), issuer, audience, expiry, `typ: oauth-id-jag+jwt` header, `resource` claim, optional client allowlist, and best-effort `jti` replay detection — and then issues its own short-lived HS256 access token, audience-restricted to the MCP resource identifier as the spec requires.

## Endpoints added when enabled

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata. Advertises `authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"]`, which is how clients discover that this server supports the extension. |
| `GET /.well-known/oauth-protected-resource` (also `/mcp`-suffixed) | RFC 9728 protected resource metadata pointing at the built-in authorization server. |
| `POST /token` | Token endpoint. Accepts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with the ID-JAG as `assertion`; returns a Bearer access token. |

All three return 404 when the feature is disabled. Unauthenticated `/mcp` requests receive `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` challenge so spec-compliant clients can discover the flow.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ENTERPRISE_AUTH_ENABLED` | yes (`true`/`1`) | Master switch. Everything below is ignored unless enabled. |
| `ENTERPRISE_AUTH_ISSUER` | yes | Public base URL of this deployment (e.g. `https://mcp.example.com`). Used as the authorization server issuer identifier: the expected `aud` of ID-JAGs and the `iss` of issued access tokens. |
| `ENTERPRISE_IDP_ISSUER` | yes | Your IdP's issuer identifier (e.g. `https://yourorg.okta.com`). Expected `iss` of ID-JAGs. |
| `ENTERPRISE_AUTH_SIGNING_KEY` | yes | Secret (≥32 chars) used to sign/verify issued access tokens. Generate with `openssl rand -hex 32`. Must be identical across instances of the same deployment. |
| `ENTERPRISE_AUTH_MODE` | no | `required` (default): every `/mcp` request must carry an enterprise access token. `optional`: enterprise tokens are accepted, but direct Skyflow credentials and anonymous mode keep working. |
| `ENTERPRISE_IDP_JWKS_URI` | no | Explicit JWKS URI for the IdP's signing keys. When omitted, discovered from `{ENTERPRISE_IDP_ISSUER}/.well-known/openid-configuration`. |
| `ENTERPRISE_IDP_AUDIENCE` | no | Expected `aud` of ID-JAGs, if your IdP is configured with an audience other than `ENTERPRISE_AUTH_ISSUER`. |
| `ENTERPRISE_MCP_RESOURCE` | no | RFC 9728 resource identifier of the MCP endpoint. Defaults to `{ENTERPRISE_AUTH_ISSUER}/mcp`. Issued tokens are audience-restricted to this value. |
| `ENTERPRISE_ALLOWED_CLIENT_IDS` | no | Comma-separated allowlist of MCP client IDs (matched against the ID-JAG `client_id` claim). Empty = any client the IdP authorizes. |
| `ENTERPRISE_TOKEN_TTL_SECONDS` | no | Lifetime of issued access tokens. Default 900 (15 minutes) — clients re-exchange their ID-JAG without user interaction, so short lifetimes cost nothing and bound the exposure of a leaked token. |
| `ENTERPRISE_TOKEN_RATE_LIMIT_REQUESTS` | no | Max `/token` requests per client IP per window. Default 30. |
| `ENTERPRISE_TOKEN_RATE_LIMIT_WINDOW_MS` | no | `/token` rate limit window in milliseconds. Default 60000. |
| `SKYFLOW_API_KEY` | no | Server-side Skyflow service credential used for vault access on requests authenticated via enterprise auth (see below). |

Misconfiguration fails **closed**: if the feature is enabled but required variables are missing or invalid, `/mcp` returns 500 rather than silently skipping authorization.

## Scope enforcement

Scopes let IdP administrators control *which tools* a user or client may invoke, not just whether they can connect. The IdP grants scopes in the ID-JAG (per admin policy), the `/token` endpoint copies them into the access token, and the server enforces them per tool call:

- **Scope values name tools**: grant `de-identify` and/or `re-identify`.
- **A token with a `scope` claim** may only invoke the named tools; other tools return an `insufficient_scope` error result.
- **A token without a `scope` claim** is unrestricted — access is gated at the connection level only.
- **`tools/list` is not filtered by scope**: every tool stays visible to every connection (the tool registry is shared across requests); enforcement happens at invocation time with a clear `insufficient_scope` error.

For example, an Okta policy granting the `de-identify` scope to the "support" group lets those users redact text but never restore original PII, while the "compliance" group gets both scopes.

> **Known assumption to verify against your IdP:** scope values must match tool names *exactly* — configure your IdP to issue the literal scopes `de-identify` and `re-identify`. Some IdPs default to namespaced or audience-qualified scope strings (e.g. `mcp:de-identify`); those will not match and will deny the tool. If your IdP cannot issue bare scope names, omit the scope grant entirely (unrestricted) until a mapping layer is added. This is one of the items to validate when wiring up a live Okta org.

## Skyflow vault credentials under enterprise auth

The `Authorization` header now carries the enterprise access token, so Skyflow vault credentials are resolved separately, in order of precedence:

1. **`X-Skyflow-Authorization` header** — a per-user Skyflow bearer token or API key (with or without a `Bearer ` prefix), for deployments where each user has their own vault credentials.
2. **`SKYFLOW_API_KEY` environment variable** — a server-wide service credential. The typical setup for enterprise deployments: employees authenticate with SSO only and never handle Skyflow credentials.
3. **Existing fallbacks** — the `apiKey` query parameter, then anonymous mode if configured.

Note the last fallback: an enterprise-authenticated request with no Skyflow credentials at all degrades to [anonymous mode](../README.md#anonymous-mode-try-before-you-buy) when `ANON_MODE_*` is configured (responses are clearly marked with `anonymousMode: true`), and receives a 401 otherwise. This is deliberate — it gives SSO users a working demo path before vault credentials are provisioned. Deployments that want enterprise users to always hit a real vault should set `SKYFLOW_API_KEY`; deployments that want a hard failure instead should leave `ANON_MODE_*` unset.

## Deployment scenario 1: Skyflow-hosted endpoint + Skyflow Okta

For Skyflow's own hosted MCP endpoint, gate access by Skyflow's Okta org while keeping existing consumers working:

```bash
ENTERPRISE_AUTH_ENABLED=true
ENTERPRISE_AUTH_MODE=optional            # existing Skyflow-credential and anonymous users unaffected
ENTERPRISE_AUTH_ISSUER=https://mcp.skyflow.com
ENTERPRISE_IDP_ISSUER=https://skyflow.okta.com
ENTERPRISE_AUTH_SIGNING_KEY=<openssl rand -hex 32>
```

In Okta, this uses [Cross App Access](https://developer.okta.com/docs/guides/cross-app-access-overview/) (Okta's implementation of the ID-JAG token exchange):

1. Register the MCP client application (e.g. Claude, an internal agent platform) for SSO in the Okta org.
2. Register this MCP server as a connected resource with issuer `https://mcp.skyflow.com` and resource `https://mcp.skyflow.com/mcp`.
3. Define the access policy (which groups/users may connect which clients).

Employees signed in to an enterprise-enabled MCP client then connect without any per-server authorization prompt; Okta policy decides access. Once per-user vault credential mapping is available, clients can supply per-user credentials via `X-Skyflow-Authorization`; until then, requests fall through to the `apiKey` query parameter or anonymous mode exactly as before.

> **Note:** As of this writing there are no Skyflow Okta test credentials provisioned, so this scenario is implemented and unit/smoke-tested against a simulated IdP, but not yet validated against the production Okta org.

## Deployment scenario 2: self-hosted with your own IdP

Customers deploying this server themselves can require SSO through their IdP of choice in front of vault access:

```bash
ENTERPRISE_AUTH_ENABLED=true
# ENTERPRISE_AUTH_MODE defaults to "required": no enterprise token, no access
ENTERPRISE_AUTH_ISSUER=https://mcp.internal.example.com
ENTERPRISE_IDP_ISSUER=https://login.example.com
ENTERPRISE_AUTH_SIGNING_KEY=<openssl rand -hex 32>
ENTERPRISE_ALLOWED_CLIENT_IDS=approved-client-1,approved-client-2

# Employees never see Skyflow credentials; the server holds one service key:
SKYFLOW_API_KEY=<skyflow service api key>
VAULT_ID=<vault id>
VAULT_URL=https://<cluster>.vault.skyflowapis.com
```

Any OIDC IdP that supports the ID-JAG token exchange works; the server discovers its keys via standard OIDC discovery (or set `ENTERPRISE_IDP_JWKS_URI` explicitly).

## Trying the flow with curl

Simulating what an enterprise-enabled MCP client does after SSO (you need a real ID-JAG from your IdP):

```bash
# 1. Discover the authorization server
curl https://mcp.example.com/.well-known/oauth-protected-resource/mcp

# 2. Exchange the ID-JAG for an access token
curl -X POST https://mcp.example.com/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  -d "assertion=<id-jag-from-your-idp>"

# 3. Call the MCP endpoint with the issued token
curl -X POST https://mcp.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <access-token-from-step-2>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Security notes

- **Fail closed**: enabled-but-misconfigured deployments reject `/mcp` requests instead of bypassing auth.
- **Audience restriction**: issued access tokens carry `aud = ENTERPRISE_MCP_RESOURCE` and `typ: at+jwt`; they are only accepted by this deployment.
- **Algorithm pinning**: ID-JAGs must be asymmetrically signed (RS/PS/ES/EdDSA); symmetric algorithms are rejected to prevent key-confusion attacks. Issued tokens are pinned to HS256.
- **Replay detection** for ID-JAG `jti` values is in-memory and therefore best-effort on serverless/multi-instance deployments; ID-JAGs are short-lived (typically 5 minutes), which bounds the window. Use a shared store if your threat model requires strict single-use.
- **Token endpoint hardening**: `/token` is unauthenticated by design (clients present ID-JAGs), so it is rate-limited per client IP (`ENTERPRISE_TOKEN_RATE_LIMIT_*`), and the OIDC discovery request to the IdP carries a 5-second timeout so a hung IdP cannot stall requests. Like the `jti` replay cache, the rate limiter's state is in-memory and per-instance — on horizontally scaled or serverless deployments treat both as best-effort, and enforce hard limits at your edge/proxy or back them with a shared store (e.g. Redis) if your threat model requires it.
- **Rate limiting and proxies**: the client IP is taken from the rightmost `X-Forwarded-For` entry (the hop that reached the trusted proxy — resistant to spoofing on single-proxy platforms like Vercel). If you self-host behind multiple proxy hops, verify what your outermost proxy puts there: if the rightmost entry is a shared internal proxy IP, distinct callers collapse into one rate-limit bucket and you should raise `ENTERPRISE_TOKEN_RATE_LIMIT_REQUESTS` or enforce limits at the proxy instead. If you expose the server **directly with no proxy at all**, the header is entirely attacker-controlled (a caller can rotate it per request to escape per-IP buckets) — put a proxy or CDN in front, or enforce limits there.
- **`resource` claim**: an ID-JAG without a `resource` claim is accepted — the extension makes the token-exchange `resource` parameter optional and only constrains the claim "if present". The `aud` check still binds every grant to this authorization server, which serves exactly one resource.
- **Signing key hygiene**: `ENTERPRISE_AUTH_SIGNING_KEY` is a bearer-token-minting secret. It must be a high-entropy random value — the server enforces a minimum length, but length alone is not enough (a long dictionary phrase is forgeable). Generate it with `openssl rand -base64 32`, store it in your platform's secret manager, rotate it periodically (rotation invalidates outstanding access tokens, forcing a silent re-exchange), and never commit it.
- The enterprise identity (`sub`, `email`, `scope`, `client_id`) of a verified request is available to request handling as `req.enterpriseAuth`, with the `sub` claim as the stable identifier for account linking per the spec.
