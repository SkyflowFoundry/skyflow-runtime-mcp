import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleDeIdentifyFile,
  DEFAULT_WAIT_TIME_SECONDS,
  MAX_WAIT_TIME_SECONDS,
} from "../../../src/lib/tools/deIdentifyFile";
import type {
  DeIdentifyFileArgs,
  DeIdentifyFileOutput,
  DeIdentifyFileErrorOutput,
  AnonymousModeError,
} from "../../../src/lib/tools/types";

// Mock the skyflow-node SDK
const mockSetEntities = vi.fn();
const mockSetAllowRegexList = vi.fn();
const mockSetRestrictRegexList = vi.fn();
const mockSetTokenFormat = vi.fn();
const mockSetMaskingMethod = vi.fn();
const mockSetOutputProcessedImage = vi.fn();
const mockSetOutputProcessedAudio = vi.fn();
const mockSetOutputOcrText = vi.fn();
const mockSetOutputTranscription = vi.fn();
const mockSetPixelDensity = vi.fn();
const mockSetMaxResolution = vi.fn();
const mockSetTransformations = vi.fn();
const mockSetBleep = vi.fn();
const mockSetWaitTime = vi.fn();
const mockDeidentifyFile = vi.fn();
const mockTokenFormatSetDefault = vi.fn();
const mockTransformationsSetShiftDays = vi.fn();
const mockBleepSetGain = vi.fn();
const mockBleepSetFrequency = vi.fn();
const mockBleepSetStartPadding = vi.fn();
const mockBleepSetStopPadding = vi.fn();

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
      this.setAllowRegexList = mockSetAllowRegexList;
      this.setRestrictRegexList = mockSetRestrictRegexList;
      this.setTokenFormat = mockSetTokenFormat;
      this.setMaskingMethod = mockSetMaskingMethod;
      this.setOutputProcessedImage = mockSetOutputProcessedImage;
      this.setOutputProcessedAudio = mockSetOutputProcessedAudio;
      this.setOutputOcrText = mockSetOutputOcrText;
      this.setOutputTranscription = mockSetOutputTranscription;
      this.setPixelDensity = mockSetPixelDensity;
      this.setMaxResolution = mockSetMaxResolution;
      this.setTransformations = mockSetTransformations;
      this.setBleep = mockSetBleep;
      this.setWaitTime = mockSetWaitTime;
    }),
    DeidentifyFileRequest: vi.fn(function (this: any, fileInput: any) { this.fileInput = fileInput; }),
    TokenFormat: vi.fn(function (this: any) {
      this.setDefault = mockTokenFormatSetDefault;
    }),
    Transformations: vi.fn(function (this: any) {
      this.setShiftDays = mockTransformationsSetShiftDays;
    }),
    Bleep: vi.fn(function (this: any) {
      this.setGain = mockBleepSetGain;
      this.setFrequency = mockBleepSetFrequency;
      this.setStartPadding = mockBleepSetStartPadding;
      this.setStopPadding = mockBleepSetStopPadding;
    }),
    TokenType: {
      ENTITY_UNIQUE_COUNTER: "entity_unq_counter",
      ENTITY_ONLY: "entity_only",
      VAULT_TOKEN: "vault_token",
    },
    SkyflowError: MockSkyflowError,
  };
});

// Mock entity maps
vi.mock("../../../src/lib/mappings/entityMaps", () => ({
  getEntityEnum: vi.fn((entity: string) => `ENUM_${entity.toUpperCase()}`),
  getMaskingMethodEnum: vi.fn((method: string) => `ENUM_${method}`),
  getTranscriptionEnum: vi.fn((type: string) => `ENUM_${type}`),
}));

// The SSRF guard resolves hostnames; default to a public address for URL tests.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

function createMockSkyflow(response: Record<string, unknown> = {}) {
  return {
    detect: vi.fn(() => ({
      deidentifyFile: mockDeidentifyFile.mockResolvedValue(response),
    })),
  } as unknown;
}

const baseArgs: DeIdentifyFileArgs = {
  fileDataBase64: Buffer.from("test file content").toString("base64"),
  fileName: "test.png",
  mimeType: "image/png",
};

