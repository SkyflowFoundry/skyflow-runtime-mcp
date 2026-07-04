import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGetFileRunStatus } from "../../../src/lib/tools/getFileRunStatus";
import type { DetectRestContext } from "../../../src/lib/detect/detectRest";
import type {
  DeIdentifyFileOutput,
  GetFileRunStatusErrorOutput,
} from "../../../src/lib/tools/types";

const context: DetectRestContext = {
  vaultUrl: "https://cluster123.vault.skyflowapis.com",
  vaultId: "vault123",
  credentialKey: "test-api-key",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("handleGetFileRunStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns error with anonymousModeRestricted flag in anonymous mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleGetFileRunStatus({ runId: "run1" }, context, true);

    expect(result.isError).toBe(true);
    expect(result.output).toHaveProperty("anonymousModeRestricted", true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the runs endpoint with the runId and vault_id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: "SUCCESS", output: [] })
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleGetFileRunStatus({ runId: "run abc" }, context, false);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(
      "https://cluster123.vault.skyflowapis.com/v1/detect/runs/run%20abc?vault_id=vault123"
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");
  });

  it("maps a successful camelCase run response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "SUCCESS",
          outputType: "BASE64",
          output: [
            {
              processedFile: "cHJvY2Vzc2Vk",
              processedFileType: "redacted_file",
              processedFileExtension: "pdf",
            },
            {
              processedFile: "ZW50aXR5",
              processedFileType: "entities",
              processedFileExtension: "png",
            },
          ],
          wordCharacterCount: { wordCount: 12, characterCount: 80 },
          size: 42,
          pages: 3,
        })
      )
    );

    const result = await handleGetFileRunStatus({ runId: "run1" }, context, false);
    const output = result.output as DeIdentifyFileOutput;

    expect(result.isError).toBeUndefined();
    expect(output.runId).toBe("run1");
    expect(output.status).toBe("SUCCESS");
    expect(output.processedFileData).toBe("cHJvY2Vzc2Vk");
    expect(output.extension).toBe("pdf");
    expect(output.detectedEntities).toEqual([{ file: "ZW50aXR5", extension: "png" }]);
    expect(output.wordCount).toBe(12);
    expect(output.charCount).toBe(80);
    expect(output.sizeInKb).toBe(42);
    expect(output.pageCount).toBe(3);
  });

  it("maps a successful snake_case run response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "SUCCESS",
          output_type: "BASE64",
          output: [
            {
              processed_file: "cHJvY2Vzc2Vk",
              processed_file_type: "redacted_file",
              processed_file_extension: "txt",
            },
          ],
          word_count: 5,
          character_count: 25,
        })
      )
    );

    const result = await handleGetFileRunStatus({ runId: "run1" }, context, false);
    const output = result.output as DeIdentifyFileOutput;

    expect(output.processedFileData).toBe("cHJvY2Vzc2Vk");
    expect(output.extension).toBe("txt");
    expect(output.wordCount).toBe(5);
    expect(output.charCount).toBe(25);
  });

  it("derives a real mimeType from the processed file extension", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "SUCCESS",
          output: [
            { processedFile: "eA==", processedFileType: "redacted_file", processedFileExtension: "png" },
          ],
        })
      )
    );

    const result = await handleGetFileRunStatus({ runId: "run1" }, context, false);
    const output = result.output as DeIdentifyFileOutput;

    expect(output.extension).toBe("png");
    expect(output.mimeType).toBe("image/png"); // not the "redacted_file" category label
  });

  it("returns runId with polling note for in-progress runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "IN_PROGRESS", output: [] }))
    );

    const result = await handleGetFileRunStatus({ runId: "run1" }, context, false);
    const output = result.output as DeIdentifyFileOutput;

    expect(result.isError).toBeUndefined();
    expect(output.status).toBe("IN_PROGRESS");
    expect(output.note).toContain("get-file-run-status");
  });

  it("attaches a polling note for non-terminal/unknown statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "UNKNOWN", output: [] }))
    );

    const result = await handleGetFileRunStatus({ runId: "run1" }, context, false);
    const output = result.output as DeIdentifyFileOutput;

    expect(result.isError).toBeUndefined();
    expect(output.status).toBe("UNKNOWN");
    expect(output.note).toContain("get-file-run-status");
  });

  it("polls until success when waitSeconds is set", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          call += 1;
          return call < 3
            ? jsonResponse({ status: "IN_PROGRESS", output: [] })
            : jsonResponse({
                status: "SUCCESS",
                output: [{ processedFile: "ZG9uZQ==", processedFileType: "redacted_file" }],
              });
        })
      );

      const promise = handleGetFileRunStatus(
        { runId: "run1", waitSeconds: 30 },
        context,
        false
      );
      // Walk through the 2s and 4s backoff sleeps
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      const output = result.output as DeIdentifyFileOutput;

      expect(call).toBe(3);
      expect(output.status).toBe("SUCCESS");
      expect(output.processedFileData).toBe("ZG9uZQ==");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns isError with the Skyflow message for failed runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "FAILED", message: "Unsupported file contents", output: [] })
      )
    );

    const result = await handleGetFileRunStatus({ runId: "run1" }, context, false);
    const output = result.output as GetFileRunStatusErrorOutput;

    expect(result.isError).toBe(true);
    expect(output.message).toContain("Unsupported file contents");
    expect(output.message).toContain("run1");
  });

  it("maps HTTP errors from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "run not found" } }, 404)
      )
    );

    const result = await handleGetFileRunStatus({ runId: "missing" }, context, false);
    const output = result.output as GetFileRunStatusErrorOutput;

    expect(result.isError).toBe(true);
    expect(output.code).toBe(404);
    expect(output.message).toBe("run not found");
  });

  it("wraps network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("socket hang up"))));

    const result = await handleGetFileRunStatus({ runId: "run1" }, context, false);
    const output = result.output as GetFileRunStatusErrorOutput;

    expect(result.isError).toBe(true);
    expect(output.message).toContain("socket hang up");
  });
});
