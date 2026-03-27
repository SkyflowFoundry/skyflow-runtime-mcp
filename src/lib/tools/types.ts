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

/** Output from the re-identify tool handler */
export interface ReIdentifyOutput {
  inputText: string;
  processedText: string;
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

/** Output from the de-identify_file tool handler */
export interface DeIdentifyFileOutput {
  inputFileName?: string;
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

/** Arguments for the de-identify_file tool */
export interface DeIdentifyFileArgs {
  fileData: string;
  fileName: string;
  mimeType?: string;
  entities?: string[];
  maskingMethod?: string;
  outputProcessedFile?: boolean;
  outputOcrText?: boolean;
  outputTranscription?: string;
  pixelDensity?: number;
  maxResolution?: number;
  waitTime?: number;
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
