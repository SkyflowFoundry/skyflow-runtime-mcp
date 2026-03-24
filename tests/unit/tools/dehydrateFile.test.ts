import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDehydrateFile, DEFAULT_MAX_WAIT_TIME_SECONDS } from "../../../src/lib/tools/dehydrateFile";
import type { DehydrateFileArgs } from "../../../src/lib/tools/types";

// Mock the skyflow-node SDK
const mockSetEntities = vi.fn();
const mockSetMaskingMethod = vi.fn();
const mockSetOutputProcessedImage = vi.fn();
const mockSetOutputProcessedAudio = vi.fn();
const mockSetOutputOcrText = vi.fn();
const mockSetOutputTranscription = vi.fn();
const mockSetPixelDensity = vi.fn();
const mockSetMaxResolution = vi.fn();
const mockSetWaitTime = vi.fn();
const mockDeidentifyFile = vi.fn();

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
    DeidentifyFileOptions: vi.fn(function (this: any) {
      this.setEntities = mockSetEntities;
      this.setMaskingMethod = mockSetMaskingMethod;
      this.setOutputProcessedImage = mockSetOutputProcessedImage;
      this.setOutputProcessedAudio = mockSetOutputProcessedAudio;
      this.setOutputOcrText = mockSetOutputOcrText;
      this.setOutputTranscription = mockSetOutputTranscription;
      this.setPixelDensity = mockSetPixelDensity;
      this.setMaxResolution = mockSetMaxResolution;
      this.setWaitTime = mockSetWaitTime;
    }),
    DeidentifyFileRequest: vi.fn(function (this: any, fileInput: any) { this.fileInput = fileInput; }),
    SkyflowError: MockSkyflowError,
  };
});

// Mock entity maps
vi.mock("../../../src/lib/mappings/entityMaps", () => ({
  getEntityEnum: vi.fn((entity: string) => `ENUM_${entity.toUpperCase()}`),
  getMaskingMethodEnum: vi.fn((method: string) => `ENUM_${method}`),
  getTranscriptionEnum: vi.fn((type: string) => `ENUM_${type}`),
}));

function createMockSkyflow(response: Record<string, unknown> = {}) {
  return {
    detect: vi.fn(() => ({
      deidentifyFile: mockDeidentifyFile.mockResolvedValue(response),
    })),
  } as unknown;
}

const baseArgs: DehydrateFileArgs = {
  fileData: Buffer.from("test file content").toString("base64"),
  fileName: "test.png",
  mimeType: "image/png",
};

