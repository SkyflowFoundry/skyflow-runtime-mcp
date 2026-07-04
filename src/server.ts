import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express, { type Express } from "express";
import { z } from "zod";
import {
  deIdentifyHtml,
  reIdentifyHtml,
  deIdentifyFileHtml,
  reIdentifyFileHtml,
} from "./generated/ui-html.js";
import { Skyflow } from "skyflow-node";
import { AsyncLocalStorage } from "async_hooks";
import { validateVaultConfig, looksLikePlaceholder, getVaultBaseUrl } from "./lib/validation/vaultConfig.js";
import {
  ENTITY_KEYS,
  MASKING_METHOD_KEYS,
  TRANSCRIPTION_KEYS,
} from "./lib/mappings/entityMaps.js";
import { handleDeIdentify } from "./lib/tools/deIdentify.js";
import { handleReIdentify } from "./lib/tools/reIdentify.js";
import {
  handleDeIdentifyFile,
  FILE_TOKEN_TYPE_KEYS,
  MAX_WAIT_TIME_SECONDS,
} from "./lib/tools/deIdentifyFile.js";
import {
  handleGetFileRunStatus,
  MAX_STATUS_WAIT_SECONDS,
} from "./lib/tools/getFileRunStatus.js";
import { handleReIdentifyFile } from "./lib/tools/reIdentifyFile.js";
import type { DetectRestContext } from "./lib/detect/detectRest.js";
import { toStructuredContent, toFileToolResult } from "./lib/tools/types.js";
import { authenticateBearer } from "./lib/middleware/authenticateBearer.js";
import {
  createAnonymousRateLimiter,
  getAnonymousRateLimitConfig,
} from "./lib/middleware/rateLimiter.js";

/**
 * AsyncLocalStorage for storing per-request Skyflow instances
 * This allows tools to access the current request's Skyflow client
 */
interface RequestContext {
  skyflow: Skyflow;
  vaultId: string;
  /** Skyflow REST base URL derived from clusterId (not the client-supplied vaultUrl). */
  vaultUrl: string;
  /** Raw bearer value (JWT or API key) forwarded to Skyflow. Never log this. */
  credentialKey: string;
  isAnonymousMode: boolean;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the full context for the current request
 */
function getRequestContext(): RequestContext {
  const context = requestContextStorage.getStore();
  if (!context) {
    throw new Error("No request context available");
  }
  return context;
}

/**
 * Get the Skyflow instance for the current request context
 */
function getCurrentSkyflow(): Skyflow {
  return getRequestContext().skyflow;
}

/**
 * Get the vault ID for the current request context
 */
function getCurrentVaultId(): string {
  return getRequestContext().vaultId;
}

/**
 * Check if the current request is in anonymous mode
 */
function isAnonymousMode(): boolean {
  return getRequestContext().isAnonymousMode;
}

/**
 * Build the context used for direct Detect REST calls (run status, file
 * re-identification) from the current request.
 */
function getDetectRestContext(): DetectRestContext {
  const context = getRequestContext();
  return {
    vaultUrl: context.vaultUrl,
    vaultId: context.vaultId,
    credentialKey: context.credentialKey,
  };
}

// Create an MCP server
const server = new McpServer({
  name: "Skyflow Runtime MCP Server",
  version: "0.4.0",
});

// MCP Apps: Resource URIs
const DE_IDENTIFY_RESOURCE_URI = "ui://de-identify/mcp-app.html";
const RE_IDENTIFY_RESOURCE_URI = "ui://re-identify/mcp-app.html";
const DE_IDENTIFY_FILE_RESOURCE_URI = "ui://de-identify-file/mcp-app.html";
const RE_IDENTIFY_FILE_RESOURCE_URI = "ui://re-identify-file/mcp-app.html";

// Register UI resources for each tool
registerAppResource(server, "De-identify UI", DE_IDENTIFY_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: DE_IDENTIFY_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: deIdentifyHtml }],
}));

registerAppResource(server, "Re-identify UI", RE_IDENTIFY_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: RE_IDENTIFY_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: reIdentifyHtml }],
}));

// Shared by de-identify-file and get-file-run-status (both render run results)
registerAppResource(server, "De-identify File UI", DE_IDENTIFY_FILE_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: DE_IDENTIFY_FILE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: deIdentifyFileHtml }],
}));

