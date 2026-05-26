import { describe, it, expect } from "vitest";
import { handleHello } from "../../../src/lib/tools/hello";

const baseContext = {
  serverName: "Test Server",
  serverVersion: "9.9.9",
  vaultId: "vault_abc",
  anonymousMode: false,
};

describe("handleHello", () => {
  it("returns a default greeting when no name is provided", async () => {
    const result = await handleHello(undefined, baseContext);
    expect(result.isError).toBeUndefined();
    expect(result.output.message).toBe("Hello from Skyflow Runtime MCP!");
  });

  it("personalizes the greeting when a name is provided", async () => {
    const result = await handleHello("Joe", baseContext);
    expect(result.output.message).toBe("Hello, Joe!");
  });

  it("treats a blank name as no name", async () => {
    const result = await handleHello("   ", baseContext);
    expect(result.output.message).toBe("Hello from Skyflow Runtime MCP!");
  });

  it("echoes connection metadata", async () => {
    const result = await handleHello(undefined, {
      ...baseContext,
      anonymousMode: true,
      vaultId: "vault_xyz",
    });
    expect(result.output.serverName).toBe("Test Server");
    expect(result.output.serverVersion).toBe("9.9.9");
    expect(result.output.vaultId).toBe("vault_xyz");
    expect(result.output.anonymousMode).toBe(true);
  });

  it("returns an ISO-8601 timestamp", async () => {
    const result = await handleHello(undefined, baseContext);
    expect(() => new Date(result.output.timestamp).toISOString()).not.toThrow();
    expect(result.output.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
