/** Entity info returned from the Skyflow deidentify API */
export interface EntityInfo {
  token?: string;
  value?: string;
  entity?: string;
  textIndex?: { start?: number; end?: number };
  processedIndex?: { start?: number; end?: number };
  scores?: Record<string, number>;
}

/** Output from the dehydrate tool handler */
export interface DehydrateOutput {
  [x: string]: unknown;
  inputText: string;
  processedText: string;
  wordCount: number;
  charCount: number;
  entities: EntityInfo[];
  anonymousMode?: boolean;
  note?: string;
}

/** Output from the rehydrate tool handler */
export interface RehydrateOutput {
  [x: string]: unknown;
  inputText: string;
  processedText: string;
}

/** Error output for tools that don't support anonymous mode */
export interface AnonymousModeError {
  [x: string]: unknown;
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

/** Output from the dehydrate_file tool handler */
export interface DehydrateFileOutput {
  [x: string]: unknown;
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
}

/** Error output from file deidentification */
export interface DehydrateFileErrorOutput {
  [x: string]: unknown;
  error: true | string;
  code?: number;
  message: string;
  details?: unknown;
}

/** Arguments for the dehydrate_file tool */
export interface DehydrateFileArgs {
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
