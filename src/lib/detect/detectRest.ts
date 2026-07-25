/**
 * Minimal REST client for the Skyflow Detect endpoints that skyflow-node does
 * not expose through its high-level API:
 *
 *   - GET  /v1/detect/runs/{run_id}      (async de-identify run status/result)
 *   - POST /v1/detect/reidentify/file    (synchronous file re-identification)
 *
 * Requests use the same credential the SDK would send: the bearer value from
 * the Authorization header or the API key, both forwarded as
 * `Authorization: Bearer <value>`.
 *
 * NOTE on response casing: Skyflow's generated OpenAPI types describe these
 * responses in snake_case, but the live API returns camelCase for several
 * fields (the official SDKs read both). Parsers here accept either casing.
 */

/** Context needed to call the Detect REST API for the current request. */
export interface DetectRestContext {
  /** Vault base URL, e.g. https://abc123.vault.skyflowapis.com */
  vaultUrl: string;
  vaultId: string;
  /** Bearer value: the caller's JWT or API key. Never log this. */
  credentialKey: string;
}

/** Error carrying HTTP status + response payload from the Detect API. */
export class DetectRestError extends Error {
  httpCode?: number;
  details?: unknown;

  constructor(message: string, httpCode?: number, details?: unknown) {
    super(message);
    this.name = "DetectRestError";
    this.httpCode = httpCode;
    this.details = details;
  }
}

/** One output artifact from a detect run (processed file or entity crop). */
export interface DetectRunOutputItem {
  processedFile?: string;
  processedFileType?: string;
  processedFileExtension?: string;
}

/** Parsed response from GET /v1/detect/runs/{run_id}. */
export interface DetectRunResult {
  status: string;
  message?: string;
  output: DetectRunOutputItem[];
  outputType?: string;
  wordCount?: number;
  charCount?: number;
  sizeInKb?: number;
  durationInSeconds?: number;
  pageCount?: number;
  slideCount?: number;
}

/** Parsed response from POST /v1/detect/reidentify/file. */
export interface ReidentifyFileResult {
  status: string;
  outputType?: string;
  processedFile?: string;
  processedFileType?: string;
  processedFileExtension?: string;
}

const REQUEST_TIMEOUT_MS = 65_000;

// Returns the first present (non-null/undefined) value among the given keys,
// tolerating both camelCase and snake_case API responses. Note: a numeric 0 is
// "present" and returned as-is; the tools decide downstream whether to surface a
// zero count (they omit zeros — see toOutput / handleDeIdentifyFile).
function pick<T>(record: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      return value as T;
    }
  }
  return undefined;
}

async function detectFetch(
  context: DetectRestContext,
  path: string,
  init: { method: string; body?: unknown }
): Promise<Record<string, unknown>> {
  // The bearer credential is the caller's own and is only ever sent to the
  // caller-specified vault URL (validated per request, same vault the SDK path
  // targets) — never to a host derived from user-supplied file input.
  const baseUrl = context.vaultUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let payload: unknown;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${context.credentialKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    // Read the body inside the try so the timeout still covers a stalled body.
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : "unknown network error";
    throw new DetectRestError(`Skyflow API request failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorBody = payload as {
      error?: { message?: string; details?: unknown };
      message?: string;
    };
    const message =
      errorBody?.error?.message ??
      errorBody?.message ??
      `Skyflow API returned HTTP ${response.status}`;
    throw new DetectRestError(message, response.status, errorBody?.error?.details ?? payload);
  }

  return (payload ?? {}) as Record<string, unknown>;
}

function parseOutputItems(rawOutput: unknown): DetectRunOutputItem[] {
  if (!Array.isArray(rawOutput)) return [];
  return rawOutput.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return {
      processedFile: pick<string>(record, "processedFile", "processed_file"),
      processedFileType: pick<string>(record, "processedFileType", "processed_file_type"),
      processedFileExtension: pick<string>(
        record,
        "processedFileExtension",
        "processed_file_extension"
      ),
    };
  });
}

/** Fetch the current status/result of an async de-identify file run. */
export async function getDetectRunRest(
  context: DetectRestContext,
  runId: string
): Promise<DetectRunResult> {
  const query = new URLSearchParams({ vault_id: context.vaultId });
  const data = await detectFetch(
    context,
    `/v1/detect/runs/${encodeURIComponent(runId)}?${query.toString()}`,
    { method: "GET" }
  );

  const wordCharacterCount = pick<Record<string, unknown>>(
    data,
    "wordCharacterCount",
    "word_character_count"
  );

  return {
    status: (pick<string>(data, "status") ?? "UNKNOWN").toUpperCase(),
    message: pick<string>(data, "message"),
    output: parseOutputItems(data.output),
    outputType: pick<string>(data, "outputType", "output_type"),
    wordCount:
      pick<number>(data, "wordCount", "word_count") ??
      (wordCharacterCount
        ? pick<number>(wordCharacterCount, "wordCount", "word_count")
        : undefined),
    charCount:
      pick<number>(data, "characterCount", "character_count") ??
      (wordCharacterCount
        ? pick<number>(wordCharacterCount, "characterCount", "character_count")
        : undefined),
    sizeInKb: pick<number>(data, "size"),
    durationInSeconds: pick<number>(data, "duration"),
    pageCount: pick<number>(data, "pages"),
    slideCount: pick<number>(data, "slides"),
  };
}

/** Entity format routing for re-identification. */
export interface ReidentifyFormat {
  redacted?: string[];
  masked?: string[];
  plaintext?: string[];
}

/** Re-identify a previously de-identified file (synchronous endpoint). */
export async function reidentifyFileRest(
  context: DetectRestContext,
  file: { base64: string; dataFormat: string },
  format?: ReidentifyFormat
): Promise<ReidentifyFileResult> {
  const body: Record<string, unknown> = {
    vault_id: context.vaultId,
    file: {
      base64: file.base64,
      data_format: file.dataFormat,
    },
  };

  if (format && (format.redacted?.length || format.masked?.length || format.plaintext?.length)) {
    body.format = {
      ...(format.redacted?.length ? { redacted: format.redacted } : {}),
      ...(format.masked?.length ? { masked: format.masked } : {}),
      ...(format.plaintext?.length ? { plaintext: format.plaintext } : {}),
    };
  }

  const data = await detectFetch(context, "/v1/detect/reidentify/file", {
    method: "POST",
    body,
  });

  const output = (pick<Record<string, unknown>>(data, "output") ?? {}) as Record<
    string,
    unknown
  >;

  return {
    status: (pick<string>(data, "status") ?? "UNKNOWN").toUpperCase(),
    outputType: pick<string>(data, "outputType", "output_type"),
    processedFile: pick<string>(output, "processedFile", "processed_file"),
    processedFileType: pick<string>(output, "processedFileType", "processed_file_type"),
    processedFileExtension: pick<string>(
      output,
      "processedFileExtension",
      "processed_file_extension"
    ),
  };
}
