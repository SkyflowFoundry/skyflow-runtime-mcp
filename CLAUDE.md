# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Skyflow MCP (Model Context Protocol) server that provides PII/PHI detection and redaction capabilities through a streamable HTTP transport. It's built with Express, TypeScript, and the official MCP SDK, exposing Skyflow's deidentification capabilities as MCP tools. Tools include interactive UIs via the MCP Apps SDK (`@modelcontextprotocol/ext-apps`) that render inline in supported hosts.

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
pnpm build:ui    # Build UI apps only (vite + vite-plugin-singlefile)
pnpm build:server # Build server only (tsc)
pnpm build       # Build UI apps then server (required before deploy)
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

# Call de-identify tool
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"de-identify","arguments":{"inputString":"My email is john.doe@example.com"}},"id":2}'

# Call de-identify-file tool with a signed/public URL
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"de-identify-file","arguments":{"fileUrl":"https://example-bucket.s3.amazonaws.com/scan.pdf?X-Amz-Signature=..."}},"id":3}'

# Poll an in-progress file run (runId comes from the de-identify-file response)
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get-file-run-status","arguments":{"runId":"{run_id}","waitSeconds":30}},"id":4}'
```

## Architecture

### Core Components

**Express HTTP Server** (`src/server.ts`)
- Serves a single `/mcp` endpoint that handles all MCP protocol requests
- Accepts query parameters: `vaultId`, `vaultUrl`, `apiKey` (optional)
- Uses credentials extraction middleware to validate either Authorization header or apiKey query parameter
- Configured with 25MB JSON payload limit to support base64-encoded files passed inline

**MCP Server Instance**
- Registers five active tools: `de-identify`, `re-identify`, `de-identify-file`, `get-file-run-status`, and `re-identify-file`
- Each tool is registered via `registerAppTool` from `@modelcontextprotocol/ext-apps/server`, linking tools to interactive UI resources
- Each tool is defined with Zod schemas for input validation and output structure
- Uses the official `@modelcontextprotocol/sdk` library

**MCP Apps UI Layer** (`ui/`)
- Tool UIs: `ui/de-identify/`, `ui/re-identify/`, `ui/de-identify-file/`, `ui/re-identify-file/`
- The `get-file-run-status` tool shares the `ui/de-identify-file/` app (both render de-identification run results)
- Shared theme/styles in `ui/shared/` (theme.ts, styles.css)
- Built with Vite + `vite-plugin-singlefile` → single HTML files in `dist/ui/`
- Resources registered via `registerAppResource` with `ui://` URIs
- Hosts that support MCP Apps render the UI inline; text-only hosts get JSON fallback via `content`
- See `docs/mcp-apps-ui.md` for a developer-oriented walkthrough of the apps, shared components, and how to add a new one.

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
- Tools access the current request's Skyflow instance via `getCurrentSkyflow()` and mode via `isAnonymousMode()`
- The request context also carries `vaultUrl` and the raw credential value for tools that call Detect REST endpoints directly (via `getDetectRestContext()`)

**Detect REST Helper** (`src/lib/detect/detectRest.ts`)
- Minimal fetch-based client for Detect endpoints the skyflow-node SDK doesn't expose:
  `GET /v1/detect/runs/{run_id}` (run status) and `POST /v1/detect/reidentify/file`
- Sends the same `Authorization: Bearer <credential>` the SDK would send (JWT or API key)
- Defensively parses both camelCase and snake_case response fields — the live API returns camelCase for several fields even though the OpenAPI types say snake_case

**File Source Helper** (`src/lib/files/fileSource.ts`)
- Resolves tool file inputs: either a signed/public `fileUrl` (downloaded server-side, 25MB cap, 30s timeout) or inline `fileDataBase64` + `fileName`
- Skyflow's file endpoints only accept base64, so URLs are always downloaded and converted before forwarding
- Blocks obvious SSRF targets (localhost, private/link-local IP literals, `.internal`/`.local` hosts); https or http only
- Infers the file name from the explicit arg → `Content-Disposition` header → URL path → `Content-Type` fallback; the lowercased extension selects the Skyflow endpoint/data_format

