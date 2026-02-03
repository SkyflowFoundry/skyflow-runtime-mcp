# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Skyflow MCP (Model Context Protocol) server that provides PII/PHI detection and redaction capabilities through a streamable HTTP transport. It's built with Express, TypeScript, and the official MCP SDK, exposing Skyflow's deidentification capabilities as MCP tools.

## Development Commands

### Quick Start
```bash
pnpm dev
```
This is the recommended way to develop. It automatically:
- Starts the MCP Inspector on ports 6274 (UI) and 6277 (proxy)
- Opens your browser with pre-configured connection to `http://localhost:3000/mcp`
- Starts the MCP server on port 3000
- Displays interleaved logs from both processes

### Individual Commands
```bash
pnpm server      # Start only the MCP server on port 3000
pnpm inspector   # Start only the MCP Inspector
```

### Testing with curl
```bash
# Note: Replace {your_bearer_token}, {vault_id}, and {vault_url} with your actual values

# List available tools
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Call dehydrate tool
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"dehydrate","arguments":{"inputString":"My email is john.doe@example.com"}},"id":2}'
```

## Architecture

### Core Components

**Express HTTP Server** (`src/server.ts`)
- Serves a single `/mcp` endpoint that handles all MCP protocol requests
- Accepts query parameters: `accountId`, `vaultId`, `vaultUrl`, `workspaceId`, `apiKey` (optional)
- Uses credentials extraction middleware to validate either Authorization header or apiKey query parameter
- Configured with 5MB JSON payload limit to support base64-encoded files

**MCP Server Instance**
- Registers three main tools: `dehydrate`, `rehydrate`, and `dehydrate_file`
- Each tool is defined with Zod schemas for input validation and output structure
- Uses the official `@modelcontextprotocol/sdk` library

**Transport Layer - Critical Architecture Detail**
- Creates a NEW `StreamableHTTPServerTransport` instance **per request**
- This prevents request ID collisions when handling concurrent requests
- Each transport is closed when the HTTP response completes
- Uses `enableJsonResponse: true` for compatibility

**Skyflow Client Integration - Per-Request Pattern**
- Creates a **new Skyflow instance for each request** (no global singleton)
- Configured with vault credentials from query parameters (or fallback to environment variables)
- Extracts `clusterId` from `vaultUrl` using regex pattern per-request
- Supports **two credential types**: bearer token (from Authorization header) or API key (from query parameter)
- Credentials are forwarded to Skyflow API in the appropriate format: `{ token: string }` or `{ apiKey: string }`
- Uses `AsyncLocalStorage` to make Skyflow instance available to tools during request handling
- Tools access the current request's Skyflow instance via `getCurrentSkyflow()` and `getCurrentVaultId()`

### Tool Implementations

**dehydrate tool**
- Detects and replaces sensitive information with tokens
- Returns processed text with word/character counts
- Uses `TokenFormat` with `VAULT_TOKEN` type in authenticated mode, `ENTITY_UNIQUE_COUNTER` in anonymous mode
- In anonymous mode, adds `anonymousMode: true` and a note to the response
- Has commented-out support for custom regex allow/restrict lists

**rehydrate tool**
- Reverses dehydration by replacing tokens with original sensitive data
- Simpler implementation than dehydrate - just calls `reidentifyText`

**dehydrate_file tool**
- Most complex tool - handles images, PDFs, audio, and documents
- Accepts base64-encoded file data (max 5MB encoded, ~3.75MB original)
- Supports entity-specific detection (59 entity types mapped in `ENTITY_MAP`)
- Configurable masking methods for images (BLACKBOX, BLUR)
- Optional outputs: processed file, OCR text, transcription for audio
- Includes detailed error handling for `SkyflowError` instances
- Uses `waitTime` parameter (max 64 seconds) for async operations

### Type Safety Approach

