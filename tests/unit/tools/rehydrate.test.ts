import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleRehydrate } from "../../../src/lib/tools/rehydrate";
import type { RehydrateOutput, RehydrateErrorOutput, AnonymousModeError } from "../../../src/lib/tools/types";

// Mock the skyflow-node SDK
const mockReidentifyText = vi.fn();

vi.mock("skyflow-node", () => {
  class MockSkyflowError extends Error {
    error: { http_code?: number; details?: unknown };
    constructor(message: string, httpCode?: number, details?: unknown) {
      super(message);
      this.name = "SkyflowError";
      this.error = { http_code: httpCode, details };
    }
  }
  return {
    ReidentifyTextRequest: vi.fn(function (this: any, input: string) { this.input = input; }),
    SkyflowError: MockSkyflowError,
  };
});

function createMockSkyflow(response: { processedText: string }) {
  return {
    detect: vi.fn(() => ({
      reidentifyText: mockReidentifyText.mockResolvedValue(response),
    })),
  } as unknown;
}

describe("handleRehydrate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authenticated mode", () => {
    it("should return inputText and processedText", async () => {
      const skyflow = createMockSkyflow({ processedText: "My email is john@example.com" });
      const input = "My email is [EMAIL_ADDRESS_abc123]";
      const result = await handleRehydrate(input, skyflow as any, false);

      expect(result.isError).toBeUndefined();
      expect(result.output).toHaveProperty("inputText");
      expect(result.output).toHaveProperty("processedText");
    });

    it("should pass through inputText from the original input", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored text" });
      const input = "tokenized input [SSN_abc123]";
      const result = await handleRehydrate(input, skyflow as any, false);
      const output = result.output as RehydrateOutput;

      expect(output.inputText).toBe(input);
    });

    it("should return the restored text from Skyflow", async () => {
      const skyflow = createMockSkyflow({ processedText: "My SSN is 123-45-6789" });
      const result = await handleRehydrate("My SSN is [SSN_abc123]", skyflow as any, false);
      const output = result.output as RehydrateOutput;

      expect(output.processedText).toBe("My SSN is 123-45-6789");
    });
  });

  describe("anonymous mode", () => {
    it("should return error with anonymousModeRestricted flag", async () => {
      const skyflow = createMockSkyflow({ processedText: "" });
      const result = await handleRehydrate("test", skyflow as any, true);

      expect(result.isError).toBe(true);
      expect(result.output).toHaveProperty("anonymousModeRestricted", true);
    });

    it("should include setup instructions in error message", async () => {
      const skyflow = createMockSkyflow({ processedText: "" });
      const result = await handleRehydrate("test", skyflow as any, true);
      const output = result.output as AnonymousModeError;

      expect(output.message).toContain("Skyflow credentials");
      expect(output.message).toContain("Authorization header");
    });

    it("should not call the Skyflow API in anonymous mode", async () => {
      const skyflow = createMockSkyflow({ processedText: "" });
      await handleRehydrate("test", skyflow as any, true);

      expect((skyflow as any).detect).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should handle SkyflowError with code and details", async () => {
      const { SkyflowError } = await import("skyflow-node");
      const skyflowError = new (SkyflowError as any)("Token not found", 404, "No matching token");
      mockReidentifyText.mockRejectedValue(skyflowError);

      const skyflow = {
        detect: vi.fn(() => ({
          reidentifyText: mockReidentifyText,
        })),
      };

      const result = await handleRehydrate("test input", skyflow as any, false);
      const output = result.output as RehydrateErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.error).toBe(true);
      expect(output.message).toBe("Token not found");
      expect(output.code).toBe(404);
      expect(output.details).toBe("No matching token");
    });

    it("should handle generic errors with message", async () => {
      mockReidentifyText.mockRejectedValue(new Error("Network timeout"));

      const skyflow = {
        detect: vi.fn(() => ({
          reidentifyText: mockReidentifyText,
        })),
      };

      const result = await handleRehydrate("test input", skyflow as any, false);
      const output = result.output as RehydrateErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.error).toBe(true);
      expect(output.message).toBe("Network timeout");
    });

    it("should handle non-Error thrown values", async () => {
      mockReidentifyText.mockRejectedValue("string error");

      const skyflow = {
        detect: vi.fn(() => ({
          reidentifyText: mockReidentifyText,
        })),
      };

      const result = await handleRehydrate("test input", skyflow as any, false);
      const output = result.output as RehydrateErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.message).toBe("Unknown error occurred");
    });
  });
});
