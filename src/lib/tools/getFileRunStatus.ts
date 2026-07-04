import {
  getDetectRunRest,
  DetectRestError,
  type DetectRestContext,
  type DetectRunResult,
} from "../detect/detectRest.js";
import { mimeTypeFromExtension } from "../mappings/fileFormats.js";
import { stillProcessingNote, completedWithoutArtifactNote } from "./deIdentifyFile.js";
import type {
  GetFileRunStatusArgs,
  DeIdentifyFileOutput,
  GetFileRunStatusErrorOutput,
  AnonymousModeError,
  ToolResult,
} from "./types.js";

/** Longest server-side wait for a single status call (stays under gateway timeouts). */
export const MAX_STATUS_WAIT_SECONDS = 55;

/** The processed-file artifact type that carries detected entity crops. */
const ENTITIES_OUTPUT_TYPE = "entities";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map a detect run result onto the shared file-tool output shape. */
function toOutput(runId: string, run: DetectRunResult): DeIdentifyFileOutput {
  const output: DeIdentifyFileOutput = {
    runId,
    status: run.status,
  };

  const processed = run.output.find(
    (item) => item.processedFile && item.processedFileType !== ENTITIES_OUTPUT_TYPE
  );
  if (processed) {
    output.processedFileData = processed.processedFile;
    if (processed.processedFileExtension) {
      output.extension = processed.processedFileExtension;
      // processedFileType is a Skyflow category label, not a MIME type — derive
      // a real MIME from the extension so the UI can render/download correctly.
      const mime = mimeTypeFromExtension(processed.processedFileExtension);
      if (mime) output.mimeType = mime;
    }
  }

  const entities = run.output.filter(
    (item) => item.processedFileType === ENTITIES_OUTPUT_TYPE && item.processedFile
  );
  if (entities.length > 0) {
    output.detectedEntities = entities.map((item) => ({
      file: item.processedFile as string,
      extension: item.processedFileExtension ?? "",
    }));
  }

  // Omit zero counts (consistent with de-identify-file) — a 0 word/page/etc.
  // count carries no useful signal and clutters format-inapplicable results.
  if (run.wordCount) output.wordCount = run.wordCount;
  if (run.charCount) output.charCount = run.charCount;
  if (run.sizeInKb) output.sizeInKb = run.sizeInKb;
  if (run.durationInSeconds) output.durationInSeconds = run.durationInSeconds;
  if (run.pageCount) output.pageCount = run.pageCount;
  if (run.slideCount) output.slideCount = run.slideCount;
  if (run.message) output.message = run.message;

  return output;
}

/**
 * Handle the get-file-run-status tool logic.
 * Checks (and optionally waits for) the status of an asynchronous file
 * de-identification run started by the de-identify-file tool.
 */
export async function handleGetFileRunStatus(
  args: GetFileRunStatusArgs,
  context: DetectRestContext,
  anonymousMode: boolean
): Promise<ToolResult<DeIdentifyFileOutput | AnonymousModeError | GetFileRunStatusErrorOutput>> {
  if (anonymousMode) {
    return {
      output: {
        error: "get-file-run-status is not available in anonymous mode",
        anonymousModeRestricted: true,
        message:
          "File deidentification runs require authenticated access. " +
          "Configure your Skyflow credentials via the Authorization header " +
          "('Bearer <api-key>') or the apiKey query parameter.",
        helpUrl: "https://docs.skyflow.com/",
        alternativeTool: "de-identify",
      },
      isError: true,
    };
  }

  const { runId } = args;
  const waitSeconds = Math.min(
    Math.max(args.waitSeconds ?? 0, 0),
    MAX_STATUS_WAIT_SECONDS
  );

  try {
    const deadline = Date.now() + waitSeconds * 1000;
    let pollDelayMs = 2000;
    let run = await getDetectRunRest(context, runId);

    // Keep polling through any non-terminal status (IN_PROGRESS, or another
    // non-standard label like PENDING/RUNNING), not just the exact "IN_PROGRESS"
    // string, so waitSeconds actually waits regardless of how Skyflow labels the
    // in-flight state.
    while (run.status !== "SUCCESS" && run.status !== "FAILED" && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await sleep(Math.min(pollDelayMs, remaining));
      pollDelayMs = Math.min(pollDelayMs * 2, 8000);
      run = await getDetectRunRest(context, runId);
    }

    if (run.status === "FAILED") {
      return {
        output: {
          error: true,
          message: run.message
            ? `File de-identification run ${runId} failed: ${run.message}`
            : `File de-identification run ${runId} failed.`,
          details: { runId, status: run.status },
        },
        isError: true,
      };
    }

    const output = toOutput(runId, run);

    // Any non-terminal or unknown status (IN_PROGRESS, UNKNOWN, etc.) means the
    // result isn't ready — attach the polling note rather than returning a
    // success-shaped response with no processed file.
    if (run.status !== "SUCCESS") {
      output.note = stillProcessingNote(runId);
    } else if (!output.processedFileData && !output.detectedEntities) {
      // Completed, but with no file/entity artifact (e.g. output options that
      // produce no file were requested). Say so explicitly so a caller doesn't
      // read the empty-but-successful response as a lost result.
      output.note = completedWithoutArtifactNote(runId);
    }

    return { output };
  } catch (error) {
    if (error instanceof DetectRestError) {
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