### Tool Implementations

**de-identify tool** (`src/lib/tools/deIdentify.ts`)
- Detects and replaces sensitive information with tokens
- Accepts optional `entities` array to limit detection to specific entity types (e.g., `["email_address", "ssn"]`); detects all types when omitted
- Returns `inputText`, `processedText`, `wordCount`, `charCount`, and `entities` array
- Each entity includes `token`, `value`, `entity`, `textIndex`, `processedIndex`, `scores`
- Uses `TokenFormat` with `VAULT_TOKEN` type in authenticated mode, `ENTITY_UNIQUE_COUNTER` in anonymous mode
- In anonymous mode, adds `anonymousMode: true` and a note to the response

**re-identify tool** (`src/lib/tools/reIdentify.ts`)
- Reverses de-identification by replacing tokens with original sensitive data
- Returns `inputText` and `processedText`
- Returns error with `anonymousModeRestricted: true` in anonymous mode

**de-identify-file tool** (`src/lib/tools/deIdentifyFile.ts`)
- Detects and redacts sensitive information in files: images (bmp, jpeg, jpg, png, tif, tiff), PDFs, Word/Excel/PowerPoint, txt, csv, json, xml, dcm, and audio (mp3, wav)
- Accepts the file as a signed/public `fileUrl` (downloaded server-side and converted to base64) or as `fileDataBase64` + `fileName`
- Options: `entities`, `allowRegexList`, `restrictRegexList`, `tokenType` (`entity_unique_counter` | `entity_only`), `maskingMethod` (images), `outputProcessedFile` (images/audio), `outputOcrText` (images), `outputTranscription` (audio), `pixelDensity`/`maxResolution` (PDFs), `dateShift`, `bleep` (audio)
- **Async handling**: Skyflow file de-identification is asynchronous. The tool waits up to `waitTimeSeconds` (default 25, max 64) for the run to finish; if it's still processing, the response carries `runId`, `status: "IN_PROGRESS"`, and a `note` instructing the agent to poll with `get-file-run-status`
- Uses the SDK's `deidentifyFile`, which routes to the type-specific Skyflow endpoint based on the file extension

**get-file-run-status tool** (`src/lib/tools/getFileRunStatus.ts`)
- Polls an asynchronous de-identification run by `runId` (from `de-identify-file`)
- Optional `waitSeconds` (0-55) long-polls server-side with backoff before returning
- On `SUCCESS`, returns the same output shape as `de-identify-file` (processed file base64, detected entities, counts)
- On `FAILED`, returns `isError` with Skyflow's failure message
- Calls `GET /v1/detect/runs/{run_id}` directly via the Detect REST helper

**re-identify-file tool** (`src/lib/tools/reIdentifyFile.ts`)
- Restores original sensitive data in a previously de-identified file (formats: csv, doc, docx, json, txt, xls, xlsx, xml)
- Accepts `fileUrl` or `fileDataBase64` + `fileName`, plus optional `redactedEntities`/`maskedEntities`/`plainTextEntities` lists controlling how each entity type is restored
- The Skyflow endpoint is synchronous — the processed file is returned directly
- Calls `POST /v1/detect/reidentify/file` via the Detect REST helper (the SDK has no high-level file re-identify)

**Tool handler extraction pattern**
- Core logic is in `src/lib/tools/*.ts` as pure functions with explicit parameters
- `src/server.ts` calls these functions, passing `getCurrentSkyflow()`, `isAnonymousMode()`, and for REST-based tools `getDetectRestContext()`
- Shared types live in `src/lib/tools/types.ts`
- Tool files: `deIdentify.ts`, `reIdentify.ts`, `deIdentifyFile.ts`, `getFileRunStatus.ts`, `reIdentifyFile.ts`
- This separation enables unit testing without `AsyncLocalStorage` context

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
- `PORT`: Server port (default: 3000)

**Removed variables** (no longer used):
- `SKYFLOW_API_KEY`: No longer needed - credentials are passed from client
- `REQUIRED_BEARER_TOKEN`: No longer needed - all valid credentials are accepted and forwarded to Skyflow
- `ACCOUNT_ID` / `WORKSPACE_ID`: Never consumed by Skyflow SDK - removed

