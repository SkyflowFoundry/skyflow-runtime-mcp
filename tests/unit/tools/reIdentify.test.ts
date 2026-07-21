import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleReIdentify } from "../../../src/lib/tools/reIdentify";
import type { ReIdentifyOutput, ReIdentifyErrorOutput, AnonymousModeError } from "../../../src/lib/tools/types";

// Mock the skyflow-node SDK
const mockReidentifyText = vi.fn();
const mockSetRedactedEntities = vi.fn();
const mockSetMaskedEntities = vi.fn();
const mockSetPlainTextEntities = vi.fn();

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
    ReidentifyTextOptions: vi.fn(function (this: any) {
      this.setRedactedEntities = mockSetRedactedEntities;
      this.setMaskedEntities = mockSetMaskedEntities;
      this.setPlainTextEntities = mockSetPlainTextEntities;
    }),
    // Proxy returns lowercase prop names to mirror the real DetectEntities enum
    // values (e.g. DetectEntities.SSN === "ssn"), so getEntityEnum round-trips.
    DetectEntities: new Proxy({}, { get: (_t, prop) => String(prop).toLowerCase() }),
    MaskingMethod: new Proxy({}, { get: (_t, prop) => prop }),
    DetectOutputTranscription: new Proxy({}, { get: (_t, prop) => prop }),
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

describe("handleReIdentify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authenticated mode", () => {
    it("should return inputText and processedText", async () => {
      const skyflow = createMockSkyflow({ processedText: "My email is john@example.com" });
      const input = "My email is [EMAIL_ADDRESS_abc123]";
      const result = await handleReIdentify(input, skyflow as any, false);

      expect(result.isError).toBeUndefined();
      expect(result.output).toHaveProperty("inputText");
      expect(result.output).toHaveProperty("processedText");
    });

    it("should pass through inputText from the original input", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored text" });
      const input = "tokenized input [SSN_abc123]";
      const result = await handleReIdentify(input, skyflow as any, false);
      const output = result.output as ReIdentifyOutput;

      expect(output.inputText).toBe(input);
    });

    it("should return the restored text from Skyflow", async () => {
      const skyflow = createMockSkyflow({ processedText: "My SSN is 123-45-6789" });
      const result = await handleReIdentify("My SSN is [SSN_abc123]", skyflow as any, false);
      const output = result.output as ReIdentifyOutput;

      expect(output.processedText).toBe("My SSN is 123-45-6789");
    });
  });

  describe("format handling", () => {
    it("should call reidentifyText without options when no format is provided", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored" });
      await handleReIdentify("[SSN_abc123]", skyflow as any, false);

      expect(mockReidentifyText).toHaveBeenCalledTimes(1);
      // Second argument (options) should be undefined for backward compatibility
      expect(mockReidentifyText.mock.calls[0][1]).toBeUndefined();
      expect(mockSetRedactedEntities).not.toHaveBeenCalled();
      expect(mockSetMaskedEntities).not.toHaveBeenCalled();
      expect(mockSetPlainTextEntities).not.toHaveBeenCalled();
    });

    it("should not echo a format field when none is provided", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored" });
      const result = await handleReIdentify("[SSN_abc123]", skyflow as any, false);
      const output = result.output as ReIdentifyOutput;

      expect(output).not.toHaveProperty("format");
    });

    it("should route entity types to redacted / masked / plaintext setters", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored" });
      await handleReIdentify("input", skyflow as any, false, {
        redacted: ["ssn"],
        masked: ["credit_card"],
        plaintext: ["email_address", "name"],
      });

      expect(mockSetRedactedEntities).toHaveBeenCalledWith(["ssn"]);
      expect(mockSetMaskedEntities).toHaveBeenCalledWith(["credit_card"]);
      expect(mockSetPlainTextEntities).toHaveBeenCalledWith(["email_address", "name"]);
      // Options object should be forwarded to the SDK call
      expect(mockReidentifyText.mock.calls[0][1]).toBeDefined();
    });

    it("should pass options even when only one bucket is provided", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored" });
      await handleReIdentify("input", skyflow as any, false, { masked: ["ssn"] });

      expect(mockSetMaskedEntities).toHaveBeenCalledWith(["ssn"]);
      expect(mockSetRedactedEntities).not.toHaveBeenCalled();
      expect(mockSetPlainTextEntities).not.toHaveBeenCalled();
      expect(mockReidentifyText.mock.calls[0][1]).toBeDefined();
    });

    it("should ignore empty buckets and skip options when format has no entities", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored" });
      await handleReIdentify("input", skyflow as any, false, {
        redacted: [],
        masked: [],
        plaintext: [],
      });

      expect(mockSetRedactedEntities).not.toHaveBeenCalled();
      expect(mockSetMaskedEntities).not.toHaveBeenCalled();
      expect(mockSetPlainTextEntities).not.toHaveBeenCalled();
      // No entities means no options object is forwarded
      expect(mockReidentifyText.mock.calls[0][1]).toBeUndefined();
    });

    it("should echo the applied format back in the output", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored" });
      const format = { masked: ["ssn"], plaintext: ["name"] };
      const result = await handleReIdentify("input", skyflow as any, false, format);
      const output = result.output as ReIdentifyOutput;

      expect(output.format).toEqual(format);
    });

    it("should echo an empty format object back when provided with no entities", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored" });
      const result = await handleReIdentify("input", skyflow as any, false, {});
      const output = result.output as ReIdentifyOutput;

      expect(output.format).toEqual({});
    });

    it("should return an error for an invalid entity type in the format", async () => {
      const skyflow = createMockSkyflow({ processedText: "restored" });
      const result = await handleReIdentify("input", skyflow as any, false, {
        masked: ["not_a_real_entity"],
      });
      const output = result.output as ReIdentifyErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.error).toBe(true);
      expect(output.message).toContain("Invalid entity type");
      expect(mockReidentifyText).not.toHaveBeenCalled();
    });
  });

  describe("anonymous mode", () => {
    it("should return error with anonymousModeRestricted flag", async () => {
      const skyflow = createMockSkyflow({ processedText: "" });
      const result = await handleReIdentify("test", skyflow as any, true);

      expect(result.isError).toBe(true);
      expect(result.output).toHaveProperty("anonymousModeRestricted", true);
    });

    it("should include setup instructions in error message", async () => {
      const skyflow = createMockSkyflow({ processedText: "" });
      const result = await handleReIdentify("test", skyflow as any, true);
      const output = result.output as AnonymousModeError;

      expect(output.message).toContain("Skyflow credentials");
      expect(output.message).toContain("Authorization header");
    });

    it("should not call the Skyflow API in anonymous mode", async () => {
      const skyflow = createMockSkyflow({ processedText: "" });
      await handleReIdentify("test", skyflow as any, true);

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

      const result = await handleReIdentify("test input", skyflow as any, false);
      const output = result.output as ReIdentifyErrorOutput;

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

      const result = await handleReIdentify("test input", skyflow as any, false);
      const output = result.output as ReIdentifyErrorOutput;

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

      const result = await handleReIdentify("test input", skyflow as any, false);
      const output = result.output as ReIdentifyErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.message).toBe("Unknown error occurred");
    });
  });
});
