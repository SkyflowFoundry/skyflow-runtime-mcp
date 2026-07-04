import {
  Bleep,
  DeidentifyFileOptions,
  DeidentifyFileRequest,
  SkyflowError,
  TokenFormat,
  TokenType,
  Transformations,
} from "skyflow-node";
import type { Skyflow, FileInput } from "skyflow-node";
import {
  getEntityEnum,
  getMaskingMethodEnum,
  getTranscriptionEnum,
} from "../mappings/entityMaps.js";
import {
  AUDIO_FORMATS,
  DEIDENTIFY_FILE_FORMATS,
  IMAGE_FORMATS,
  TRANSFORMATION_SUPPORTED_FORMATS,
  isDeidentifyFileFormat,
  mimeTypeFromExtension,
} from "../mappings/fileFormats.js";
import { FileSourceError, resolveFileInput } from "../files/fileSource.js";
import type {
  DeIdentifyFileArgs,
  DeIdentifyFileOutput,
  DeIdentifyFileErrorOutput,
  AnonymousModeError,
  DetectedEntityItem,
  ToolResult,
} from "./types.js";

/**
 * Default bounded wait for the initial de-identification call. Small files
 * usually finish within this window; larger ones return a runId to poll via
 * the get-file-run-status tool.
 */
export const DEFAULT_WAIT_TIME_SECONDS = 25;

/** Maximum wait the Skyflow SDK allows for a single de-identify file call. */
export const MAX_WAIT_TIME_SECONDS = 64;

/** Note attached to responses for runs that are still processing. */
export function stillProcessingNote(runId: string): string {
  return (
    `File de-identification is still processing (runId: ${runId}). ` +
    `Call the get-file-run-status tool with this runId to check progress and retrieve the result. ` +
    `Pass waitSeconds (e.g. 30) to wait server-side for completion.`
  );
}

/**
 * Note attached when a run completed successfully but produced no processed
 * file or detected entities (e.g. no file-producing output option was
 * requested). Shared by de-identify-file and get-file-run-status so both tools
 * explain an empty-but-successful result the same way.
 */
export function completedWithoutArtifactNote(runId?: string): string {
  const subject = runId ? `Run ${runId}` : "The run";
  return (
    `${subject} completed successfully but returned no processed file or detected entities. ` +
    `This can happen when no file-producing output option was requested.`
  );
}

/** Token type strings supported by the file endpoints (vault tokens are text-only). */
const FILE_TOKEN_TYPE_MAP: Record<string, TokenType> = {
  entity_unique_counter: TokenType.ENTITY_UNIQUE_COUNTER,
  entity_only: TokenType.ENTITY_ONLY,
};

export const FILE_TOKEN_TYPE_KEYS = Object.keys(FILE_TOKEN_TYPE_MAP) as [
  string,
  ...string[],
];

/**
 * Handle the de-identify-file tool logic.
 * Accepts a file as a signed/public URL or inline base64, forwards it to
 * Skyflow Detect (which requires base64), and waits a bounded amount of time
 * for the asynchronous run to finish before handing back a runId to poll.
 */
