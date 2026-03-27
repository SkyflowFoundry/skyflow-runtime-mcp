import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDeIdentify } from "../../../src/lib/tools/deIdentify";
import type { DeIdentifyOutput, DeIdentifyErrorOutput } from "../../../src/lib/tools/types";

// Mock the skyflow-node SDK
const mockSetDefault = vi.fn();
const mockSetTokenFormat = vi.fn();
const mockDeidentifyText = vi.fn();

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
    TokenFormat: vi.fn(function (this: any) { this.setDefault = mockSetDefault; }),
    TokenType: {
      VAULT_TOKEN: "VAULT_TOKEN",
      ENTITY_UNIQUE_COUNTER: "ENTITY_UNIQUE_COUNTER",
    },
    DeidentifyTextOptions: vi.fn(function (this: any) { this.setTokenFormat = mockSetTokenFormat; }),
    DeidentifyTextRequest: vi.fn(function (this: any, input: string) { this.input = input; }),
    SkyflowError: MockSkyflowError,
  };
});

function createMockSkyflow(response: {
  processedText: string;
  wordCount: number;
  charCount: number;
  entities: Array<{
    token?: string;
    value?: string;
    entity?: string;
    textIndex?: { start?: number; end?: number };
    processedIndex?: { start?: number; end?: number };
    scores?: Record<string, number>;
  }>;
}) {
  return {
    detect: vi.fn(() => ({
      deidentifyText: mockDeidentifyText.mockResolvedValue(response),
    })),
  } as unknown;
}

describe("handleDeIdentify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authenticated mode", () => {
    const mockResponse = {
      processedText: "My email is [EMAIL_ADDRESS_abc123]",
      wordCount: 4,
      charCount: 34,
      entities: [
        {
          token: "[EMAIL_ADDRESS_abc123]",
          value: "john@example.com",
          entity: "email_address",
          textIndex: { start: 12, end: 28 },
          processedIndex: { start: 12, end: 34 },
          scores: { email_address: 0.99 },
        },
      ],
    };

    it("should return correct output shape with all fields", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      const result = await handleDeIdentify("My email is john@example.com", skyflow as any, false);
      const output = result.output as DeIdentifyOutput;

      expect(result.isError).toBeUndefined();
      expect(output).toHaveProperty("inputText");
      expect(output).toHaveProperty("processedText");
      expect(output).toHaveProperty("wordCount");
      expect(output).toHaveProperty("charCount");
      expect(output).toHaveProperty("entities");
      expect(output.anonymousMode).toBeUndefined();
      expect(output.note).toBeUndefined();
    });

    it("should pass through inputText from the original input", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      const input = "My email is john@example.com";
      const result = await handleDeIdentify(input, skyflow as any, false);
      const output = result.output as DeIdentifyOutput;

      expect(output.inputText).toBe(input);
    });

    it("should expose entity metadata with token, value, entity, positions, and scores", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      const result = await handleDeIdentify("My email is john@example.com", skyflow as any, false);
      const output = result.output as DeIdentifyOutput;

      expect(output.entities).toHaveLength(1);
      const entity = output.entities[0];
      expect(entity.token).toBe("[EMAIL_ADDRESS_abc123]");
      expect(entity.value).toBe("john@example.com");
      expect(entity.entity).toBe("email_address");
      expect(entity.textIndex).toEqual({ start: 12, end: 28 });
      expect(entity.processedIndex).toEqual({ start: 12, end: 34 });
      expect(entity.scores).toEqual({ email_address: 0.99 });
    });

    it("should use VAULT_TOKEN format in authenticated mode", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      await handleDeIdentify("test", skyflow as any, false);

      expect(mockSetDefault).toHaveBeenCalledWith("VAULT_TOKEN");
    });

    it("should return empty entities array when no PII detected", async () => {
      const skyflow = createMockSkyflow({
        processedText: "Hello world",
        wordCount: 2,
        charCount: 11,
        entities: [],
      });
      const result = await handleDeIdentify("Hello world", skyflow as any, false);
      const output = result.output as DeIdentifyOutput;

      expect(output.entities).toEqual([]);
    });
  });

  describe("anonymous mode", () => {
    const mockResponse = {
      processedText: "My email is [EMAIL_ADDRESS_1]",
      wordCount: 4,
      charCount: 29,
      entities: [
        {
          token: "[EMAIL_ADDRESS_1]",
          entity: "email_address",
        },
      ],
    };

    it("should include anonymousMode flag and note", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      const result = await handleDeIdentify("My email is john@example.com", skyflow as any, true);
      const output = result.output as DeIdentifyOutput;

      expect(output.anonymousMode).toBe(true);
      expect(output.note).toContain("anonymous mode");
    });

    it("should use ENTITY_UNIQUE_COUNTER format in anonymous mode", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      await handleDeIdentify("test", skyflow as any, true);

      expect(mockSetDefault).toHaveBeenCalledWith("ENTITY_UNIQUE_COUNTER");
    });
  });

  describe("error handling", () => {
    it("should handle SkyflowError with code and details", async () => {
      const { SkyflowError } = await import("skyflow-node");
      const skyflowError = new (SkyflowError as any)("Invalid token", 401, "Token expired");
      mockDeidentifyText.mockRejectedValue(skyflowError);

      const skyflow = {
        detect: vi.fn(() => ({
          deidentifyText: mockDeidentifyText,
        })),
      };

      const result = await handleDeIdentify("test input", skyflow as any, false);
      const output = result.output as DeIdentifyErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.error).toBe(true);
      expect(output.message).toBe("Invalid token");
      expect(output.code).toBe(401);
      expect(output.details).toBe("Token expired");
    });

    it("should handle generic errors with message", async () => {
      mockDeidentifyText.mockRejectedValue(new Error("Network timeout"));

      const skyflow = {
        detect: vi.fn(() => ({
          deidentifyText: mockDeidentifyText,
        })),
      };

      const result = await handleDeIdentify("test input", skyflow as any, false);
      const output = result.output as DeIdentifyErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.error).toBe(true);
      expect(output.message).toBe("Network timeout");
    });

    it("should handle non-Error thrown values", async () => {
      mockDeidentifyText.mockRejectedValue("string error");

      const skyflow = {
        detect: vi.fn(() => ({
          deidentifyText: mockDeidentifyText,
        })),
      };

      const result = await handleDeIdentify("test input", skyflow as any, false);
      const output = result.output as DeIdentifyErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.message).toBe("Unknown error occurred");
    });
  });
});
