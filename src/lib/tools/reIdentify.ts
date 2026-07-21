import { ReidentifyTextOptions, ReidentifyTextRequest, SkyflowError } from "skyflow-node";
import type { Skyflow } from "skyflow-node";
import { getEntityEnum, isValidEntity } from "../mappings/entityMaps.js";
import type { ReIdentifyFormat, ReIdentifyOutput, ReIdentifyErrorOutput, AnonymousModeError, ToolResult } from "./types.js";

/** The three re-identification treatment buckets, in output order. */
const FORMAT_BUCKETS = ["redacted", "masked", "plaintext"] as const;

/**
 * Reduce a format to only the buckets that carry entity types, de-duplicating
 * within each bucket and dropping empty/absent buckets. The result is what gets
 * forwarded to the SDK and echoed back, so both stay in lockstep and neither
 * carries empty arrays or redundant entries.
 */
function normalizeFormat(format: ReIdentifyFormat): ReIdentifyFormat {
  const normalized: ReIdentifyFormat = {};
  for (const bucket of FORMAT_BUCKETS) {
    const entities = format[bucket];
    if (entities && entities.length > 0) {
      normalized[bucket] = [...new Set(entities)];
    }
  }
  return normalized;
}

/**
 * Collect any entity types in the format that are not recognized. Returned so
 * an invalid name can be reported as a client-side validation error (before any
 * Skyflow call), distinct in shape from a Skyflow API error.
 */
function findInvalidEntities(format: ReIdentifyFormat): string[] {
  const invalid = new Set<string>();
  for (const bucket of FORMAT_BUCKETS) {
    for (const entity of format[bucket] ?? []) {
      if (!isValidEntity(entity)) invalid.add(entity);
    }
  }
  return [...invalid];
}

/**
 * Find entity types that appear in more than one format bucket. Each entity type
 * may only be rendered one way, so an entity listed under, say, both `redacted`
 * and `masked` is ambiguous (the SDK would forward it to both setters with
 * last-wins/undefined behavior). Duplicates within a single bucket are ignored.
 */
function findFormatOverlaps(format: ReIdentifyFormat): string[] {
  const bucketCount = new Map<string, number>();
  for (const bucket of FORMAT_BUCKETS) {
    for (const entity of new Set(format[bucket] ?? [])) {
      bucketCount.set(entity, (bucketCount.get(entity) ?? 0) + 1);
    }
  }
  return [...bucketCount.entries()].filter(([, count]) => count > 1).map(([entity]) => entity);
}

/**
 * Build Skyflow re-identify options from an already-normalized format.
 * Returns `undefined` when no entity types are specified, so the SDK is called
 * without options and every token is fully re-identified (the default behavior).
 */
function buildReidentifyOptions(
  normalized: ReIdentifyFormat
): ReidentifyTextOptions | undefined {
  if (Object.keys(normalized).length === 0) return undefined;

  const options = new ReidentifyTextOptions();
  if (normalized.redacted) options.setRedactedEntities(normalized.redacted.map(getEntityEnum));
  if (normalized.masked) options.setMaskedEntities(normalized.masked.map(getEntityEnum));
  if (normalized.plaintext) options.setPlainTextEntities(normalized.plaintext.map(getEntityEnum));
  return options;
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

    const invalidEntities = findInvalidEntities(format);
    if (invalidEntities.length > 0) {
      return {
        output: {
          error: true,
          message:
            `Invalid entity type(s) in format: ${invalidEntities.join(", ")}. ` +
            "Use the same lowercase entity names as the de-identify tool.",
        },
        isError: true,
      };
    }
  }

  // Normalize once: drops empty buckets and intra-bucket duplicates. The same
  // value feeds the SDK options and the echoed-back format.
  const normalizedFormat = format ? normalizeFormat(format) : undefined;
  const hasFormat = normalizedFormat !== undefined && Object.keys(normalizedFormat).length > 0;

  try {
    const options = normalizedFormat ? buildReidentifyOptions(normalizedFormat) : undefined;

    const response = await skyflow
      .detect()
      .reidentifyText(new ReidentifyTextRequest(inputString), options);

    return {
      output: {
        inputText: inputString,
        processedText: response.processedText,
        ...(hasFormat && { format: normalizedFormat }),
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
