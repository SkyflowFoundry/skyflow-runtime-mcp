import type { ToolResult } from "./types.js";

export interface HelloOutput {
  message: string;
  serverName: string;
  serverVersion: string;
  vaultId: string;
  anonymousMode: boolean;
  timestamp: string;
}

export interface HelloContext {
  serverName: string;
  serverVersion: string;
  vaultId: string;
  anonymousMode: boolean;
}

export async function handleHello(
  name: string | undefined,
  context: HelloContext
): Promise<ToolResult<HelloOutput>> {
  const greeting = name?.trim() ? `Hello, ${name.trim()}!` : "Hello from Skyflow Runtime MCP!";
  return {
    output: {
      message: greeting,
      serverName: context.serverName,
      serverVersion: context.serverVersion,
      vaultId: context.vaultId,
      anonymousMode: context.anonymousMode,
      timestamp: new Date().toISOString(),
    },
  };
}