describe("handleDehydrateFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("anonymous mode", () => {
    it("should return error with anonymousModeRestricted flag", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDehydrateFile(baseArgs, skyflow as any, "vault123", true);

      expect(result.isError).toBe(true);
      expect(result.output).toHaveProperty("anonymousModeRestricted", true);
    });

    it("should suggest dehydrate as alternative tool", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDehydrateFile(baseArgs, skyflow as any, "vault123", true);

      expect((result.output as any).alternativeTool).toBe("dehydrate");
    });

    it("should not call the Skyflow API in anonymous mode", async () => {
      const skyflow = createMockSkyflow();
      await handleDehydrateFile(baseArgs, skyflow as any, "vault123", true);

      expect((skyflow as any).detect).not.toHaveBeenCalled();
    });
  });

  describe("authenticated mode", () => {
    it("should include inputFileName and inputMimeType in output", async () => {
      const skyflow = createMockSkyflow({});
      const result = await handleDehydrateFile(baseArgs, skyflow as any, "vault123", false);

      expect(result.isError).toBeUndefined();
      expect((result.output as any).inputFileName).toBe("test.png");
      expect((result.output as any).inputMimeType).toBe("image/png");
    });

    it("should set outputProcessedImage for image mime types", async () => {
      const skyflow = createMockSkyflow({});
      await handleDehydrateFile(
        { ...baseArgs, mimeType: "image/jpeg", outputProcessedFile: true },
        skyflow as any, "vault123", false
      );

      expect(mockSetOutputProcessedImage).toHaveBeenCalledWith(true);
      expect(mockSetOutputProcessedAudio).not.toHaveBeenCalled();
    });

    it("should set outputProcessedAudio for audio mime types", async () => {
      const skyflow = createMockSkyflow({});
      await handleDehydrateFile(
        { ...baseArgs, mimeType: "audio/mp3", outputProcessedFile: true },
        skyflow as any, "vault123", false
      );

      expect(mockSetOutputProcessedAudio).toHaveBeenCalledWith(true);
      expect(mockSetOutputProcessedImage).not.toHaveBeenCalled();
    });

    it("should map entity strings to enums", async () => {
      const skyflow = createMockSkyflow({});
      await handleDehydrateFile(
        { ...baseArgs, entities: ["email_address", "ssn"] },
        skyflow as any, "vault123", false
      );

      expect(mockSetEntities).toHaveBeenCalledWith(["ENUM_EMAIL_ADDRESS", "ENUM_SSN"]);
    });

    it("should map masking method to enum", async () => {
      const skyflow = createMockSkyflow({});
      await handleDehydrateFile(
        { ...baseArgs, maskingMethod: "BLUR" },
        skyflow as any, "vault123", false
      );

      expect(mockSetMaskingMethod).toHaveBeenCalledWith("ENUM_BLUR");
    });

    it("should use DEFAULT_MAX_WAIT_TIME_SECONDS when waitTime not specified", async () => {
      const skyflow = createMockSkyflow({});
      await handleDehydrateFile(baseArgs, skyflow as any, "vault123", false);

      expect(mockSetWaitTime).toHaveBeenCalledWith(DEFAULT_MAX_WAIT_TIME_SECONDS);
    });

    it("should use provided waitTime when specified", async () => {
      const skyflow = createMockSkyflow({});
      await handleDehydrateFile(
        { ...baseArgs, waitTime: 30 },
        skyflow as any, "vault123", false
      );

      expect(mockSetWaitTime).toHaveBeenCalledWith(30);
    });

    it("should include all optional response fields when present", async () => {
      const skyflow = createMockSkyflow({
        fileBase64: "base64data",
        type: "image/png",
        extension: "png",
        wordCount: 10,
        charCount: 50,
        sizeInKb: 100,
        pageCount: 2,
        slideCount: 5,
        durationInSeconds: 30,
        entities: [{ file: "entity_base64", extension: "png" }],
        runId: "run_123",
        status: "completed",
      });
      const result = await handleDehydrateFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as any;

      expect(output.processedFileData).toBe("base64data");
      expect(output.mimeType).toBe("image/png");
      expect(output.extension).toBe("png");
      expect(output.wordCount).toBe(10);
      expect(output.charCount).toBe(50);
      expect(output.sizeInKb).toBe(100);
      expect(output.pageCount).toBe(2);
      expect(output.slideCount).toBe(5);
      expect(output.durationInSeconds).toBe(30);
      expect(output.detectedEntities).toEqual([{ file: "entity_base64", extension: "png" }]);
      expect(output.runId).toBe("run_123");
      expect(output.status).toBe("completed");
    });

    it("should omit optional fields when not in response", async () => {
      const skyflow = createMockSkyflow({});
      const result = await handleDehydrateFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as any;

      expect(output.processedFileData).toBeUndefined();
      expect(output.wordCount).toBeUndefined();
      expect(output.detectedEntities).toBeUndefined();
      expect(output.runId).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("should handle SkyflowError with code and details", async () => {
      const { SkyflowError } = await import("skyflow-node");
      const skyflowError = new (SkyflowError as any)("Vault not found", 404, "Details here");
      mockDeidentifyFile.mockRejectedValue(skyflowError);

      const skyflow = {
        detect: vi.fn(() => ({
          deidentifyFile: mockDeidentifyFile,
        })),
      };

      const result = await handleDehydrateFile(baseArgs, skyflow as any, "vault123", false);

      expect(result.isError).toBe(true);
      expect((result.output as any).error).toBe(true);
      expect((result.output as any).message).toBe("Vault not found");
      expect((result.output as any).code).toBe(404);
      expect((result.output as any).details).toBe("Details here");
    });

    it("should handle generic errors with message", async () => {
      mockDeidentifyFile.mockRejectedValue(new Error("Network timeout"));

      const skyflow = {
        detect: vi.fn(() => ({
          deidentifyFile: mockDeidentifyFile,
        })),
      };

      const result = await handleDehydrateFile(baseArgs, skyflow as any, "vault123", false);

      expect(result.isError).toBe(true);
      expect((result.output as any).error).toBe(true);
      expect((result.output as any).message).toBe("Network timeout");
    });

    it("should handle non-Error thrown values", async () => {
      mockDeidentifyFile.mockRejectedValue("string error");

      const skyflow = {
        detect: vi.fn(() => ({
          deidentifyFile: mockDeidentifyFile,
        })),
      };

      const result = await handleDehydrateFile(baseArgs, skyflow as any, "vault123", false);

      expect(result.isError).toBe(true);
      expect((result.output as any).message).toBe("Unknown error occurred");
    });
  });
});
