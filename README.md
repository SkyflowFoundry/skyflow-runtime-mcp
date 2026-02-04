# Skyflow PII MCP

A streamable HTTP MCP (Model Context Protocol) server built with TypeScript, Express, and the official MCP SDK.

## Overview

> [!WARNING]  
> This is an experimental project in development. This project is not supported and offered under an MIT license.

This server demonstrates how to build a remote MCP server using the Streamable HTTP transport. It exposes tools and resources that can be accessed by MCP clients like Claude Desktop.

## Try it out online

This remote MCP server is hosted at `https://pii-mcp.dev/mcp`. You can connect using your own Skyflow credentials - see the configuration section below for details.

### Integration with Claude Desktop

To use this MCP server with Claude Desktop, add the following configuration to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sky": {
      "command": "npx",
      "args": ["mcp-remote", "https://pii-mcp.dev/mcp"],
      "headers": {
        "Authorization": "Bearer {mcp token here}"
      }
    }
  }
}
```

### Table of contents

- [Skyflow PII MCP](#skyflow-pii-mcp)
  - [Overview](#overview)
  - [Try it out online](#try-it-out-online)
    - [Integration with Claude Desktop](#integration-with-claude-desktop)
    - [Table of contents](#table-of-contents)
    - [Features](#features)
    - [Configuration File Locations](#configuration-file-locations)
  - [Architecture](#architecture)
  - [Installation](#installation)
  - [Development](#development)
    - [Quick Start](#quick-start)
    - [Available Scripts](#available-scripts)
    - [Manual Setup (Alternative)](#manual-setup-alternative)
    - [Understanding the Ports](#understanding-the-ports)
    - [Environment Variables](#environment-variables)
    - [Dependencies](#dependencies)
  - [Learn More](#learn-more)


### Features

- **Tools**:
  - `dehydrate`: Skyflow dehydration tool for detecting and redacting sensitive information (PII, PHI, etc.) in text
  - `rehydrate`: Reverses dehydration by restoring original sensitive data from tokens
  - `dehydrate_file`: Processes files (images, PDFs, audio, documents) to detect and redact sensitive information
- **Authentication**: Supports both JWT bearer tokens and API keys via `Authorization` header (auto-detected)
- **Multi-tenant**: Each request can specify different vault configurations via query parameters
- **Transport**: Streamable HTTP with JSON response support
- **Port**: Configurable via `PORT` environment variable (defaults to 3000)

**Note**: Make sure the server is running before starting Claude Desktop.

### Configuration File Locations

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

After updating the config:

1. Save the file
2. Restart Claude Desktop completely (quit and reopen)
3. The `add` and `dehydrate` tools should now be available in Claude Desktop

## Architecture

- **Express Server**: Handles HTTP requests on the `/mcp` endpoint
- **MCP Server**: Registers tools and resources using the official SDK
- **Streamable HTTP Transport**: Creates a new transport per request to prevent ID collisions
- **Session Management**: Each request gets its own isolated transport instance

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

**Authentication Model**: This server supports multiple authentication methods:
- **JWT bearer token**: Pass via `Authorization: Bearer <jwt>` header - auto-detected by JWT format
- **API key via header**: Pass via `Authorization: Bearer <api-key>` header - non-JWT values are treated as API keys
- **API key via query param**: Pass via `?apiKey=<api-key>` query parameter (fallback)

Create a `.env.local` file with optional fallback values:

- `VAULT_ID`: Your Skyflow vault ID (optional - can be provided via query parameter)
- `VAULT_URL`: Your Skyflow vault URL (optional - can be provided via query parameter, e.g., `https://ebfc9bee4242.vault.skyflowapis.com`)
- `WORKSPACE_ID`: Your Skyflow workspace ID (optional - can be provided via query parameter)
- `ACCOUNT_ID`: Your Skyflow account ID (optional - can be provided via query parameter)
- `PORT`: Server port (default: 3000)

**Note**: `SKYFLOW_API_KEY` and `REQUIRED_BEARER_TOKEN` are no longer used. The bearer token is now passed through from the client to Skyflow.

## Anonymous Mode (Try Before You Buy)

You can try the dehydrate tool without configuring Skyflow credentials. When no credentials are provided and anonymous mode is enabled on the server, limited functionality is available.

### Quick Start (Anonymous)

```bash
# No credentials needed!
curl -X POST "https://pii-mcp.dev/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"dehydrate","arguments":{"inputString":"My email is john@example.com and my SSN is 123-45-6789"}},"id":1}'
```

### Limitations in Anonymous Mode

- **Only `dehydrate` tool available** - `rehydrate` and `dehydrate_file` return helpful errors
- **Tokens use entity counters** - e.g., `[EMAIL_ADDRESS_1]`, `[SSN_2]` instead of vault tokens
- **Data is NOT persisted** - tokens cannot be rehydrated later
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

To unlock full functionality (rehydrate, file processing, persistent vault tokens), configure your Skyflow credentials as shown in the sections above.

### Server Configuration for Anonymous Mode

Server operators can enable anonymous mode by setting these environment variables:

- `ANON_MODE_API_KEY`: Skyflow API key for demo vault
- `ANON_MODE_VAULT_ID`: Demo vault identifier
- `ANON_MODE_VAULT_URL`: Demo vault URL
- `ANON_MODE_RATE_LIMIT_REQUESTS`: Max requests per window (default: 10)
- `ANON_MODE_RATE_LIMIT_WINDOW_MS`: Window duration in ms (default: 60000)

## Testing

**Note**: All requests require authentication and configuration. Replace placeholders with your actual values:

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

### Call the Dehydrate Tool

Test calling the `dehydrate` tool to redact sensitive information:

```bash
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"dehydrate","arguments":{"inputString":"My email is john.doe@example.com and my SSN is 123-45-6789"}},"id":2}'
```

This will return the dehydrated text with sensitive data redacted, along with word and character counts.

### Call the Rehydrate Tool

Test calling the `rehydrate` tool to restore original sensitive data:

```bash
curl -X POST "http://localhost:3000/mcp?vaultId={vault_id}&vaultUrl={vault_url}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer {your_bearer_token}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"rehydrate","arguments":{"inputString":"[REDACTED_TEXT_WITH_TOKENS]"}},"id":3}'
```

## Integration with Claude Desktop

To use this MCP server with Claude Desktop, add the following configuration to your `claude_desktop_config.json`:

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
      "args": ["mcp-remote", "https://pii-mcp.dev/mcp?accountId={account_id}&vaultId={vault_id}&vaultUrl={vault_url}&workspaceId={workspace_id}"],
      "headers": {
        "Authorization": "Bearer {your_skyflow_bearer_token}"
      }
    }
  }
}
```

**Important Notes**:
- Replace `{your_skyflow_bearer_token}` with your actual Skyflow bearer token
- Replace `{account_id}`, `{vault_id}`, `{vault_url}`, and `{workspace_id}` with your Skyflow configuration values
- The `vaultUrl` should be URL-encoded (e.g., `https%3A%2F%2Febfc9bee4242.vault.skyflowapis.com`)
- Make sure the server is running before starting Claude Desktop (for local development)

### Configuration File Locations

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

After updating the config:

1. Save the file
2. Restart Claude Desktop completely (quit and reopen)
3. The `dehydrate`, `rehydrate`, and `dehydrate_file` tools should now be available in Claude Desktop

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

- [Model Context Protocol Documentation](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Streamable HTTP Transport Guide](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http)
