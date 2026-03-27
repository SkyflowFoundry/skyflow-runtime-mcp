/** Entity info returned from the Skyflow deidentify API */
export interface EntityInfo {
  token?: string;
  value?: string;
  entity?: string;
  textIndex?: { start?: number; end?: number };
  processedIndex?: { start?: number; end?: number };
  scores?: Record<string, number>;
}

/** Result from the de-identify tool */
export interface DeIdentifyResult {
  inputText?: string;
  processedText?: string;
  wordCount?: number;
  charCount?: number;
  entities?: EntityInfo[];
  anonymousMode?: boolean;
  note?: string;
}

/** Result from the re-identify tool */
export interface ReIdentifyResult {
  inputText?: string;
  processedText?: string;
  error?: string;
  message?: string;
  anonymousModeRestricted?: boolean;
}

/** Result from the de-identify_file tool */
export interface DeIdentifyFileResult {
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