registerAppResource(server, "Re-identify File UI", RE_IDENTIFY_FILE_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: RE_IDENTIFY_FILE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: reIdentifyFileHtml }],
}));

/**
 * Output schema shared by the de-identify-file and get-file-run-status tools.
 * All fields are optional because the shape differs between completed runs,
 * in-progress runs (runId/status only), and error responses.
 */
const fileRunOutputSchema = {
  inputFileName: z.string().optional().describe("Name of the input file"),
  inputFileUrl: z.string().optional().describe("URL the input file was downloaded from"),
  inputMimeType: z.string().optional().describe("MIME type of the input file"),
  processedFileData: z
    .string()
    .optional()
    .describe("Base64-encoded de-identified file (present when the run has completed)"),
  mimeType: z.string().optional().describe("Type of the processed output"),
  extension: z.string().optional().describe("File extension of the processed output"),
  detectedEntities: z
    .array(z.object({ file: z.string(), extension: z.string() }))
    .optional()
    .describe("Detected entity artifacts (e.g. image crops of detected regions)"),
  wordCount: z.number().optional(),
  charCount: z.number().optional(),
  sizeInKb: z.number().optional(),
  durationInSeconds: z.number().optional().describe("Audio duration, for audio files"),
  pageCount: z.number().optional().describe("Page count, for documents"),
  slideCount: z.number().optional().describe("Slide count, for presentations"),
  runId: z
    .string()
    .optional()
    .describe("Skyflow run identifier for the asynchronous de-identification job"),
  status: z
    .string()
    .optional()
    .describe("Run status: IN_PROGRESS, SUCCESS, or FAILED"),
  message: z.string().optional().describe("Status message from Skyflow, when provided"),
  note: z
    .string()
    .optional()
    .describe("Follow-up instructions, e.g. how to poll an in-progress run"),
  warnings: z.array(z.string()).optional().describe("Non-fatal warnings about ignored options"),
  error: z.union([z.boolean(), z.string()]).optional().describe("Error indicator or message"),
  anonymousModeRestricted: z.boolean().optional().describe("True when blocked due to anonymous mode"),
  helpUrl: z.string().optional().describe("URL for setup documentation"),
  alternativeTool: z.string().optional().describe("Suggested tool to use instead"),
  code: z.number().optional().describe("HTTP error code from Skyflow API"),
  details: z.unknown().optional().describe("Additional error details from Skyflow API"),
};

/**
 * Skyflow De-identify Tool
 * Replaces sensitive information in text with placeholder tokens
 */
registerAppTool(
  server,
  "de-identify",
  {
    title: "Skyflow De-identify Tool",
    description:
      "De-identify sensitive information in strings using Skyflow. This tool accepts a string and returns another string, but with placeholders for sensitive data. The placeholders tell you what they are replacing. For example, a credit card number might be replaced with [CREDIT_CARD_abc123].",
    inputSchema: {
      inputString: z.string().min(1).describe("Original Text — paste the text you want to scan for sensitive data"),
      entities: z
        .array(z.enum(ENTITY_KEYS))
        .optional()
        .describe("Specific entity types to detect. Leave empty to detect all supported entities."),
    },
    outputSchema: {
      inputText: z.string().describe("The original input text"),
      processedText: z.string(),
      wordCount: z.number(),
      charCount: z.number(),
      entities: z.array(z.object({
        token: z.string().optional(),
        value: z.string().optional(),
        entity: z.string().optional(),
        textIndex: z.object({ start: z.number().optional(), end: z.number().optional() }).optional(),
        processedIndex: z.object({ start: z.number().optional(), end: z.number().optional() }).optional(),
        scores: z.record(z.number()).optional(),
      })).describe("Detected entities with positions and confidence scores"),
      anonymousMode: z
        .boolean()
        .optional()
        .describe("True when running in anonymous mode (no credentials provided)"),
      note: z
        .string()
        .optional()
        .describe("Additional information about the response, such as anonymous mode limitations"),
      error: z.union([z.boolean(), z.string()]).optional().describe("Error indicator or message"),
      code: z.number().optional().describe("HTTP error code from Skyflow API"),
      message: z.string().optional().describe("Detailed error message"),
      details: z.unknown().optional().describe("Additional error details from Skyflow API"),
    },
    _meta: { ui: { resourceUri: DE_IDENTIFY_RESOURCE_URI } },
  },
  async ({ inputString, entities }) => {
    const result = await handleDeIdentify(inputString, entities, getCurrentSkyflow(), isAnonymousMode());
    return {
      content: [{ type: "text", text: JSON.stringify(result.output) }],
      structuredContent: toStructuredContent(result.output),
      ...(result.isError && { isError: true }),
    };
  }
);

