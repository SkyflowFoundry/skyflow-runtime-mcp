import { describe, it, expect, vi, afterEach } from "vitest";
import { handleReIdentifyFile } from "../../../src/lib/tools/reIdentifyFile";
import type { DetectRestContext } from "../../../src/lib/detect/detectRest";
import type {
  ReIdentifyFileOutput,
  ReIdentifyFileErrorOutput,
} from "../../../src/lib/tools/types";

const context: DetectRestContext = {
  vaultUrl: "https://cluster123.vault.skyflowapis.com",
  vaultId: "vault123",
  credentialKey: "test-api-key",
};

const baseArgs = {
  fileDataBase64: Buffer.from("Hello [NAME_1]!").toString("base64"),
  fileName: "notes.txt",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const successBody = {
  status: "SUCCESS",
  output_type: "BASE64",
  output: {
    processed_file: Buffer.from("Hello John!").toString("base64"),
    processed_file_type: "reidentified_file",
    processed_file_extension: "txt",
  },
};

describe("handleReIdentifyFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns error with anonymousModeRestricted flag in anonymous mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleReIdentifyFile(baseArgs, context, true);

    expect(result.isError).toBe(true);
    expect(result.output).toHaveProperty("anonymousModeRestricted", true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the file to the reidentify endpoint with snake_case body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(successBody));
    vi.stubGlobal("fetch", fetchMock);

    await handleReIdentifyFile(baseArgs, context, false);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://cluster123.vault.skyflowapis.com/v1/detect/reidentify/file");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");

    const body = JSON.parse(init.body as string);
    expect(body.vault_id).toBe("vault123");
    expect(body.file.base64).toBe(baseArgs.fileDataBase64);
    expect(body.file.data_format).toBe("txt");
    expect(body.format).toBeUndefined();
  });

  it("includes the entity format routing when provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(successBody));
    vi.stubGlobal("fetch", fetchMock);

    await handleReIdentifyFile(
      {
        ...baseArgs,
        redactedEntities: ["ssn"],
        maskedEntities: ["email_address"],
        plainTextEntities: ["name"],
      },
      context,
      false
    );

    const body = JSON.parse((vi.mocked(fetchMock).mock.calls[0][1] as RequestInit).body as string);
    expect(body.format.redacted).toEqual(["ssn"]);
    expect(body.format.masked).toEqual(["email_address"]);
    expect(body.format.plaintext).toEqual(["name"]);
  });

  it("returns the processed file on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(successBody)));

    const result = await handleReIdentifyFile(baseArgs, context, false);
    const output = result.output as ReIdentifyFileOutput;

    expect(result.isError).toBeUndefined();
    expect(output.status).toBe("SUCCESS");
    expect(output.inputFileName).toBe("notes.txt");
    expect(output.extension).toBe("txt");
    expect(Buffer.from(output.processedFileData!, "base64").toString()).toBe("Hello John!");
  });

  it("parses camelCase responses as well", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "SUCCESS",
          outputType: "BASE64",
          output: {
            processedFile: Buffer.from("hi").toString("base64"),
            processedFileType: "reidentified_file",
            processedFileExtension: "csv",
          },
        })
      )
    );

    const result = await handleReIdentifyFile(
      { ...baseArgs, fileName: "data.csv" },
      context,
      false
    );
    const output = result.output as ReIdentifyFileOutput;

    expect(output.extension).toBe("csv");
    expect(output.processedFileData).toBe(Buffer.from("hi").toString("base64"));
  });

  it("downloads the file when a fileUrl is provided", async () => {
    const fileContent = Buffer.from("Tokenized [SSN_1]");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("storage.example.com")) {
        return new Response(fileContent, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return jsonResponse(successBody);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleReIdentifyFile(
      { fileUrl: "https://storage.example.com/docs/tokenized.txt?sig=1" },
      context,
      false
    );
    const output = result.output as ReIdentifyFileOutput;

    expect(result.isError).toBeUndefined();
    expect(output.inputFileName).toBe("tokenized.txt");
    expect(output.inputFileUrl).toBe("https://storage.example.com/docs/tokenized.txt?sig=1");

    const reidentifyCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/v1/detect/reidentify/file")
    );
    const body = JSON.parse((reidentifyCall![1] as RequestInit).body as string);
    expect(body.file.base64).toBe(fileContent.toString("base64"));
  });

  it("rejects unsupported formats for re-identification", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleReIdentifyFile(
      { ...baseArgs, fileName: "image.png" },
      context,
      false
    );
    const output = result.output as ReIdentifyFileErrorOutput;

    expect(result.isError).toBe(true);
    expect(output.message).toContain('".png"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors when input is missing", async () => {
    const result = await handleReIdentifyFile({}, context, false);

    expect(result.isError).toBe(true);
    expect((result.output as ReIdentifyFileErrorOutput).message).toContain("fileUrl");
  });

  it("returns isError for FAILED responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "FAILED", output: {} }))
    );

    const result = await handleReIdentifyFile(baseArgs, context, false);
    const output = result.output as ReIdentifyFileErrorOutput;

    expect(result.isError).toBe(true);
    expect(output.message).toContain("FAILED");
  });

  it("returns isError for a SUCCESS response that omits the processed file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "SUCCESS", output: {} }))
    );

    const result = await handleReIdentifyFile(baseArgs, context, false);
    const output = result.output as ReIdentifyFileErrorOutput;

    expect(result.isError).toBe(true);
    expect(output.message).toContain("did not complete");
  });

  it("maps HTTP errors from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "invalid vault" } }, 400))
    );

    const result = await handleReIdentifyFile(baseArgs, context, false);
    const output = result.output as ReIdentifyFileErrorOutput;

    expect(result.isError).toBe(true);
    expect(output.code).toBe(400);
    expect(output.message).toBe("invalid vault");
  });

  it("rejects invalid entity names before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleReIdentifyFile(
      { ...baseArgs, plainTextEntities: ["not_a_real_entity"] },
      context,
      false
    );

    expect(result.isError).toBe(true);
    expect((result.output as ReIdentifyFileErrorOutput).message).toContain("Invalid entity type");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