The server extracts `clusterId` from `vaultUrl` (query parameter or env var) using the pattern: `https://([^.]+).vault`

**Connection Format**:

Primary method (bearer token via header):
```
https://your-server.com/mcp?vaultId={vault_id}&vaultUrl={vault_url}
```
With header:
```
Authorization: Bearer {your_skyflow_bearer_token}
```

Fallback method (API key via query parameter):
```
https://your-server.com/mcp?vaultId={vault_id}&vaultUrl={vault_url}&apiKey={your_skyflow_api_key}
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
| `de-identify` | Works with `ENTITY_UNIQUE_COUNTER` tokens | Works with `VAULT_TOKEN` tokens |
| `re-identify` | Returns error with setup instructions | Works normally |
| `de-identify-file` | Returns error with setup instructions | Works normally |
| `get-file-run-status` | Returns error with setup instructions | Works normally |
| `re-identify-file` | Returns error with setup instructions | Works normally |

**Token Format Difference**:
- **Anonymous mode**: Uses `TokenType.ENTITY_UNIQUE_COUNTER` - generates tokens like `[EMAIL_ADDRESS_1]`, `[SSN_2]`. Data is NOT persisted to vault.
- **Authenticated mode**: Uses `TokenType.VAULT_TOKEN` - generates tokens like `[EMAIL_ADDRESS_abc123xyz]` that are stored in the vault and can be re-identified.

**Rate Limiting**:
Anonymous mode requests are rate-limited based on client IP address. When the limit is exceeded, a 429 response is returned with `X-RateLimit-*` headers indicating when the limit resets.

**Placeholder Value Fallback**:
The server automatically falls back to anonymous mode when query parameters contain unsubstituted template placeholders. This handles cases where users configure the MCP server URL with environment variable templates that don't get substituted:

```text
?vaultId=${SKYFLOW_VAULT_ID}&vaultUrl=${SKYFLOW_VAULT_URL}
```

Detected placeholder patterns:

- `${VAR_NAME}` - shell/env var style (most common)
- `$VAR_NAME` - direct env var reference
- `{{VAR_NAME}}` - mustache/handlebars style
- `%VAR_NAME%` - Windows env var style

When placeholders are detected and anonymous mode is configured, the server logs a message and uses the anonymous mode vault configuration instead.

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
  isError: true, // Optional: set to true when tool returns an error condition
};
```

The `isError` property is set to `true` when a tool returns an error condition (e.g., when `re-identify` is called in anonymous mode, or when Skyflow API returns an error). This allows MCP clients to distinguish between successful responses and error responses.

## Dependencies

- `@modelcontextprotocol/sdk`: Official MCP TypeScript SDK (v1.27.1+)
- `@modelcontextprotocol/ext-apps`: MCP Apps SDK for interactive tool UIs
- `skyflow-node`: Skyflow SDK for deidentification (v2.1.2+ — required for the fixed `IN_PROGRESS` return path in `deidentifyFile`)
- `express`: Web framework (v5.1.0+)
- `zod`: Schema validation for tool inputs/outputs
- `dotenv`: Environment variable management
- `tsx`: TypeScript execution (via npx)
- `vite` + `vite-plugin-singlefile`: UI build pipeline (dev dependencies)

## Modifying Tools

Use this checklist whenever you add, remove, or change a tool's inputs or outputs. Missing any of these is the most common source of bugs and build errors in this codebase.

### When changing a tool's input or output schema

- [ ] **Handler function** (`src/lib/tools/<tool>.ts`) — update the function signature and implementation
- [ ] **`inputSchema` / `outputSchema`** in `src/server.ts` — the Zod schemas registered with `registerAppTool` must exactly match what the handler accepts and returns; TypeScript will catch mismatches on build
- [ ] **Handler call site** in `src/server.ts` — destructure any new args from the tool callback and pass them through
- [ ] **Unit tests** (`tests/unit/tools/<tool>.test.ts`) — update existing call sites to match the new signature; add tests for new parameters
- [ ] **UI types** (`ui/shared/types.ts`) — if the result shape changes, update the shared interface used by the UI
- [ ] **UI rendering** (`ui/<tool-name>/main.ts`) — if new result fields should be displayed or the UI reads new input args, update accordingly
- [ ] **CLAUDE.md** — update the Tool Implementations description and Anonymous Mode table if behavior changes