/**
 * Skyflow Re-identify Tool
 * Restores original sensitive data from de-identified placeholders
 */
registerAppTool(
  server,
  "re-identify",
  {
    title: "Skyflow Re-identify Tool",
    description:
      "Re-identify previously de-identified sensitive information in strings using Skyflow. This tool accepts a string with redacted placeholders (like [CREDIT_CARD_abc123]) and returns the original sensitive data.",
    inputSchema: { inputString: z.string().min(1).describe("Original Text — paste the tokenized text you want to restore") },
    outputSchema: {
      inputText: z.string().optional().describe("The original tokenized input text"),
      processedText: z.string().optional(),
      error: z.union([z.boolean(), z.string()]).optional().describe("Error indicator or message"),
      anonymousModeRestricted: z.boolean().optional().describe("True when blocked due to anonymous mode"),
      message: z.string().optional().describe("Detailed error or setup instructions"),
      helpUrl: z.string().optional().describe("URL for setup documentation"),
      code: z.number().optional().describe("HTTP error code from Skyflow API"),
      details: z.unknown().optional().describe("Additional error details from Skyflow API"),
    },
    _meta: { ui: { resourceUri: RE_IDENTIFY_RESOURCE_URI } },
  },
  async ({ inputString }) => {
    const result = await handleReIdentify(inputString, getCurrentSkyflow(), isAnonymousMode());
    return {
      content: [{ type: "text", text: JSON.stringify(result.output) }],
      structuredContent: toStructuredContent(result.output),
      ...(result.isError && { isError: true }),
    };
  }
);

/**
 * Skyflow De-identify File Tool
 * Detects and redacts sensitive information in files (images, PDFs, audio,
 * documents, spreadsheets, presentations). File processing is asynchronous:
 * if the run doesn't finish within the bounded wait, the response carries a
 * runId to poll with the get-file-run-status tool.
 */
