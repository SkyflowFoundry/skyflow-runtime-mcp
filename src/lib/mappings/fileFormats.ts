/**
 * File format support for Skyflow Detect file endpoints.
 *
 * The Skyflow API routes files to type-specific endpoints based on the file
 * extension (data_format). These lists mirror the generated REST API enums in
 * skyflow-node and are used for upfront validation so callers get a clear
 * error instead of a Skyflow 400.
 */

/** Formats accepted by the de-identify file endpoints (all types combined). */
export const DEIDENTIFY_FILE_FORMATS = [
  "bmp",
  "csv",
  "dcm",
  "doc",
  "docx",
  "jpeg",
  "jpg",
  "json",
  "mp3",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "tif",
  "tiff",
  "txt",
  "wav",
  "xls",
  "xlsx",
  "xml",
] as const;

/** Formats accepted by the re-identify file endpoint. */
export const REIDENTIFY_FILE_FORMATS = [
  "csv",
  "doc",
  "docx",
  "json",
  "txt",
  "xls",
  "xlsx",
  "xml",
] as const;

export type DeidentifyFileFormat = (typeof DEIDENTIFY_FILE_FORMATS)[number];
export type ReidentifyFileFormat = (typeof REIDENTIFY_FILE_FORMATS)[number];

/** Image formats — support maskingMethod, outputProcessedFile, outputOcrText. */
export const IMAGE_FORMATS: ReadonlySet<string> = new Set([
  "bmp",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
]);

/** Audio formats — support outputProcessedFile, outputTranscription, bleep. */
export const AUDIO_FORMATS: ReadonlySet<string> = new Set(["mp3", "wav"]);

/**
 * Common MIME type → file extension fallbacks, used when a downloaded file's
 * URL and Content-Disposition don't reveal a usable file name.
 */
const MIME_EXTENSION_MAP: Record<string, string> = {
  "application/json": "json",
  "application/msword": "doc",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/xml": "xml",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "image/bmp": "bmp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/xml": "xml",
};

/** Look up a file extension for a MIME type (parameters stripped, lowercased). */
export function extensionFromMimeType(mimeType: string): string | undefined {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  return MIME_EXTENSION_MAP[normalized];
}

/**
 * File extension → canonical MIME type, used to give processed-file outputs a
 * real MIME type (the Skyflow SDK reports a category label like "redacted_image"
 * in its `type` field, not a MIME type).
 */
const EXTENSION_MIME_MAP: Record<string, string> = {
  bmp: "image/bmp",
  csv: "text/csv",
  dcm: "application/dicom",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  mp3: "audio/mpeg",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  wav: "audio/wav",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
};

/** Look up a canonical MIME type for a file extension. */
export function mimeTypeFromExtension(extension: string): string | undefined {
  return EXTENSION_MIME_MAP[extension.toLowerCase()];
}

/**
 * Formats for which the Skyflow SDK actually serializes `transformations`
 * (date shifting). The SDK's per-type request builders omit transformations
 * for image, PDF, Word document, spreadsheet, and presentation requests, so
 * dateShift is silently ignored there — callers should be warned instead.
 */
export const TRANSFORMATION_SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  "txt",
  "json",
  "xml",
  "mp3",
  "wav",
  "dcm",
]);

/** Extract the lowercased extension from a file name, or undefined if none. */
export function extensionFromFileName(fileName: string): string | undefined {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return undefined;
  }
  return fileName.slice(dotIndex + 1).toLowerCase();
}

export function isDeidentifyFileFormat(
  extension: string
): extension is DeidentifyFileFormat {
  return (DEIDENTIFY_FILE_FORMATS as readonly string[]).includes(extension);
}

export function isReidentifyFileFormat(
  extension: string
): extension is ReidentifyFileFormat {
  return (REIDENTIFY_FILE_FORMATS as readonly string[]).includes(extension);
}
