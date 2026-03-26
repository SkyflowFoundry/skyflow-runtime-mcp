/** Entity info returned from the Skyflow deidentify API */
export interface EntityInfo {
  token?: string;
  value?: string;
  entity?: string;
  textIndex?: { start?: number; end?: number };
  processedIndex?: { start?: number; end?: number };
  scores?: Record<string, number>;
}

/** Result from the dehydrate tool */
export interface DehydrateResult {
  inputText?: string;
  processedText?: string;
  wordCount?: number;
  charCount?: number;
  entities?: EntityInfo[];
  anonymousMode?: boolean;
  note?: string;
}

/** Result from the rehydrate tool */
export interface RehydrateResult {
  inputText?: string;
  processedText?: string;
  error?: string;
  message?: string;
  anonymousModeRestricted?: boolean;
}

/** Result from the dehydrate_file tool */
export interface DehydrateFileResult {
  inputFileName?: string;
  inputMimeType?: string;
  processedFileData?: string;
  mimeType?: string;
  extension?: string;
  detectedEntities?: Array<{ file: string; extension: string }>;
  wordCount?: number;
  charCount?: number;
  sizeInKb?: number;
  durationInSeconds?: number;
  pageCount?: number;
  slideCount?: number;
  runId?: string;
  status?: string;
  error?: string;
  message?: string;
  anonymousModeRestricted?: boolean;
}
