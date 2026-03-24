import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleRehydrate } from "../../../src/lib/tools/rehydrate";
import type { RehydrateOutput, AnonymousModeError } from "../../../src/lib/tools/types";

// Mock the skyflow-node SDK
const mockReidentifyText = vi.fn();

vi.mock("skyflow-node", () => ({
  ReidentifyTextRequest: vi.fn(function (this: any, input: string) { this.input = input; }),
}));

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
});
