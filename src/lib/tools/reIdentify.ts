import { ReidentifyTextOptions, ReidentifyTextRequest, SkyflowError } from "skyflow-node";
import type { Skyflow } from "skyflow-node";
import { getEntityEnum } from "../mappings/entityMaps.js";
import type { ReIdentifyFormat, ReIdentifyOutput, ReIdentifyErrorOutput, AnonymousModeError, ToolResult } from "./types.js";

/**
 * Build Skyflow re-identify options from the tool's `format` argument.
 * Only buckets containing at least one entity type are set, so an empty or
 * absent bucket falls back to the API default (plaintext re-identification).
 * Returns `undefined` when no entity types are specified, so the SDK is called
 * without options and every token is fully re-identified (the default behavior).
 */
function buildReidentifyOptions(
  format: ReIdentifyFormat | undefined
): ReidentifyTextOptions | undefined {
  if (!format) return undefined;

  const options = new ReidentifyTextOptions();
  let hasAny = false;

  if (format.redacted && format.redacted.length > 0) {
    options.setRedactedEntities(format.redacted.map(getEntityEnum));
    hasAny = true;
  }
  if (format.masked && format.masked.length > 0) {
    options.setMaskedEntities(format.masked.map(getEntityEnum));
    hasAny = true;
  }
  if (format.plaintext && format.plaintext.length > 0) {
    options.setPlainTextEntities(format.plaintext.map(getEntityEnum));
    hasAny = true;
  }

  return hasAny ? options : undefined;
}

/**
 * Handle the re-identify tool logic.
 * Restores original sensitive data from de-identified placeholders.
 *
 * An optional `format` controls how each entity type is rendered on the way out
 * (redacted / masked / plaintext), per the Skyflow Detect API spec. When omitted,
 * every token is fully re-identified to its original plaintext value.
 */
export async function handleReIdentify(
  inputString: string,
  skyflow: Skyflow,
  anonymousMode: boolean,
  format?: ReIdentifyFormat
): Promise<ToolResult<ReIdentifyOutput | AnonymousModeError | ReIdentifyErrorOutput>> {
  if (anonymousMode) {
    return {
      output: {
        error: "re-identify is not available in anonymous mode",
        anonymousModeRestricted: true,
        message:
          "The re-identify tool requires authenticated access to restore sensitive data from vault tokens. " +
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
    const options = buildReidentifyOptions(format);

    const response = await skyflow
      .detect()
      .reidentifyText(new ReidentifyTextRequest(inputString), options);

    return {
      output: {
        inputText: inputString,
        processedText: response.processedText,
        ...(format && { format }),
      },
    };
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
