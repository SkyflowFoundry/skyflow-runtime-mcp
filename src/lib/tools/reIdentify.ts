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
 * Find entity types that appear in more than one format bucket. Each entity type
 * may only be rendered one way, so an entity listed under, say, both `redacted`
 * and `masked` is ambiguous (the SDK would forward it to both setters with
 * last-wins/undefined behavior). Duplicates within a single bucket are ignored.
 */
function findFormatOverlaps(format: ReIdentifyFormat): string[] {
  const bucketCount = new Map<string, number>();
  for (const bucket of [format.redacted, format.masked, format.plaintext]) {
    for (const entity of new Set(bucket ?? [])) {
      bucketCount.set(entity, (bucketCount.get(entity) ?? 0) + 1);
    }
  }
  return [...bucketCount.entries()].filter(([, count]) => count > 1).map(([entity]) => entity);
}

/**
 * Reduce a format to only the buckets that actually carry entity types, so the
 * value echoed back in the response reflects what was applied (no empty arrays).
 */
function normalizeFormat(format: ReIdentifyFormat): ReIdentifyFormat {
  const normalized: ReIdentifyFormat = {};
  if (format.redacted && format.redacted.length > 0) normalized.redacted = format.redacted;
  if (format.masked && format.masked.length > 0) normalized.masked = format.masked;
  if (format.plaintext && format.plaintext.length > 0) normalized.plaintext = format.plaintext;
  return normalized;
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

  if (format) {
    const overlaps = findFormatOverlaps(format);
    if (overlaps.length > 0) {
      return {
        output: {
          error: true,
          message:
            "Each entity type may appear in only one format bucket (redacted, masked, or plaintext). " +
            `The following appear in more than one: ${overlaps.join(", ")}.`,
        },
        isError: true,
      };
    }
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
        ...(format && { format: normalizeFormat(format) }),
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
