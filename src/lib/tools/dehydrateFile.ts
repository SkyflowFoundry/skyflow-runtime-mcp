import {
  DeidentifyFileOptions,
  DeidentifyFileRequest,
  SkyflowError,
} from "skyflow-node";
import type { Skyflow, FileInput } from "skyflow-node";
import {
  getEntityEnum,
  getMaskingMethodEnum,
  getTranscriptionEnum,
} from "../mappings/entityMaps.js";
import type {
  DehydrateFileArgs,
  DehydrateFileOutput,
  DehydrateFileErrorOutput,
  AnonymousModeError,
  DetectedEntityItem,
  ToolResult,
} from "./types.js";

/** Default maximum wait time for file dehydration operations (in seconds) */
export const DEFAULT_MAX_WAIT_TIME_SECONDS = 64;

/**
 * Handle the dehydrate_file tool logic.
 * Processes files to detect and redact sensitive information.
 */
export async function handleDehydrateFile(
  args: DehydrateFileArgs,
  skyflow: Skyflow,
  vaultId: string,
  anonymousMode: boolean
): Promise<ToolResult<DehydrateFileOutput | AnonymousModeError | DehydrateFileErrorOutput>> {
  if (anonymousMode) {
    return {
      output: {
        error: "dehydrate_file is not available in anonymous mode",
        anonymousModeRestricted: true,
        message:
          "File deidentification requires authenticated access for secure processing. " +
          "To use this feature, configure your Skyflow credentials:\n\n" +
          "1. Get your API key from the Skyflow dashboard\n" +
          "2. Add via Authorization header: 'Bearer <api-key>'\n" +
          "   Or via query parameter: '?apiKey=<api-key>'\n\n" +
          "For text-only deidentification, you can use the 'dehydrate' tool in anonymous mode.",
        helpUrl: "https://docs.skyflow.com/",
        alternativeTool: "dehydrate",
      },
      isError: true,
    };
  }

  try {
    const {
      fileData,
      fileName,
      mimeType,
      entities,
      maskingMethod,
      outputProcessedFile,
      outputOcrText,
      outputTranscription,
      pixelDensity,
      maxResolution,
      waitTime,
    } = args;

    // Decode base64 to buffer
    const buffer = Buffer.from(fileData, "base64");

    // Create a File object from the buffer
    const file = new File([buffer], fileName, { type: mimeType });

    // Construct the file input
    const fileInput: FileInput = { file: file };
    const fileReq = new DeidentifyFileRequest(fileInput);

    // Configure DeidentifyFileOptions
    const options = new DeidentifyFileOptions();

    // Set entities if provided - use type-safe mapping
    if (entities && entities.length > 0) {
      const entityEnums = entities.map((e) => getEntityEnum(e));
      options.setEntities(entityEnums);
    }

    // Set masking method for images - use type-safe mapping
    if (maskingMethod) {
      options.setMaskingMethod(getMaskingMethodEnum(maskingMethod));
    }

    // Set output options
    if (outputProcessedFile !== undefined) {
      if (mimeType?.startsWith("image/")) {
        options.setOutputProcessedImage(outputProcessedFile);
      } else if (mimeType?.startsWith("audio/")) {
        options.setOutputProcessedAudio(outputProcessedFile);
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

    // Set wait time (default to max, or use provided value)
    options.setWaitTime(waitTime || DEFAULT_MAX_WAIT_TIME_SECONDS);

    const response = await skyflow
      .detect(vaultId)
      .deidentifyFile(fileReq, options);

    // Prepare the output with proper typing
    const output: DehydrateFileOutput = {
      inputFileName: fileName,
      inputMimeType: mimeType,
    };

    if (response.fileBase64) {
      output.processedFileData = response.fileBase64;
    }

    if (response.type) {
      output.mimeType = response.type;
    }

    if (response.extension) {
      output.extension = response.extension;
    }

    if (response.entities && response.entities.length > 0) {
      output.detectedEntities = response.entities.map(
        (e: DetectedEntityItem) => ({
          file: e.file,
          extension: e.extension,
        })
      );
    }

    if (response.wordCount !== undefined) {
      output.wordCount = response.wordCount;
    }

    if (response.charCount !== undefined) {
      output.charCount = response.charCount;
    }

    if (response.sizeInKb !== undefined) {
      output.sizeInKb = response.sizeInKb;
    }

    if (response.durationInSeconds !== undefined) {
      output.durationInSeconds = response.durationInSeconds;
    }

    if (response.pageCount !== undefined) {
      output.pageCount = response.pageCount;
    }

    if (response.slideCount !== undefined) {
      output.slideCount = response.slideCount;
    }

    if (response.runId) {
      output.runId = response.runId;
      output.status = response.status;
    }

    return { output };
  } catch (error) {
    if (error instanceof SkyflowError) {
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
