import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDehydrate } from "../../../src/lib/tools/dehydrate";

// Mock the skyflow-node SDK
const mockSetDefault = vi.fn();
const mockSetTokenFormat = vi.fn();
const mockDeidentifyText = vi.fn();

vi.mock("skyflow-node", () => ({
  TokenFormat: vi.fn(function (this: any) { this.setDefault = mockSetDefault; }),
  TokenType: {
    VAULT_TOKEN: "VAULT_TOKEN",
    ENTITY_UNIQUE_COUNTER: "ENTITY_UNIQUE_COUNTER",
  },
  DeidentifyTextOptions: vi.fn(function (this: any) { this.setTokenFormat = mockSetTokenFormat; }),
  DeidentifyTextRequest: vi.fn(function (this: any, input: string) { this.input = input; }),
}));

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

describe("handleDehydrate", () => {
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
      const result = await handleDehydrate("My email is john@example.com", skyflow as any, false);

      expect(result).toHaveProperty("inputText");
      expect(result).toHaveProperty("processedText");
      expect(result).toHaveProperty("wordCount");
      expect(result).toHaveProperty("charCount");
      expect(result).toHaveProperty("entities");
      expect(result.anonymousMode).toBeUndefined();
      expect(result.note).toBeUndefined();
    });

    it("should pass through inputText from the original input", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      const input = "My email is john@example.com";
      const result = await handleDehydrate(input, skyflow as any, false);

      expect(result.inputText).toBe(input);
    });

    it("should expose entity metadata with token, value, entity, positions, and scores", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      const result = await handleDehydrate("My email is john@example.com", skyflow as any, false);

      expect(result.entities).toHaveLength(1);
      const entity = result.entities[0];
      expect(entity.token).toBe("[EMAIL_ADDRESS_abc123]");
      expect(entity.value).toBe("john@example.com");
      expect(entity.entity).toBe("email_address");
      expect(entity.textIndex).toEqual({ start: 12, end: 28 });
      expect(entity.processedIndex).toEqual({ start: 12, end: 34 });
      expect(entity.scores).toEqual({ email_address: 0.99 });
    });

    it("should use VAULT_TOKEN format in authenticated mode", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      await handleDehydrate("test", skyflow as any, false);

      expect(mockSetDefault).toHaveBeenCalledWith("VAULT_TOKEN");
    });

    it("should return empty entities array when no PII detected", async () => {
      const skyflow = createMockSkyflow({
        processedText: "Hello world",
        wordCount: 2,
        charCount: 11,
        entities: [],
      });
      const result = await handleDehydrate("Hello world", skyflow as any, false);

      expect(result.entities).toEqual([]);
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
      const result = await handleDehydrate("My email is john@example.com", skyflow as any, true);

      expect(result.anonymousMode).toBe(true);
      expect(result.note).toContain("anonymous mode");
    });

    it("should use ENTITY_UNIQUE_COUNTER format in anonymous mode", async () => {
      const skyflow = createMockSkyflow(mockResponse);
      await handleDehydrate("test", skyflow as any, true);

      expect(mockSetDefault).toHaveBeenCalledWith("ENTITY_UNIQUE_COUNTER");
    });
  });
});