export async function handleDeIdentifyFile(
  args: DeIdentifyFileArgs,
  skyflow: Skyflow,
  vaultId: string,
  anonymousMode: boolean
): Promise<ToolResult<DeIdentifyFileOutput | AnonymousModeError | DeIdentifyFileErrorOutput>> {
  if (anonymousMode) {
    return {
      output: {
        error: "de-identify-file is not available in anonymous mode",
        anonymousModeRestricted: true,
        message:
          "File deidentification requires authenticated access for secure processing. " +
          "To use this feature, configure your Skyflow credentials:\n\n" +
          "1. Get your API key from the Skyflow dashboard\n" +
          "2. Add via Authorization header: 'Bearer <api-key>'\n" +
          "   Or via query parameter: '?apiKey=<api-key>'\n\n" +
          "For text-only deidentification, you can use the 'de-identify' tool in anonymous mode.",
        helpUrl: "https://docs.skyflow.com/",
        alternativeTool: "de-identify",
      },
      isError: true,
    };
  }

  try {
    const {
      fileUrl,
      fileDataBase64,
      fileName,
      mimeType,
      entities,
      allowRegexList,
      restrictRegexList,
      tokenType,
      maskingMethod,
      outputProcessedFile,
      outputOcrText,
      outputTranscription,
      pixelDensity,
      maxResolution,
      dateShift,
      bleep,
      waitTimeSeconds,
    } = args;

    // Validate entity args up front (getEntityEnum throws on unknown entities)
    // so an invalid entity fails fast, before any file download.
    const entityEnums =
      entities && entities.length > 0 ? entities.map((e) => getEntityEnum(e)) : undefined;
    const dateShiftEntityEnums = dateShift
      ? dateShift.entities.map((e) => getEntityEnum(e))
      : undefined;

    // Resolve URL or base64 input into the base64 payload Skyflow requires
    const resolved = await resolveFileInput({ fileUrl, fileDataBase64, fileName });

    if (!isDeidentifyFileFormat(resolved.extension)) {
      return {
        output: {
          error: true,
          message:
            `Unsupported file format ".${resolved.extension}". ` +
            `Supported formats: ${DEIDENTIFY_FILE_FORMATS.join(", ")}.`,
        },
        isError: true,
      };
    }

    // The SDK routes to type-specific endpoints by extension, so give the File
    // a name ending in the resolved lowercase extension the router recognizes.
    const baseName = resolved.fileName.includes(".")
      ? resolved.fileName.slice(0, resolved.fileName.lastIndexOf("."))
      : resolved.fileName;
    const normalizedName = `${baseName}.${resolved.extension}`;
    const effectiveMimeType = mimeType ?? resolved.contentType;
    const file = new File([resolved.buffer], normalizedName, {
      type: effectiveMimeType,
    });

    const fileInput: FileInput = { file: file };
    const fileReq = new DeidentifyFileRequest(fileInput);

    // Configure DeidentifyFileOptions
    const options = new DeidentifyFileOptions();

    // Set entities if provided (validated above)
    if (entityEnums) {
      options.setEntities(entityEnums);
    }

    if (allowRegexList && allowRegexList.length > 0) {
      options.setAllowRegexList(allowRegexList);
    }

    if (restrictRegexList && restrictRegexList.length > 0) {
      options.setRestrictRegexList(restrictRegexList);
    }

    if (tokenType) {
      const tokenTypeEnum = FILE_TOKEN_TYPE_MAP[tokenType];
      if (!tokenTypeEnum) {
        return {
          output: {
            error: true,
            message: `Invalid tokenType "${tokenType}". Supported values: ${FILE_TOKEN_TYPE_KEYS.join(", ")}.`,
          },
          isError: true,
        };
      }
      const tokenFormat = new TokenFormat();
      tokenFormat.setDefault(tokenTypeEnum);
      options.setTokenFormat(tokenFormat);
    }

    // Set masking method for images - use type-safe mapping
    if (maskingMethod) {
      options.setMaskingMethod(getMaskingMethodEnum(maskingMethod));
    }

    // Set output options; processed-file output is only supported for images and audio
    const warnings: string[] = [];
    const isImage = IMAGE_FORMATS.has(resolved.extension);
    const isAudio = AUDIO_FORMATS.has(resolved.extension);
    if (outputProcessedFile !== undefined) {
      if (isImage) {
        options.setOutputProcessedImage(outputProcessedFile);
      } else if (isAudio) {
        options.setOutputProcessedAudio(outputProcessedFile);
      } else {
        warnings.push(
          `outputProcessedFile is not yet supported for .${resolved.extension} files. It currently only applies to image and audio formats.`
        );
      }
    }

    if (outputOcrText) {
      options.setOutputOcrText(outputOcrText);
    }

    if (outputTranscription) {
      options.setOutputTranscription(getTranscriptionEnum(outputTranscription));
    }

    if (pixelDensity) {
      options.setPixelDensity(pixelDensity);
    }

    if (maxResolution) {
      options.setMaxResolution(maxResolution);
    }

    if (dateShift) {
      if (TRANSFORMATION_SUPPORTED_FORMATS.has(resolved.extension)) {
        const transformations = new Transformations();
        transformations.setShiftDays({
          min: dateShift.minDays,
          max: dateShift.maxDays,
          entities: dateShiftEntityEnums!,
        });
        options.setTransformations(transformations);
      } else {
        warnings.push(
          `dateShift is ignored for .${resolved.extension} files. Date shifting currently applies only to ${[...TRANSFORMATION_SUPPORTED_FORMATS].join(", ")} formats; detected dates in this file will be tokenized instead.`
        );
      }
    }

    if (bleep) {
      const bleepOptions = new Bleep();
      if (bleep.gain !== undefined) bleepOptions.setGain(bleep.gain);
      if (bleep.frequency !== undefined) bleepOptions.setFrequency(bleep.frequency);
      if (bleep.startPadding !== undefined) bleepOptions.setStartPadding(bleep.startPadding);
      if (bleep.stopPadding !== undefined) bleepOptions.setStopPadding(bleep.stopPadding);
      options.setBleep(bleepOptions);
    }

    // Bounded wait: the run continues at Skyflow if it doesn't finish in time,
    // and the response then carries only runId + status for later polling.
    const waitTime = Math.min(
      Math.max(waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS, 1),
      MAX_WAIT_TIME_SECONDS
    );
    options.setWaitTime(waitTime);

    const response = await skyflow
      .detect(vaultId)
      .deidentifyFile(fileReq, options);

    // Prepare the output with proper typing
    const output: DeIdentifyFileOutput = {
      inputFileName: resolved.fileName,
      inputMimeType: effectiveMimeType,
    };

    if (fileUrl) {
      output.inputFileUrl = fileUrl;
    }

    // Only describe the processed file (data/extension/mimeType) when one was
    // actually returned — an IN_PROGRESS run has no output yet, so reporting the
    // input file's extension/MIME would falsely imply a downloadable result.
    if (response.fileBase64) {
      output.processedFileData = response.fileBase64;
      // response.type is a Skyflow category label (e.g. "redacted_image"), not a
      // MIME type — derive a real MIME from the processed file's extension so
      // UIs can render/download it correctly.
      const processedExtension = response.extension || resolved.extension;
      if (processedExtension) {
        output.extension = processedExtension;
        output.mimeType = mimeTypeFromExtension(processedExtension) ?? effectiveMimeType;
      }
    }

    if (response.entities && response.entities.length > 0) {
      output.detectedEntities = response.entities.map(
        (e: DetectedEntityItem) => ({
          file: e.file,
          extension: e.extension,
        })
      );
    }

    // The SDK defaults these counts to 0 when absent, so only surface positive
    // values (0 carries no useful signal and clutters format-inapplicable cards).
    if (response.wordCount) {
      output.wordCount = response.wordCount;
    }

    if (response.charCount) {
      output.charCount = response.charCount;
    }

    if (response.sizeInKb) {
      output.sizeInKb = response.sizeInKb;
    }

    if (response.durationInSeconds) {
      output.durationInSeconds = response.durationInSeconds;
    }

    if (response.pageCount) {
      output.pageCount = response.pageCount;
    }

    if (response.slideCount) {
      output.slideCount = response.slideCount;
    }

    if (response.runId) {
      output.runId = response.runId;
      output.status = response.status;

      // Attach polling guidance for any non-complete status (IN_PROGRESS or
      // otherwise), not just the exact "IN_PROGRESS" string, so the agent is
      // never left with a runId and no direction. Only when no file came back
      // inline — if a processed file is present the run is done, so a
      // "still processing" note would contradict the payload.
      const notComplete = !response.status || response.status.toUpperCase() !== "SUCCESS";
      if (notComplete && !output.processedFileData) {
        output.note = stillProcessingNote(response.runId);
      }
    }

    // Completed inline but with no artifact — say so explicitly (consistent with
    // get-file-run-status) rather than returning a silent empty success.
    if (!output.note && !output.processedFileData && !output.detectedEntities) {
      output.note = completedWithoutArtifactNote(response.runId);
    }

    if (warnings.length > 0) {
      output.warnings = warnings;
    }

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
    } else if (error instanceof SkyflowError) {
      return {
        output: {
          error: true,
          code: typeof error.error?.http_code === "number" ? error.error.http_code : undefined,
          message: error.message,
          details: error.error?.details,
        },
        isError: true,
      };
    } else {
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
}
