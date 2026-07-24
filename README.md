# Skyflow Runtime MCP

A remote MCP server for connecting to a Skyflow Vault for sensitive PII data detection,  de-identification, and tokenization as well as selective policy-driven re-identification of sensitive data elements. Give your agent tools to find and remove PII to sanitize text and ensure data privacy and security.

> [!WARNING]  
> This is an experimental project in development. This project is not supported and is offered under an MIT license.

- [Skyflow Runtime MCP](#skyflow-runtime-mcp)
  - [Try it out online](#try-it-out-online)
  - [Connecting in Authenticated Mode](#connecting-in-authenticated-mode)
    - [Connection Contract](#connection-contract)
    - [Minimal Example (curl)](#minimal-example-curl)
    - [Client Configuration Checklist](#client-configuration-checklist)
    - [Self-Hosted Fallbacks](#self-hosted-fallbacks)
  - [Installation](#installation)
  - [Development](#development)
    - [Quick Start](#quick-start)
    - [Available Scripts](#available-scripts)
    - [Manual Setup (Alternative)](#manual-setup-alternative)
    - [Understanding the Ports](#understanding-the-ports)
    - [Environment Variables](#environment-variables)
  - [Anonymous Mode (Try Before You Buy)](#anonymous-mode-try-before-you-buy)
    - [Quick Start (Anonymous)](#quick-start-anonymous)
    - [Limitations in Anonymous Mode](#limitations-in-anonymous-mode)
    - [Claude Desktop (Anonymous)](#claude-desktop-anonymous)
    - [Server Configuration for Anonymous Mode](#server-configuration-for-anonymous-mode)
  - [Testing](#testing)
    - [List Available Tools](#list-available-tools)
    - [Call the De-identify Tool](#call-the-de-identify-tool)
    - [Call the Re-identify Tool](#call-the-re-identify-tool)
  - [Integration with Claude Desktop](#integration-with-claude-desktop)
    - [Local Development](#local-development)
    - [Remote Connection (Recommended)](#remote-connection-recommended)
    - [Configuration File Locations](#configuration-file-locations)
  - [Architecture](#architecture)
  - [Dependencies](#dependencies)
  - [Learn More](#learn-more)

## Try it out online

This remote MCP server is hosted at `https://pii-mcp.dev/mcp`. Connect using your own Skyflow credentials — see [Connecting in Authenticated Mode](#connecting-in-authenticated-mode) for the contract, or [Anonymous Mode](#anonymous-mode-try-before-you-buy) to try it without credentials.

For a concrete client example, see [Integration with Claude Desktop](#integration-with-claude-desktop).

## Connecting in Authenticated Mode

Authenticated mode forwards your own Skyflow credentials to your vault. Any MCP client that supports Streamable HTTP can connect — the server has no client-specific logic.

### Connection Contract

**Endpoint**

```text
POST https://pii-mcp.dev/mcp?vaultId=<VAULT_ID>&vaultUrl=<VAULT_URL>
```

**Required query parameters**

| Param | Value | Notes |
|-------|-------|-------|
| `vaultId` | Your Skyflow vault ID | Found in Skyflow Studio → Vault details. |
| `vaultUrl` | Your vault's base URL | e.g. `https://ebfc9bee4242.vault.skyflowapis.com`. URL-encode when embedding in a query string: `https%3A%2F%2Febfc9bee4242.vault.skyflowapis.com`. `clusterId` is extracted from this automatically. |

**Required credential** — pick one:

| Method | Where | Format |
|--------|-------|--------|
| Bearer token (preferred) | `Authorization: Bearer <jwt>` header | Skyflow JWT (3 dot-separated base64url segments). Auto-detected. |
| API key (header) | `Authorization: Bearer <api-key>` header | Any non-JWT value in the `Authorization` header is treated as an API key. |
| API key (query) | `?apiKey=<api-key>` query parameter | Fallback for clients that can't set headers. Ignored if `Authorization` header is present. |

Credentials are forwarded to Skyflow as-is. The server does not store or log them; Skyflow's API validates them at call time.

### Minimal Example (curl)

```bash
curl -X POST "https://pii-mcp.dev/mcp?vaultId=$VAULT_ID&vaultUrl=$VAULT_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SKYFLOW_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Client Configuration Checklist

Any MCP client needs to:

1. Point at `/mcp` with `vaultId` + `vaultUrl` appended as query parameters.
2. Send `Authorization: Bearer <credential>` on every request (or append `&apiKey=<key>` if the client can't inject headers).
3. Send `Content-Type: application/json` and `Accept: application/json, text/event-stream`.

See [Integration with Claude Desktop](#integration-with-claude-desktop) for one concrete client. The same pattern applies to any Streamable HTTP MCP client (Cursor, MCP Inspector, custom SDK clients).

### Self-Hosted Fallbacks

When self-hosting, `VAULT_ID` and `VAULT_URL` can be set as environment variables in `.env.local` — query parameters override them per request. Useful for pinning a single vault without rewriting client URLs. See [Environment Variables](#environment-variables).

## Installation

```bash
npm install
# or
pnpm install
```

## Development

### Quick Start

The easiest way to start developing is to use the `dev` script, which automatically starts both the MCP server and inspector with the correct configuration:

```bash
pnpm dev
```

This will:

1. Start the MCP Inspector on port 6274 (UI) and 6277 (proxy)
2. Automatically open your browser with the inspector pre-configured to connect to `http://localhost:3000/mcp`
3. Start your MCP server on port 3000
4. Display interleaved logs from both processes in your terminal

### Available Scripts

- **`pnpm dev`** - Recommended for development. Starts both inspector and server with automatic browser configuration
- **`pnpm server`** - Starts only the MCP server on port 3000
- **`pnpm inspector`** - Starts only the MCP Inspector (useful if you want to run them in separate terminals)

### Manual Setup (Alternative)

If you prefer to run the inspector and server in separate terminals:

1. Copy your Vault Details into `.env.local`
2. In terminal 1, start the inspector:
   ```bash
   pnpm inspector
   ```
3. In terminal 2, start the server:
   ```bash
   pnpm server
   ```
4. Open your browser to `http://localhost:6274/`
5. Choose 'Streamable HTTP' and set the address to `http://localhost:3000/mcp`
6. Click 'Connect'

### Understanding the Ports

- **Port 3000**: Your MCP server (configurable via `PORT` env var)
- **Port 6274**: MCP Inspector UI (where you interact with the inspector)
- **Port 6277**: MCP Inspector Proxy (internal proxy used by the inspector)

### Environment Variables

For authentication methods, see [Connecting in Authenticated Mode](#connecting-in-authenticated-mode).

Create a `.env.local` file with optional fallback values:

- `VAULT_ID`: Your Skyflow vault ID (optional - can be provided via query parameter)
- `VAULT_URL`: Your Skyflow vault URL (optional - can be provided via query parameter, e.g., `https://ebfc9bee4242.vault.skyflowapis.com`)
- `PORT`: Server port (default: 3000)

**Note**: `SKYFLOW_API_KEY`, `REQUIRED_BEARER_TOKEN`, `ACCOUNT_ID`, and `WORKSPACE_ID` are no longer used. The bearer token is passed through from the client to Skyflow; account/workspace IDs were never consumed by the SDK.

## Anonymous Mode (Try Before You Buy)

You can try the de-identify tool without configuring Skyflow credentials. When no credentials are provided and anonymous mode is enabled on the server, limited functionality is available.

### Quick Start (Anonymous)

```bash
# No credentials needed!
curl -X POST "https://pii-mcp.dev/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"de-identify","arguments":{"inputString":"My email is john@example.com and my SSN is 123-45-6789"}},"id":1}'
```

### Limitations in Anonymous Mode

- **Only `de-identify` tool available** - `re-identify` returns a helpful error
- **Tokens use entity counters** - e.g., `[EMAIL_ADDRESS_1]`, `[SSN_2]` instead of vault tokens
- **Data is NOT persisted** - tokens cannot be re-identified later
- **Rate limited** - 10 requests per minute per IP (configurable by server operator)

### Claude Desktop (Anonymous)

To use anonymous mode with Claude Desktop:

```json
{
  "mcpServers": {
    "skyflow-pii-demo": {
      "command": "npx",
      "args": ["mcp-remote", "https://pii-mcp.dev/mcp"]
    }
  }
}
```

To unlock full functionality (re-identify, file processing, persistent vault tokens), configure your Skyflow credentials as shown in the sections above.

### Server Configuration for Anonymous Mode

Server operators can enable anonymous mode by setting these environment variables:

- `ANON_MODE_API_KEY`: Skyflow API key for demo vault
- `ANON_MODE_VAULT_ID`: Demo vault identifier
- `ANON_MODE_VAULT_URL`: Demo vault URL
- `ANON_MODE_RATE_LIMIT_REQUESTS`: Max requests per window (default: 10)
- `ANON_MODE_RATE_LIMIT_WINDOW_MS`: Window duration in ms (default: 60000)

## Testing

The examples below use curl. See [Connecting in Authenticated Mode](#connecting-in-authenticated-mode) for the full contract. Placeholders used:

- `{your_bearer_token}`: Your Skyflow JWT bearer token OR API key (auto-detected based on format)
- `{vault_id}`: Your Skyflow vault ID
- `{vault_url}`: Your Skyflow vault URL (e.g., `https://ebfc9bee4242.vault.skyflowapis.com`)

### List Available Tools

Test the MCP server by listing available tools:

```bash
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Call the De-identify Tool

Test calling the `de-identify` tool to redact sensitive information:

```bash
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"de-identify","arguments":{"inputString":"My email is john.doe@example.com and my SSN is 123-45-6789"}},"id":2}'
```

This will return the de-identified text with sensitive data redacted, along with word and character counts.

### Call the Re-identify Tool

Test calling the `re-identify` tool to restore original sensitive data:

```bash
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"re-identify","arguments":{"inputString":"[REDACTED_TEXT_WITH_TOKENS]"}},"id":3}'
```

By default every token is fully restored to its original value. To control how
individual entity types are rendered, pass an optional `format` object with any
of `redacted`, `masked`, or `plaintext` — each a list of entity types (the same
lowercase names as the `de-identify` tool, e.g. `ssn`, `email_address`). Entity
types not listed fall back to the Detect API's default and are restored as full plaintext:

```bash
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"re-identify","arguments":{"inputString":"[REDACTED_TEXT_WITH_TOKENS]","format":{"masked":["ssn"],"redacted":["email_address"],"plaintext":["name"]}}},"id":3}'
```

In this example, SSNs come back partially masked, email addresses are fully
redacted, names are restored in full, and any other detected entity type is
restored to plaintext.

## Integration with Claude Desktop

Claude Desktop is one concrete client for the [Connection Contract](#connection-contract). It uses `mcp-remote` as a bridge to the Streamable HTTP endpoint. Add the following to your `claude_desktop_config.json`:

### Local Development

For local testing with environment variable fallbacks:

```json
{
  "mcpServers": {
    "skyflow-pii": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3000/mcp"],
      "headers": {
        "Authorization": "Bearer {your_skyflow_bearer_token}"
      }
    }
  }
}
```

### Remote Connection (Recommended)

For connecting to the hosted server or any remote instance with dynamic configuration:

```json
{
  "mcpServers": {
    "skyflow-pii": {
      "command": "npx",
      "args": ["mcp-remote", "https://pii-mcp.dev/mcp?vaultId={vault_id}&vaultUrl={vault_url}"],
      "headers": {
        "Authorization": "Bearer {your_skyflow_bearer_token}"
      }
    }
  }
}
```

**Important Notes**:
- Replace `{your_skyflow_bearer_token}` with your actual Skyflow bearer token
- Replace `{vault_id}` and `{vault_url}` with your Skyflow configuration values
- The `vaultUrl` should be URL-encoded (e.g., `https%3A%2F%2Febfc9bee4242.vault.skyflowapis.com`)
- Make sure the server is running before starting Claude Desktop (for local development)

### Configuration File Locations

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

After updating the config:

1. Save the file
2. Restart Claude Desktop completely (quit and reopen)
3. The `de-identify` and `re-identify` tools should now be available in Claude Desktop

## Architecture

- **Express Server**: Handles HTTP requests on the `/mcp` endpoint with query parameter support
- **Bearer Token Pass-Through**: Client's Skyflow bearer token is forwarded directly to Skyflow API
- **Per-Request Skyflow Instances**: Each request creates its own Skyflow client with unique credentials
- **AsyncLocalStorage Context**: Tools access the current request's Skyflow instance via context
- **Streamable HTTP Transport**: Creates a new transport per request to prevent ID collisions
- **Multi-Tenant Support**: Different users can use different vaults/workspaces via query parameters

## Dependencies

- `@modelcontextprotocol/sdk`: Official MCP TypeScript SDK
- `express`: Web server framework
- `zod`: Schema validation for tool inputs/outputs
- `skyflow-node`: Skyflow SDK for data privacy and deidentification
- `dotenv`: Environment variable management

## Learn More

- [Wrapping Your MCP Tools with Skyflow](docs/wrapping-mcp-tools-with-skyflow.md) — de-identify requests / re-identify responses inside your own MCP server
- [Model Context Protocol Documentation](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Streamable HTTP Transport Guide](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http)