registerAppTool(
  server,
  "de-identify-file",
  {
    title: "Skyflow De-identify File Tool",
    description:
      "De-identify sensitive information in a file using Skyflow. " +
      "Pass the file either as a signed/public URL (fileUrl) — the server downloads it and forwards it to Skyflow — " +
      "or as base64 content (fileDataBase64 + fileName). " +
      "Supports images (jpg, png, bmp, tif), PDFs, Word/Excel/PowerPoint documents, txt, csv, json, xml, dcm, and audio (mp3, wav). " +
      "File processing is asynchronous: small files usually complete within the default wait and return the processed file inline; " +
      "larger files return a runId with status IN_PROGRESS — call the get-file-run-status tool with that runId to retrieve the result.",
    inputSchema: {
      fileUrl: z
        .string()
        .optional()
        .describe(
          "Signed or public URL of the file to de-identify (e.g. an S3/GCS signed URL). The server downloads it (25 MB max) and converts it to base64 for Skyflow. Provide either fileUrl or fileDataBase64."
        ),
      fileDataBase64: z
        .string()
        .optional()
        .describe("Base64-encoded file content. Provide either fileUrl or fileDataBase64."),
      fileName: z
        .string()
        .optional()
        .describe(
          "File name including extension (e.g. \"report.pdf\"). Required with fileDataBase64; optional with fileUrl (inferred from the URL or response headers when omitted). The extension determines how Skyflow processes the file."
        ),
      mimeType: z.string().optional().describe("MIME type of the file (optional hint, e.g. \"application/pdf\")"),
      entities: z
        .array(z.enum(ENTITY_KEYS))
        .optional()
        .describe("Specific entity types to detect. Leave empty to detect all supported entities."),
      allowRegexList: z
        .array(z.string())
        .optional()
        .describe("Regex patterns for values that should NOT be de-identified (allowlist)"),
      restrictRegexList: z
        .array(z.string())
        .optional()
        .describe("Regex patterns for additional values that SHOULD be de-identified (denylist)"),
      tokenType: z
        .enum(FILE_TOKEN_TYPE_KEYS)
        .optional()
        .describe(
          "Token format for detected entities: entity_unique_counter (e.g. [SSN_1], default) or entity_only (e.g. [SSN])"
        ),
      maskingMethod: z
        .enum(MASKING_METHOD_KEYS)
        .optional()
        .describe("How to mask detected regions in images: BLACKBOX or BLUR"),
      outputProcessedFile: z
        .boolean()
        .optional()
        .describe("Return the processed (redacted) file. Applies to image and audio files."),
      outputOcrText: z
        .boolean()
        .optional()
        .describe("Return OCR-extracted text for images"),
      outputTranscription: z
        .enum(TRANSCRIPTION_KEYS)
        .optional()
        .describe("Return a transcription for audio files: PLAINTEXT_TRANSCRIPTION or DIARIZED_TRANSCRIPTION"),
      pixelDensity: z.number().positive().optional().describe("Pixel density for PDF rasterization"),
      maxResolution: z.number().positive().optional().describe("Maximum resolution for PDF processing"),
      dateShift: z
        .object({
          minDays: z.number().int().describe("Minimum number of days to shift dates"),
          maxDays: z.number().int().describe("Maximum number of days to shift dates"),
          entities: z.array(z.enum(ENTITY_KEYS)).describe("Date entity types to shift (e.g. dob, date)"),
        })
        .optional()
        .describe("Shift detected dates by a random offset instead of tokenizing them"),
      bleep: z
        .object({
          gain: z.number().optional().describe("Bleep tone gain"),
          frequency: z.number().optional().describe("Bleep tone frequency in Hz"),
          startPadding: z.number().optional().describe("Seconds of padding before each bleep"),
          stopPadding: z.number().optional().describe("Seconds of padding after each bleep"),
        })
        .optional()
        .describe("Bleep tone settings for redacting audio files"),
      waitTimeSeconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAIT_TIME_SECONDS)
        .optional()
        .describe(
          `Seconds to wait for the run to complete before returning a runId to poll (1-${MAX_WAIT_TIME_SECONDS}, default 25)`
        ),
    },
    outputSchema: fileRunOutputSchema,
    _meta: { ui: { resourceUri: DE_IDENTIFY_FILE_RESOURCE_URI } },
  },
  async (args) => {
    const result = await handleDeIdentifyFile(
      args,
      getCurrentSkyflow(),
      getCurrentVaultId(),
      isAnonymousMode()
    );
    return toFileToolResult(result);
  }
);

/**
 * Skyflow File Run Status Tool
 * Polls the status of an asynchronous file de-identification run and returns
 * the processed file once the run completes.
 */
registerAppTool(
  server,
  "get-file-run-status",
  {
    title: "Skyflow File Run Status Tool",
    description:
      "Check the status of an asynchronous file de-identification run started by the de-identify-file tool, " +
      "and retrieve the processed file when the run completes. " +
      "Pass the runId returned by de-identify-file. " +
      "Optionally pass waitSeconds to wait server-side for completion instead of polling repeatedly; " +
      "if the run is still IN_PROGRESS after the wait, call this tool again.",
    inputSchema: {
      runId: z
        .string()
        .min(1)
        .describe("Run identifier returned by the de-identify-file tool"),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_STATUS_WAIT_SECONDS)
        .optional()
        .describe(
          `Seconds to wait server-side for the run to complete (0-${MAX_STATUS_WAIT_SECONDS}, default 0 = single status check)`
        ),
    },
    outputSchema: fileRunOutputSchema,
    _meta: { ui: { resourceUri: DE_IDENTIFY_FILE_RESOURCE_URI } },
  },
  async ({ runId, waitSeconds }) => {
    const result = await handleGetFileRunStatus(
      { runId, waitSeconds },
      getDetectRestContext(),
      isAnonymousMode()
    );
    return toFileToolResult(result);
  }
);

/**
 * Skyflow Re-identify File Tool
 * Restores original sensitive data in a previously de-identified file.
 */