The codebase uses explicit mapping objects to convert string inputs to enum values:
- `ENTITY_MAP`: Maps 59 entity type strings to `DetectEntities` enum
- `MASKING_METHOD_MAP`: Maps masking method strings to `MaskingMethod` enum
- `TRANSCRIPTION_MAP`: Maps transcription type strings to enum values

This ensures type safety and provides clear error messages for invalid inputs.

## Environment Configuration

**Authentication Model**: The server supports multiple authentication methods:
1. **Bearer token via header** (JWT): Clients provide their Skyflow bearer token via `Authorization: Bearer <jwt>` header. The server auto-detects JWTs by their format (3 dot-separated base64url parts).
2. **API key via header**: Clients can also pass a Skyflow API key via `Authorization: Bearer <api-key>` header. If the value doesn't look like a JWT, it's treated as an API key.
3. **API key via query parameter** (fallback): Clients can pass a Skyflow API key via `apiKey` query parameter

Optional fallback variables in `.env.local`:
- `VAULT_ID`: Your Skyflow vault identifier (can be overridden via query parameter)
- `VAULT_URL`: Full vault URL (e.g., `https://ebfc9bee4242.vault.skyflowapis.com`) (can be overridden via query parameter)
- `WORKSPACE_ID`: Your Skyflow workspace identifier (can be overridden via query parameter)
- `ACCOUNT_ID`: Your Skyflow account identifier (can be overridden via query parameter)
- `PORT`: Server port (default: 3000)

**Removed variables** (no longer used):
- `SKYFLOW_API_KEY`: No longer needed - credentials are passed from client
- `REQUIRED_BEARER_TOKEN`: No longer needed - all valid credentials are accepted and forwarded to Skyflow

The server extracts `clusterId` from `vaultUrl` (query parameter or env var) using the pattern: `https://([^.]+).vault`

**Connection Format**:

Primary method (bearer token via header):
```
https://your-server.com/mcp?vaultId={vault_id}&vaultUrl={vault_url}&accountId={account_id}&workspaceId={workspace_id}
```
With header:
```
Authorization: Bearer {your_skyflow_bearer_token}
```

Fallback method (API key via query parameter):
```
https://your-server.com/mcp?vaultId={vault_id}&vaultUrl={vault_url}&accountId={account_id}&workspaceId={workspace_id}&apiKey={your_skyflow_api_key}
```

## Anonymous Mode

When no credentials are provided in a request, the server can operate in "anonymous mode" if the following environment variables are configured:

**Environment Variables for Anonymous Mode**:
- `ANON_MODE_API_KEY`: Skyflow API key for demo vault
- `ANON_MODE_VAULT_ID`: Demo vault identifier
- `ANON_MODE_VAULT_URL`: Demo vault URL (e.g., `https://demo.vault.skyflowapis.com`)
- `ANON_MODE_RATE_LIMIT_REQUESTS`: Max requests per window (default: 10)
- `ANON_MODE_RATE_LIMIT_WINDOW_MS`: Window duration in milliseconds (default: 60000)

**Tool Behavior in Anonymous Mode**:

| Tool | Anonymous Mode | Authenticated Mode |
|------|---------------|-------------------|
| `dehydrate` | Works with `ENTITY_UNIQUE_COUNTER` tokens | Works with `VAULT_TOKEN` tokens |
| `rehydrate` | Returns error with setup instructions | Works normally |
| `dehydrate_file` | Returns error with setup instructions | Works normally |

**Token Format Difference**:
- **Anonymous mode**: Uses `TokenType.ENTITY_UNIQUE_COUNTER` - generates tokens like `[EMAIL_ADDRESS_1]`, `[SSN_2]`. Data is NOT persisted to vault.
- **Authenticated mode**: Uses `TokenType.VAULT_TOKEN` - generates tokens like `[EMAIL_ADDRESS_abc123xyz]` that are stored in the vault and can be rehydrated.

**Rate Limiting**:
Anonymous mode requests are rate-limited based on client IP address. When the limit is exceeded, a 429 response is returned with `X-RateLimit-*` headers indicating when the limit resets.