describe("handleDeIdentifyFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("anonymous mode", () => {
    it("should return error with anonymousModeRestricted flag", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", true);

      expect(result.isError).toBe(true);
      expect(result.output).toHaveProperty("anonymousModeRestricted", true);
    });

    it("should suggest de-identify as alternative tool", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", true);
      const output = result.output as AnonymousModeError;

      expect(output.alternativeTool).toBe("de-identify");
    });

    it("should not call the Skyflow API in anonymous mode", async () => {
      const skyflow = createMockSkyflow();
      await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", true);

      expect((skyflow as any).detect).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it("should error when neither fileUrl nor fileDataBase64 is provided", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDeIdentifyFile({}, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.message).toContain("fileUrl");
      expect(output.message).toContain("fileDataBase64");
    });

    it("should error when both fileUrl and fileDataBase64 are provided", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDeIdentifyFile(
        { ...baseArgs, fileUrl: "https://example.com/file.png" },
        skyflow as any,
        "vault123",
        false
      );

      expect(result.isError).toBe(true);
      expect((result.output as DeIdentifyFileErrorOutput).message).toContain("not both");
    });

    it("should error when fileDataBase64 is provided without fileName", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDeIdentifyFile(
        { fileDataBase64: baseArgs.fileDataBase64 },
        skyflow as any,
        "vault123",
        false
      );

      expect(result.isError).toBe(true);
      expect((result.output as DeIdentifyFileErrorOutput).message).toContain("fileName");
    });

    it("should error on unsupported file formats", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDeIdentifyFile(
        { ...baseArgs, fileName: "video.mp4" },
        skyflow as any,
        "vault123",
        false
      );
      const output = result.output as DeIdentifyFileErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.message).toContain('".mp4"');
      expect((skyflow as any).detect).not.toHaveBeenCalled();
    });

    it("should error on invalid tokenType", async () => {
      const skyflow = createMockSkyflow();
      const result = await handleDeIdentifyFile(
        { ...baseArgs, tokenType: "vault_token" },
        skyflow as any,
        "vault123",
        false
      );

      expect(result.isError).toBe(true);
      expect((result.output as DeIdentifyFileErrorOutput).message).toContain("tokenType");
    });
  });

  describe("URL input", () => {
    it("should download the file and pass it to Skyflow", async () => {
      const fileBytes = Buffer.from("fake image bytes");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(fileBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        }))
      );

      const skyflow = createMockSkyflow({});
      const result = await handleDeIdentifyFile(
        { fileUrl: "https://bucket.s3.amazonaws.com/scan.png?sig=abc" },
        skyflow as any,
        "vault123",
        false
      );
      const output = result.output as DeIdentifyFileOutput;

      expect(result.isError).toBeUndefined();
      expect(output.inputFileName).toBe("scan.png");
      expect(output.inputFileUrl).toBe("https://bucket.s3.amazonaws.com/scan.png?sig=abc");
      expect(mockDeidentifyFile).toHaveBeenCalled();
    });

    it("should return a clear error when the download fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("denied", { status: 403 }))
      );

      const skyflow = createMockSkyflow({});
      const result = await handleDeIdentifyFile(
        { fileUrl: "https://bucket.s3.amazonaws.com/scan.png" },
        skyflow as any,
        "vault123",
        false
      );
      const output = result.output as DeIdentifyFileErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.message).toContain("403");
      expect(mockDeidentifyFile).not.toHaveBeenCalled();
    });
  });

  describe("authenticated mode", () => {
    it("should include inputFileName and inputMimeType in output", async () => {
      const skyflow = createMockSkyflow({});
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

      expect(result.isError).toBeUndefined();
      expect(output.inputFileName).toBe("test.png");
      expect(output.inputMimeType).toBe("image/png");
    });

    it("should set outputProcessedImage for image extensions", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, fileName: "photo.jpeg", outputProcessedFile: true },
        skyflow as any, "vault123", false
      );

      expect(mockSetOutputProcessedImage).toHaveBeenCalledWith(true);
      expect(mockSetOutputProcessedAudio).not.toHaveBeenCalled();
    });

    it("should set outputProcessedAudio for audio extensions", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, fileName: "call.mp3", outputProcessedFile: true },
        skyflow as any, "vault123", false
      );

      expect(mockSetOutputProcessedAudio).toHaveBeenCalledWith(true);
      expect(mockSetOutputProcessedImage).not.toHaveBeenCalled();
    });

    it("should warn when outputProcessedFile is unsupported for the format", async () => {
      const skyflow = createMockSkyflow({});
      const result = await handleDeIdentifyFile(
        { ...baseArgs, fileName: "doc.pdf", outputProcessedFile: true },
        skyflow as any, "vault123", false
      );
      const output = result.output as DeIdentifyFileOutput;

      expect(output.warnings?.[0]).toContain(".pdf");
      expect(mockSetOutputProcessedImage).not.toHaveBeenCalled();
      expect(mockSetOutputProcessedAudio).not.toHaveBeenCalled();
    });

    it("should map entity strings to enums", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, entities: ["email_address", "ssn"] },
        skyflow as any, "vault123", false
      );

      expect(mockSetEntities).toHaveBeenCalledWith(["ENUM_EMAIL_ADDRESS", "ENUM_SSN"]);
    });

    it("should map masking method to enum", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, maskingMethod: "BLUR" },
        skyflow as any, "vault123", false
      );

      expect(mockSetMaskingMethod).toHaveBeenCalledWith("ENUM_BLUR");
    });

    it("should set allow and restrict regex lists", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, allowRegexList: ["foo.*"], restrictRegexList: ["bar.*"] },
        skyflow as any, "vault123", false
      );

      expect(mockSetAllowRegexList).toHaveBeenCalledWith(["foo.*"]);
      expect(mockSetRestrictRegexList).toHaveBeenCalledWith(["bar.*"]);
    });

    it("should configure token format from tokenType", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, tokenType: "entity_only" },
        skyflow as any, "vault123", false
      );

      expect(mockTokenFormatSetDefault).toHaveBeenCalledWith("entity_only");
      expect(mockSetTokenFormat).toHaveBeenCalled();
    });

    it("should configure date-shift transformations for a supported format", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, fileName: "notes.txt", mimeType: "text/plain", dateShift: { minDays: 1, maxDays: 30, entities: ["dob"] } },
        skyflow as any, "vault123", false
      );

      expect(mockTransformationsSetShiftDays).toHaveBeenCalledWith({
        min: 1,
        max: 30,
        entities: ["ENUM_DOB"],
      });
      expect(mockSetTransformations).toHaveBeenCalled();
    });

    it("should configure bleep options for audio", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, fileName: "call.wav", bleep: { gain: 0.5, frequency: 800, startPadding: 0.1, stopPadding: 0.2 } },
        skyflow as any, "vault123", false
      );

      expect(mockBleepSetGain).toHaveBeenCalledWith(0.5);
      expect(mockBleepSetFrequency).toHaveBeenCalledWith(800);
      expect(mockBleepSetStartPadding).toHaveBeenCalledWith(0.1);
      expect(mockBleepSetStopPadding).toHaveBeenCalledWith(0.2);
      expect(mockSetBleep).toHaveBeenCalled();
    });

    it("should use DEFAULT_WAIT_TIME_SECONDS when waitTimeSeconds not specified", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);

      expect(mockSetWaitTime).toHaveBeenCalledWith(DEFAULT_WAIT_TIME_SECONDS);
    });

    it("should use provided waitTimeSeconds when specified", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, waitTimeSeconds: 30 },
        skyflow as any, "vault123", false
      );

      expect(mockSetWaitTime).toHaveBeenCalledWith(30);
    });

    it("should clamp waitTimeSeconds to the SDK maximum", async () => {
      const skyflow = createMockSkyflow({});
      await handleDeIdentifyFile(
        { ...baseArgs, waitTimeSeconds: 500 },
        skyflow as any, "vault123", false
      );

      expect(mockSetWaitTime).toHaveBeenCalledWith(MAX_WAIT_TIME_SECONDS);
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
        status: "SUCCESS",
      });
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

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
      expect(output.status).toBe("SUCCESS");
      expect(output.note).toBeUndefined();
    });

    it("should derive a real mimeType from the extension, not the SDK category label", async () => {
      const skyflow = createMockSkyflow({
        fileBase64: "base64data",
        type: "redacted_image", // SDK category label, not a MIME type
        extension: "png",
      });
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

      expect(output.mimeType).toBe("image/png");
      expect(output.extension).toBe("png");
    });

    it("should omit zero-valued counts the SDK defaults to 0", async () => {
      const skyflow = createMockSkyflow({
        fileBase64: "base64data",
        extension: "png",
        wordCount: 0,
        charCount: 0,
        sizeInKb: 0,
        pageCount: 0,
        slideCount: 0,
        durationInSeconds: 0,
      });
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

      expect(output.wordCount).toBeUndefined();
      expect(output.charCount).toBeUndefined();
      expect(output.sizeInKb).toBeUndefined();
      expect(output.pageCount).toBeUndefined();
      expect(output.slideCount).toBeUndefined();
      expect(output.durationInSeconds).toBeUndefined();
    });

    it("should apply dateShift for supported formats", async () => {
      const skyflow = createMockSkyflow({});
      const result = await handleDeIdentifyFile(
        { ...baseArgs, fileName: "notes.txt", mimeType: "text/plain", dateShift: { minDays: 1, maxDays: 30, entities: ["dob"] } },
        skyflow as any, "vault123", false
      );
      const output = result.output as DeIdentifyFileOutput;

      expect(mockSetTransformations).toHaveBeenCalled();
      expect(output.warnings).toBeUndefined();
    });

    it("should warn (and skip) dateShift for formats that don't support it", async () => {
      const skyflow = createMockSkyflow({});
      const result = await handleDeIdentifyFile(
        { ...baseArgs, fileName: "doc.pdf", mimeType: "application/pdf", dateShift: { minDays: 1, maxDays: 30, entities: ["dob"] } },
        skyflow as any, "vault123", false
      );
      const output = result.output as DeIdentifyFileOutput;

      expect(mockSetTransformations).not.toHaveBeenCalled();
      expect(output.warnings?.some((w) => w.includes("dateShift"))).toBe(true);
    });

    it("should return runId with polling note for in-progress runs", async () => {
      const skyflow = createMockSkyflow({
        runId: "run_async_456",
        status: "IN_PROGRESS",
      });
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

      expect(result.isError).toBeUndefined();
      expect(output.runId).toBe("run_async_456");
      expect(output.status).toBe("IN_PROGRESS");
      expect(output.note).toContain("get-file-run-status");
      expect(output.note).toContain("run_async_456");
      // No processed file yet — must not report a downloadable extension/MIME
      expect(output.processedFileData).toBeUndefined();
      expect(output.extension).toBeUndefined();
      expect(output.mimeType).toBeUndefined();
    });

    it("should attach a polling note for a runId with a non-SUCCESS status", async () => {
      const skyflow = createMockSkyflow({
        runId: "run_pending_789",
        status: "PENDING",
      });
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

      expect(output.runId).toBe("run_pending_789");
      expect(output.status).toBe("PENDING");
      expect(output.note).toContain("get-file-run-status");
    });

    it("should not attach a polling note for a completed run with a runId", async () => {
      const skyflow = createMockSkyflow({
        runId: "run_done_1",
        status: "SUCCESS",
        fileBase64: "base64data",
        extension: "png",
      });
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

      expect(output.runId).toBe("run_done_1");
      expect(output.status).toBe("SUCCESS");
      expect(output.note).toBeUndefined();
    });

    it("should not contradict itself: a returned file suppresses the polling note", async () => {
      // Defensive: a processed file present alongside a runId and a non-SUCCESS
      // status must not carry a "still processing" note.
      const skyflow = createMockSkyflow({
        runId: "run_weird_1",
        status: "IN_PROGRESS",
        fileBase64: "base64data",
        extension: "png",
      });
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

      expect(output.processedFileData).toBe("base64data");
      expect(output.note).toBeUndefined();
    });

    it("should omit optional fields when not in response", async () => {
      const skyflow = createMockSkyflow({});
      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileOutput;

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

      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.error).toBe(true);
      expect(output.message).toBe("Vault not found");
      expect(output.code).toBe(404);
      expect(output.details).toBe("Details here");
    });

    it("should handle generic errors with message", async () => {
      mockDeidentifyFile.mockRejectedValue(new Error("Network timeout"));

      const skyflow = {
        detect: vi.fn(() => ({
          deidentifyFile: mockDeidentifyFile,
        })),
      };

      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.error).toBe(true);
      expect(output.message).toBe("Network timeout");
    });

    it("should handle non-Error thrown values", async () => {
      mockDeidentifyFile.mockRejectedValue("string error");

      const skyflow = {
        detect: vi.fn(() => ({
          deidentifyFile: mockDeidentifyFile,
        })),
      };

      const result = await handleDeIdentifyFile(baseArgs, skyflow as any, "vault123", false);
      const output = result.output as DeIdentifyFileErrorOutput;

      expect(result.isError).toBe(true);
      expect(output.message).toBe("Unknown error occurred");
    });
  });
});
