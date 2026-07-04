import {
  reidentifyFileRest,
  DetectRestError,
  type DetectRestContext,
} from "../detect/detectRest.js";
import { FileSourceError, resolveFileInput } from "../files/fileSource.js";
import { getEntityEnum } from "../mappings/entityMaps.js";
import {
  REIDENTIFY_FILE_FORMATS,
  isReidentifyFileFormat,
} from "../mappings/fileFormats.js";
import type {
  ReIdentifyFileArgs,
  ReIdentifyFileOutput,
  ReIdentifyFileErrorOutput,
  AnonymousModeError,
  ToolResult,
} from "./types.js";

/**
 * Handle the re-identify-file tool logic.
 * Restores original sensitive data in a previously de-identified file.
 * Accepts a signed/public URL or inline base64; the Skyflow endpoint is
 * synchronous and returns the processed file directly.
 */
export async function handleReIdentifyFile(
  args: ReIdentifyFileArgs,
  context: DetectRestContext,
  anonymousMode: boolean
): Promise<ToolResult<ReIdentifyFileOutput | AnonymousModeError | ReIdentifyFileErrorOutput>> {
  if (anonymousMode) {
    return {
      output: {
        error: "re-identify-file is not available in anonymous mode",
        anonymousModeRestricted: true,
        message:
          "The re-identify-file tool requires authenticated access to restore sensitive data from vault tokens. " +
          "To use this feature, configure your Skyflow credentials:\n\n" +
          "1. Get your API key from the Skyflow dashboard\n" +
          "2. Add via Authorization header: 'Bearer <api-key>'\n" +
          "   Or via query parameter: '?apiKey=<api-key>'",
        helpUrl: "https://docs.skyflow.com/",
      },
      isError: true,
    };
  }

  try {
    const {
      fileUrl,
      fileDataBase64,
      fileName,
      redactedEntities,
      maskedEntities,
      plainTextEntities,
    } = args;

    const resolved = await resolveFileInput({ fileUrl, fileDataBase64, fileName });

    if (!isReidentifyFileFormat(resolved.extension)) {
      return {
        output: {
          error: true,
          message:
            `Unsupported file format ".${resolved.extension}" for re-identification. ` +
            `Supported formats: ${REIDENTIFY_FILE_FORMATS.join(", ")}.`,
        },
        isError: true,
      };
    }

    // Validate entity names up front (throws on unknown entities)
    const format = {
      redacted: redactedEntities?.map((e) => getEntityEnum(e) as string),
      masked: maskedEntities?.map((e) => getEntityEnum(e) as string),
      plaintext: plainTextEntities?.map((e) => getEntityEnum(e) as string),
    };

    const result = await reidentifyFileRest(
      context,
      { base64: resolved.buffer.toString("base64"), dataFormat: resolved.extension },
      format
    );

    // Treat anything other than a SUCCESS that actually returned a file as an
    // error, so a SUCCESS-without-file response never looks like an empty win.
    if (result.status !== "SUCCESS" || !result.processedFile) {
      return {
        output: {
          error: true,
          message: `File re-identification did not complete (status: ${result.status}).`,
          details: { status: result.status },
        },
        isError: true,
      };
    }

    const output: ReIdentifyFileOutput = {
      inputFileName: resolved.fileName,
      status: result.status,
    };

    if (fileUrl) {
      output.inputFileUrl = fileUrl;
    }

    if (result.processedFile) {
      output.processedFileData = result.processedFile;
    }

    output.extension = result.processedFileExtension ?? resolved.extension;

    return { output };
  } catch (error) {
    if (error instanceof FileSourceError) {
      return {
        output: {
          error: true,
          message: error.message,
        },
        isError: true,
      };
    } else if (error instanceof DetectRestError) {
      return {
        output: {
          error: true,
          code: error.httpCode,
          message: error.message,
          details: error.details,
        },
        isError: true,
      };
    }
    return {
      output: {
        error: true,
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      isError: true,
    };
  }
}