## Port Configuration

- **3000**: MCP server (configurable via `PORT` env var)
- **6274**: MCP Inspector UI
- **6277**: MCP Inspector Proxy

## Development Script Details

The `dev.sh` script is sophisticated:
1. Starts inspector in background with `MCP_AUTO_OPEN_ENABLED=false`
2. Captures output to extract `MCP_PROXY_AUTH_TOKEN`
3. Waits for "MCP Inspector is up and running" message
4. Opens browser with pre-configured URL including proxy auth token
5. Starts the MCP server in foreground (receives Ctrl+C signals)

## Key Implementation Patterns

**Per-Request Skyflow Instance Pattern**
```typescript
app.post("/mcp", authenticateBearer, async (req, res) => {
  // Extract configuration from query parameters (with env var fallbacks)
  const vaultId = (req.query.vaultId as string) || process.env.VAULT_ID;
  const vaultUrl = (req.query.vaultUrl as string) || process.env.VAULT_URL;
  const clusterId = vaultUrl.match(/https:\/\/([^.]+)\.vault/)?.[1];

  // Create per-request Skyflow instance with credentials (bearer token or API key)
  const skyflowInstance = new Skyflow({
    vaultConfigs: [{
      vaultId: vaultId,
      clusterId: clusterId,
      credentials: req.skyflowCredentials, // Either { token } or { apiKey }
    }],
  });

  // NEW transport per request - critical for preventing ID collisions
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
  });

  // Run within AsyncLocalStorage context so tools can access Skyflow instance
  await requestContextStorage.run(
    { skyflow: skyflowInstance, vaultId: vaultId },
    async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
  );
});
```

**Credentials Authentication**
- Supports multiple authentication methods with fallback logic:
  1. **Authorization header** (primary): Extracted from `Authorization: Bearer <value>` header
     - If value looks like a JWT (3 dot-separated base64url parts), treated as bearer token → `{ token }`
     - Otherwise, treated as API key → `{ apiKey }`
  2. **API key query parameter** (fallback): Extracted from `apiKey` query parameter → `{ apiKey }`
- Authorization header takes precedence over query parameter
- Validates format and presence of credentials
- Returns appropriate HTTP status codes: 401 for missing/invalid credentials
- Credentials are attached to request object in Skyflow SDK format and forwarded to Skyflow API
- No server-side credential validation - Skyflow API validates the credentials

**Tool Response Structure**
All tools return both text and structured content:
```typescript
return {
  content: [{ type: "text", text: JSON.stringify(output) }],
  structuredContent: output,
};
```

## Dependencies

- `@modelcontextprotocol/sdk`: Official MCP TypeScript SDK (v1.19.1+)
- `skyflow-node`: Skyflow SDK for deidentification (v2.0.0+)
- `express`: Web framework (v5.1.0+)
- `zod`: Schema validation for tool inputs/outputs
- `dotenv`: Environment variable management
- `tsx`: TypeScript execution (via npx)

## Common Pitfalls

1. **Don't reuse transport or Skyflow instances** - Always create new ones per request
2. **File size limits** - Base64 encoding adds ~33% overhead; 5MB limit means ~3.75MB original files
3. **Credentials or anonymous mode required** - All `/mcp` requests must include valid credentials OR anonymous mode must be configured via `ANON_MODE_*` environment variables
4. **Query parameters required** - `vaultId` and `vaultUrl` must be provided (via query params or env vars) - unless using anonymous mode
5. **Vault configuration** - `clusterId` is automatically extracted from `vaultUrl`, don't set it separately
6. **Entity type validation** - Use exact strings from `ENTITY_MAP` keys, not the enum values
7. **AsyncLocalStorage context** - Tools must run within the request context to access Skyflow instance via `getCurrentSkyflow()` and `isAnonymousMode()`
8. **Anonymous mode limitations** - Only the `dehydrate` tool works in anonymous mode; `rehydrate` and `dehydrate_file` return errors with setup instructions
