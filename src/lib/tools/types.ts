/** Entity info returned from the Skyflow deidentify API */
export interface EntityInfo {
  token?: string;
  value?: string;
  entity?: string;
  textIndex?: { start?: number; end?: number };
  processedIndex?: { start?: number; end?: number };
  scores?: Record<string, number>;
}

/** Output from the de-identify tool handler */
export interface DeIdentifyOutput {
  inputText: string;
  processedText: string;
  wordCount: number;
  charCount: number;
  entities: EntityInfo[];
  anonymousMode?: boolean;
  note?: string;
}

/**
 * Per-entity-type formatting for re-identification.
 * Mirrors the Skyflow Detect API `format` object: each entity type listed is
 * rendered according to its bucket. Entity types not listed in any bucket
 * default to `plaintext` (full re-identification).
 */
export interface ReIdentifyFormat {
  /** Entity types to fully redact (original value completely hidden). */
  redacted?: string[];
  /** Entity types to partially mask (only part of the original value revealed). */
  masked?: string[];
  /** Entity types to fully restore to their original plaintext value. */
  plaintext?: string[];
}

/** Output from the re-identify tool handler */
export interface ReIdentifyOutput {
  inputText: string;
  processedText: string;
  /** The re-identification format the caller requested (normalized), echoed back when provided. */
  format?: ReIdentifyFormat;
}

/** Error output for tools that don't support anonymous mode */
export interface AnonymousModeError {
  error: string;
  anonymousModeRestricted: true;
  message: string;
  helpUrl: string;
  alternativeTool?: string;
}

/** Detected entity item from file deidentification */
export interface DetectedEntityItem {
  file: string;
  extension: string;
}

/** Output from the de-identify-file and get-file-run-status tool handlers */
export interface DeIdentifyFileOutput {
  inputFileName?: string;
  inputFileUrl?: string;
  inputMimeType?: string;
  processedFileData?: string;
  mimeType?: string;
  extension?: string;
  detectedEntities?: Array<{
    file: string;
    extension: string;
  }>;
  wordCount?: number;
  charCount?: number;
  sizeInKb?: number;
  durationInSeconds?: number;
  pageCount?: number;
  slideCount?: number;
  runId?: string;
  status?: string;
  message?: string;
  note?: string;
  warnings?: string[];
}

/** Shared error output for all tools */
export interface ToolErrorOutput {
  error: true | string;
  code?: number;
  message: string;
  details?: unknown;
}

export type DeIdentifyErrorOutput = ToolErrorOutput;
export type ReIdentifyErrorOutput = ToolErrorOutput;
export type DeIdentifyFileErrorOutput = ToolErrorOutput;
export type GetFileRunStatusErrorOutput = ToolErrorOutput;
export type ReIdentifyFileErrorOutput = ToolErrorOutput;

/** Date-shifting transformation options for de-identification */
export interface DateShiftArgs {
  minDays: number;
  maxDays: number;
  entities: string[];
}

/** Audio bleep options for de-identification of audio files */
export interface BleepArgs {
  gain?: number;
  frequency?: number;
  startPadding?: number;
  stopPadding?: number;
}

/** Arguments for the de-identify-file tool */
export interface DeIdentifyFileArgs {
  fileUrl?: string;
  fileDataBase64?: string;
  fileName?: string;
  mimeType?: string;
  entities?: string[];
  allowRegexList?: string[];
  restrictRegexList?: string[];
  tokenType?: string;
  maskingMethod?: string;
  outputProcessedFile?: boolean;
  outputOcrText?: boolean;
  outputTranscription?: string;
  pixelDensity?: number;
  maxResolution?: number;
  dateShift?: DateShiftArgs;
  bleep?: BleepArgs;
  waitTimeSeconds?: number;
}

/** Arguments for the get-file-run-status tool */
export interface GetFileRunStatusArgs {
  runId: string;
  waitSeconds?: number;
}

/** Arguments for the re-identify-file tool */
export interface ReIdentifyFileArgs {
  fileUrl?: string;
  fileDataBase64?: string;
  fileName?: string;
  redactedEntities?: string[];
  maskedEntities?: string[];
  plainTextEntities?: string[];
}

/** Output from the re-identify-file tool handler */
export interface ReIdentifyFileOutput {
  inputFileName?: string;
  inputFileUrl?: string;
  processedFileData?: string;
  extension?: string;
  status?: string;
}

/** Result wrapper for tool handlers that can return errors */
export interface ToolResult<T> {
  output: T;
  isError?: boolean;
}

/**
 * Converts a typed tool output to the `structuredContent` format expected by the MCP SDK.
 * Centralizes the cast from specific output types to `Record<string, unknown>`.
 */
export function toStructuredContent(output: object): Record<string, unknown> {
  return output as Record<string, unknown>;
}

/**
 * Build an MCP tool result for file tools whose output can contain multi-MB
 * base64 payloads. The full output is returned as `structuredContent`; the
 * text `content` channel gets a compact view with the large base64 blobs
 * replaced by placeholders, so the payload isn't serialized and shipped twice.
 */
export function toFileToolResult(result: ToolResult<object>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
} {
  const output = result.output as Record<string, unknown>;
  const textView: Record<string, unknown> = { ...output };

  if (typeof textView.processedFileData === "string") {
    textView.processedFileData = `[${textView.processedFileData.length} base64 chars omitted; see structuredContent]`;
  }
  if (Array.isArray(textView.detectedEntities)) {
    textView.detectedEntities = `[${textView.detectedEntities.length} detected entity artifact(s); see structuredContent]`;
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(textView) }],
    structuredContent: output,
    ...(result.isError ? { isError: true } : {}),
  };
}