registerAppTool(
  server,
  "re-identify-file",
  {
    title: "Skyflow Re-identify File Tool",
    description:
      "Re-identify a previously de-identified file using Skyflow, replacing tokens (like [SSN_abc123]) with the original sensitive data. " +
      "Pass the file either as a signed/public URL (fileUrl) or as base64 content (fileDataBase64 + fileName). " +
      "Supported formats: csv, doc, docx, json, txt, xls, xlsx, xml. " +
      "Optionally control how specific entity types are restored (redacted, masked, or plaintext).",
    inputSchema: {
      fileUrl: z
        .string()
        .optional()
        .describe(
          "Signed or public URL of the de-identified file (25 MB max). Provide either fileUrl or fileDataBase64."
        ),
      fileDataBase64: z
        .string()
        .optional()
        .describe("Base64-encoded de-identified file content. Provide either fileUrl or fileDataBase64."),
      fileName: z
        .string()
        .optional()
        .describe(
          "File name including extension (e.g. \"notes.txt\"). Required with fileDataBase64; optional with fileUrl."
        ),
      redactedEntities: z
        .array(z.enum(ENTITY_KEYS))
        .optional()
        .describe("Entity types to keep redacted in the output"),
      maskedEntities: z
        .array(z.enum(ENTITY_KEYS))
        .optional()
        .describe("Entity types to return masked (partially visible) in the output"),
      plainTextEntities: z
        .array(z.enum(ENTITY_KEYS))
        .optional()
        .describe("Entity types to restore as plaintext in the output"),
    },
    outputSchema: {
      inputFileName: z.string().optional().describe("Name of the input file"),
      inputFileUrl: z.string().optional().describe("URL the input file was downloaded from"),
      processedFileData: z
        .string()
        .optional()
        .describe("Base64-encoded re-identified file"),
      extension: z.string().optional().describe("File extension of the processed output"),
      status: z.string().optional().describe("Processing status: SUCCESS or FAILED"),
      error: z.union([z.boolean(), z.string()]).optional().describe("Error indicator or message"),
      anonymousModeRestricted: z.boolean().optional().describe("True when blocked due to anonymous mode"),
      message: z.string().optional().describe("Detailed error or setup instructions"),
      helpUrl: z.string().optional().describe("URL for setup documentation"),
      code: z.number().optional().describe("HTTP error code from Skyflow API"),
      details: z.unknown().optional().describe("Additional error details from Skyflow API"),
    },
    _meta: { ui: { resourceUri: RE_IDENTIFY_FILE_RESOURCE_URI } },
  },
  async (args) => {
    const result = await handleReIdentifyFile(
      args,
      getDetectRestContext(),
      isAnonymousMode()
    );
    return toFileToolResult(result);
  }
);

const app: Express = express();

// Serve static files from the public directory
app.use(express.static("public"));

// Create rate limiter for anonymous mode
const anonymousRateLimiter = createAnonymousRateLimiter(
  getAnonymousRateLimitConfig()
);

// Body parser for the /mcp endpoint. The 34MB limit is sized so an inline
// fileDataBase64 file up to the 25MB decoded cap (base64 inflates ~33%, plus
// JSON envelope) fits and fails with the clean FileSourceError rather than a
// generic PayloadTooLargeError — keeping the inline and URL-download limits
// consistent. It is applied per-route AFTER auth + rate limiting (below) so an
// unauthenticated/over-limit client can't force the server to buffer a large
// body before its credentials are checked.
const parseMcpBody = express.json({ limit: "34mb" });

// Extend Express Request type to include custom properties
declare global {
  namespace Express {
    interface Request {
      skyflowCredentials?: { token: string } | { apiKey: string };
      isAnonymousMode: boolean; // Always set by authenticateBearer middleware
      anonVaultConfig?: { vaultId: string; vaultUrl: string };
    }
  }
}