### When adding a new tool

All of the above, plus:

- [ ] **New handler file** `src/lib/tools/<tool>.ts` — follow the existing pattern: pure function, explicit params, returns `ToolResult<Output | ErrorOutput>`
- [ ] **Register resource** in `src/server.ts` — add `registerAppResource` with a `ui://<tool>/mcp-app.html` URI
- [ ] **Register tool** in `src/server.ts` — add `registerAppTool` with `inputSchema`, `outputSchema`, `_meta.ui.resourceUri`, and the async handler
- [ ] **New UI** `ui/<tool-name>/main.ts` — implement `ontoolinput` (loading state) and `ontoolresult` (result rendering)
- [ ] **Update MCP Server Instance count** in this file

### When adding a new UI app

- [ ] Add the app directory `ui/<tool-name>/` with `mcp-app.html` and `main.ts`
- [ ] Add an `INPUT=<tool-name>/mcp-app.html vite build` step to `build:ui` in `package.json`
- [ ] Add the `{ varName, dir }` entry to `scripts/generate-ui-imports.ts`
- [ ] Add the export to `src/generated/ui-html.d.ts` (hand-maintained declaration for the generated module)

### When disabling a tool

- [ ] Remove `registerAppTool` and `registerAppResource` calls from `src/server.ts`
- [ ] Remove unused HTML import from `./generated/ui-html.js`
- [ ] Remove unused handler import; keep the handler file itself for future re-enablement
- [ ] Remove any helper functions only used by that tool
- [ ] Update CLAUDE.md: tool count, Tool Implementations section, Anonymous Mode table, Common Pitfalls

## Common Pitfalls

1. **Don't reuse transport or Skyflow instances** - Always create new ones per request
2. **Credentials or anonymous mode required** - All `/mcp` requests must include valid credentials OR anonymous mode must be configured via `ANON_MODE_*` environment variables
3. **Query parameters required** - `vaultId` and `vaultUrl` must be provided (via query params or env vars) - unless using anonymous mode
4. **Vault configuration** - `clusterId` is automatically extracted from `vaultUrl`, don't set it separately
5. **Entity type validation** - Use exact strings from `ENTITY_MAP` keys, not the enum values
6. **AsyncLocalStorage context** - Tools must run within the request context to access Skyflow instance via `getCurrentSkyflow()` and `isAnonymousMode()`
7. **Anonymous mode limitations** - Only the `de-identify` tool works in anonymous mode; the other tools return an error with setup instructions
8. **Keep schemas in sync** - When modifying tool inputs or return values, always update the corresponding `inputSchema` and `outputSchema` in the tool registration. The schemas must match the actual implementation.
9. **File de-identification is asynchronous** - `de-identify-file` may return `runId` + `status: "IN_PROGRESS"` instead of the processed file; results are then fetched with `get-file-run-status`. Keep server-side waits bounded (SDK max 64s; watch serverless execution limits when deploying).
10. **Detect REST response casing** - The runs and reidentify-file endpoints return camelCase fields at runtime despite snake_case OpenAPI types; `detectRest.ts` parses both. Don't "simplify" it to a single casing.
11. **File URL downloads are an SSRF surface** - `de-identify-file`/`re-identify-file` fetch arbitrary user-supplied URLs. `src/lib/files/fileSource.ts` guards this: https/http only, private/loopback/link-local/CGNAT/metadata IPs blocked in every literal encoding, hostnames resolved and every resolved address checked, each redirect hop re-validated, and a streaming size cap. This does NOT fully close DNS-rebinding (a check-time/fetch-time TOCTOU). **When deploying where untrusted URLs may be submitted, also enforce network egress controls** (e.g. block the cloud metadata endpoint `169.254.169.254`) — the in-process guard is defense in depth, not a substitute.