app.post("/mcp", authenticateBearer, anonymousRateLimiter, parseMcpBody, async (req, res) => {
  // Determine vault configuration based on mode
  let vaultId: string | undefined;
  let vaultUrl: string | undefined;
  let useAnonymousMode = req.isAnonymousMode;

  // Check if query params contain unsubstituted placeholder values (e.g., ${SKYFLOW_VAULT_ID})
  const queryVaultId = req.query.vaultId as string | undefined;
  const queryVaultUrl = req.query.vaultUrl as string | undefined;
  const hasPlaceholderParams =
    looksLikePlaceholder(queryVaultId) || looksLikePlaceholder(queryVaultUrl);

  if (hasPlaceholderParams && !req.isAnonymousMode) {
    // Query params contain placeholders - check if anonymous mode is available as fallback
    const anonApiKey = process.env.ANON_MODE_API_KEY;
    const anonVaultId = process.env.ANON_MODE_VAULT_ID;
    const anonVaultUrl = process.env.ANON_MODE_VAULT_URL;

    if (anonApiKey && anonVaultId && anonVaultUrl) {
      console.log(
        "Detected placeholder values in vaultId/vaultUrl query params, falling back to anonymous mode"
      );
      useAnonymousMode = true;
      // SECURITY: req.skyflowCredentials contains secrets — never log or serialize the request object.
      req.skyflowCredentials = { apiKey: anonApiKey };
      req.anonVaultConfig = { vaultId: anonVaultId, vaultUrl: anonVaultUrl };
    } else {
      return res.status(400).json({
        error:
          "Configuration error: Query parameters contain unsubstituted placeholders (e.g., ${SKYFLOW_VAULT_ID}). Please set your SKYFLOW_VAULT_ID and SKYFLOW_VAULT_URL environment variables, or contact the developer if anonymous mode is not working.",
      });
    }
  }

  if (useAnonymousMode && req.anonVaultConfig) {
    // Use anonymous mode configuration
    vaultId = req.anonVaultConfig.vaultId;
    vaultUrl = req.anonVaultConfig.vaultUrl;
  } else {
    // Use client-provided or environment configuration
    vaultId = (req.query.vaultId as string) || process.env.VAULT_ID;
    vaultUrl = (req.query.vaultUrl as string) || process.env.VAULT_URL;
  }

  // Validate vault configuration using extracted validation function
  const validation = validateVaultConfig({
    vaultId,
    vaultUrl,
  });

  if (!validation.isValid) {
    return res.status(400).json({ error: validation.error });
  }

  if (!req.skyflowCredentials) {
    return res.status(401).json({ error: "Credentials are required" });
  }

  // Use validated config
  const { vaultId: validatedVaultId, clusterId } = validation.config!;

  // Base URL for direct Detect REST calls, derived from clusterId the same way
  // the SDK builds its host — NOT from the client-supplied vaultUrl, which is
  // only loosely validated. This keeps the bearer credential from ever being
  // forwarded to a crafted host and keeps the REST and SDK paths on the same vault.
  const restVaultBaseUrl = getVaultBaseUrl(clusterId);

  // Raw bearer value (JWT or API key) for direct Detect REST calls
  const credentialKey =
    "token" in req.skyflowCredentials
      ? req.skyflowCredentials.token
      : req.skyflowCredentials.apiKey;

  // Create per-request Skyflow instance with credentials (bearer token or API key)
  let skyflowInstance: Skyflow;
  try {
    skyflowInstance = new Skyflow({
      vaultConfigs: [
        {
          vaultId: validatedVaultId,
          clusterId: clusterId,
          credentials: req.skyflowCredentials,
        },
      ],
    });
  } catch (error) {
    console.warn("Skyflow SDK initialization failed:", error instanceof Error ? error.message : "Unknown error");
    return res.status(401).json({
      error: "Invalid credentials. Please provide valid Skyflow bearer token or API key."
    });
  }

  // Create a new transport for each request to prevent request ID collisions
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
  });

  // Run the MCP request handling within the AsyncLocalStorage context
  // This makes the Skyflow instance available to all tools via getCurrentSkyflow()
  await requestContextStorage.run(
    {
      skyflow: skyflowInstance,
      vaultId: validatedVaultId,
      vaultUrl: restVaultBaseUrl,
      credentialKey,
      isAnonymousMode: useAnonymousMode,
    },
    async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
  );
});

// Export the Express app for serverless environments (like Vercel)
export default app;

// Only start the server if this file is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PORT || "3000");
  app
    .listen(port, () => {
      console.log(`Skyflow MCP Server running on http://localhost:${port}/mcp`);
    })
    .on("error", (error) => {
      console.error("Server error:", error);
      process.exit(1);
    });
}
