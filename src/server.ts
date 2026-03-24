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
import fs from "node:fs/promises";
import path from "node:path";
import { Skyflow } from "skyflow-node";
import { AsyncLocalStorage } from "async_hooks";
import { validateVaultConfig, looksLikePlaceholder } from "./lib/validation/vaultConfig.js";
import { handleDehydrate } from "./lib/tools/dehydrate.js";
import { handleRehydrate } from "./lib/tools/rehydrate.js";
import { handleDehydrateFile } from "./lib/tools/dehydrateFile.js";
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
  isAnonymousMode: boolean;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the Skyflow instance for the current request context
 */
function getCurrentSkyflow(): Skyflow {
  const context = requestContextStorage.getStore();
  if (!context) {
    throw new Error("No Skyflow instance available in current request context");
  }
  return context.skyflow;
}

/**
 * Get the vaultId for the current request context
 */
function getCurrentVaultId(): string {
  const context = requestContextStorage.getStore();
  if (!context) {
    throw new Error("No vaultId available in current request context");
  }
  return context.vaultId;
}

/**
 * Check if the current request is in anonymous mode
 */
function isAnonymousMode(): boolean {
  const context = requestContextStorage.getStore();
  if (!context) {
    throw new Error("No request context available");
  }
  return context.isAnonymousMode;
}

// Create an MCP server
const server = new McpServer({
  name: "Skyflow Runtime MCP Server",
  version: "0.4.0",
});

// MCP Apps: Resource URIs and UI directory
const DIST_UI_DIR = path.resolve(import.meta.dirname, "..", "dist", "ui");
const DEHYDRATE_RESOURCE_URI = "ui://dehydrate/mcp-app.html";
const REHYDRATE_RESOURCE_URI = "ui://rehydrate/mcp-app.html";
const DEHYDRATE_FILE_RESOURCE_URI = "ui://dehydrate-file/mcp-app.html";

// Helper to read a built UI HTML file, cached lazily on first request
const uiHtmlCache = new Map<string, string>();
async function readUiHtml(toolDir: string): Promise<string> {
  let cached = uiHtmlCache.get(toolDir);
  if (!cached) {
    cached = await fs.readFile(path.join(DIST_UI_DIR, toolDir, "mcp-app.html"), "utf-8");
    uiHtmlCache.set(toolDir, cached);
  }
  return cached;
}

// Register UI resources for each tool
registerAppResource(server, "Dehydrate UI", DEHYDRATE_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: DEHYDRATE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await readUiHtml("dehydrate") }],
}));

registerAppResource(server, "Rehydrate UI", REHYDRATE_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: REHYDRATE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await readUiHtml("rehydrate") }],
}));

registerAppResource(server, "Dehydrate File UI", DEHYDRATE_FILE_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: DEHYDRATE_FILE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await readUiHtml("dehydrate-file") }],
}));

/**
 * Skyflow Dehydrate Tool
 * Replaces sensitive information in text with placeholder tokens
 */
registerAppTool(
  server,
  "dehydrate",
  {
    title: "Skyflow Dehydrate Tool",
    description:
      "Dehydrate sensitive information in strings using Skyflow. This tool accepts a string and returns another string, but with placeholders for sensitive data. The placeholders tell you what they are replacing. For example, a credit card number might be replaced with [CREDIT_CARD_abc123].",
    inputSchema: { inputString: z.string().min(1).describe("Original Text — paste the text you want to scan for sensitive data") },
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
    _meta: { ui: { resourceUri: DEHYDRATE_RESOURCE_URI } },
  },
  async ({ inputString }) => {
    const result = await handleDehydrate(inputString, getCurrentSkyflow(), isAnonymousMode());
    return {
      content: [{ type: "text", text: JSON.stringify(result.output) }],
      structuredContent: result.output as unknown as Record<string, unknown>,
      ...(result.isError && { isError: true }),
    };
  }
);

/**
 * Skyflow Rehydrate Tool
 * Restores original sensitive data from dehydrated placeholders
 */
registerAppTool(
  server,
  "rehydrate",
  {
    title: "Skyflow Rehydrate Tool",
    description:
      "Rehydrate previously dehydrated sensitive information in strings using Skyflow. This tool accepts a string with redacted placeholders (like [CREDIT_CARD_abc123]) and returns the original sensitive data.",
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
    _meta: { ui: { resourceUri: REHYDRATE_RESOURCE_URI } },
  },
  async ({ inputString }) => {
    const result = await handleRehydrate(inputString, getCurrentSkyflow(), isAnonymousMode());
    return {
      content: [{ type: "text", text: JSON.stringify(result.output) }],
      structuredContent: result.output as unknown as Record<string, unknown>,
      ...(result.isError && { isError: true }),
    };
  }
);

/**
 * Skyflow Dehydrate File Tool
 * Processes files to detect and redact sensitive information
 * Maximum file size: 5MB (due to base64 encoding overhead, original binary files should be ~3.75MB or less)
 */
registerAppTool(
  server,
  "dehydrate_file",
  {
    title: "Skyflow Dehydrate File Tool",
    description:
      "Dehydrate sensitive information in files (images, PDFs, audio, documents) using Skyflow. Accepts base64-encoded file data and returns the processed file with sensitive data redacted or masked. Maximum file size: 5MB (base64-encoded). Due to base64 encoding overhead, original binary files should be approximately 3.75MB or smaller.",
    _meta: { ui: { resourceUri: DEHYDRATE_FILE_RESOURCE_URI } },
    inputSchema: {
      fileData: z.string().min(1).describe("Base64-encoded file content"),
      fileName: z.string().describe("Original filename for type detection"),
      mimeType: z
        .string()
        .optional()
        .describe("MIME type of the file (e.g., image/png, audio/mp3)"),
      entities: z
        .array(
          z.enum([
            "age",
            "bank_account",
            "credit_card",
            "credit_card_expiration",
            "cvv",
            "date",
            "date_interval",
            "dob",
            "driver_license",
            "email_address",
            "healthcare_number",
            "ip_address",
            "location",
            "name",
            "numerical_pii",
            "phone_number",
            "ssn",
            "url",
            "vehicle_id",
            "medical_code",
            "name_family",
            "name_given",
            "account_number",
            "event",
            "filename",
            "gender",
            "language",
            "location_address",
            "location_city",
            "location_coordinate",
            "location_country",
            "location_state",
            "location_zip",
            "marital_status",
            "money",
            "name_medical_professional",
            "occupation",
            "organization",
            "organization_medical_facility",
            "origin",
            "passport_number",
            "password",
            "physical_attribute",
            "political_affiliation",
            "religion",
            "time",
            "username",
            "zodiac_sign",
            "blood_type",
            "condition",
            "dose",
            "drug",
            "injury",
            "medical_process",
            "statistics",
            "routing_number",
            "corporate_action",
            "financial_metric",
            "product",
            "trend",
            "duration",
            "location_address_street",
            "all",
            "sexuality",
            "effect",
            "project",
            "organization_id",
            "day",
            "month",
          ])
        )
        .optional()
        .describe(
          "Specific entities to detect. Leave empty to detect all supported entities."
        ),
      maskingMethod: z
        .enum(["BLACKBOX", "BLUR"])
        .optional()
        .describe("Masking method for images (BLACKBOX or BLUR)"),
      outputProcessedFile: z
        .boolean()
        .optional()
        .describe("Whether to include the processed file in the response"),
      outputOcrText: z
        .boolean()
        .optional()
        .describe("For images/PDFs: include OCR text in response"),
      outputTranscription: z
        .enum(["PLAINTEXT_TRANSCRIPTION", "DIARIZED_TRANSCRIPTION"])
        .optional()
        .describe(
          "For audio: type of transcription (PLAINTEXT_TRANSCRIPTION or DIARIZED_TRANSCRIPTION)"
        ),
      pixelDensity: z
        .number()
        .optional()
        .describe("For PDFs: pixel density (default 300)"),
      maxResolution: z
        .number()
        .optional()
        .describe("For PDFs: max resolution (default 2000)"),
      waitTime: z
        .number()
        .min(1)
        .max(64)
        .optional()
        .describe("Wait time for response in seconds (max 64)"),
    },
    outputSchema: {
      inputFileName: z.string().optional().describe("Original filename"),
      inputMimeType: z.string().optional().describe("Original MIME type"),
      processedFileData: z
        .string()
        .optional()
        .describe("Base64-encoded processed file"),
      mimeType: z
        .string()
        .optional()
        .describe("MIME type of the processed file"),
      extension: z
        .string()
        .optional()
        .describe("File extension of the processed file"),
      detectedEntities: z
        .array(
          z.object({
            file: z
              .string()
              .describe("Base64-encoded file with redacted entity"),
            extension: z.string().describe("File extension"),
          })
        )
        .optional()
        .describe("List of detected entities as separate files"),
      wordCount: z.number().optional().describe("Number of words processed"),
      charCount: z
        .number()
        .optional()
        .describe("Number of characters processed"),
      sizeInKb: z.number().optional().describe("Size of processed file in KB"),
      durationInSeconds: z
        .number()
        .optional()
        .describe("Duration for audio files in seconds"),
      pageCount: z
        .number()
        .optional()
        .describe("Number of pages for documents"),
      slideCount: z
        .number()
        .optional()
        .describe("Number of slides for presentations"),
      runId: z.string().optional().describe("Run ID for async operations"),
      status: z.string().optional().describe("Status of the operation"),
      error: z.union([z.boolean(), z.string()]).optional().describe("Error indicator or message"),
      anonymousModeRestricted: z.boolean().optional().describe("True when blocked due to anonymous mode"),
      message: z.string().optional().describe("Detailed error or setup instructions"),
      helpUrl: z.string().optional().describe("URL for setup documentation"),
      alternativeTool: z.string().optional().describe("Suggested alternative tool to use"),
      code: z.number().optional().describe("HTTP error code from Skyflow API"),
      details: z.unknown().optional().describe("Additional error details from Skyflow API"),
    },
  },
  async (args) => {
    const result = await handleDehydrateFile(args, getCurrentSkyflow(), getCurrentVaultId(), isAnonymousMode());
    return {
      content: [{ type: "text", text: JSON.stringify(result.output) }],
      structuredContent: result.output as unknown as Record<string, unknown>,
      ...(result.isError && { isError: true }),
    };
  }
);

const app: Express = express();
app.use(express.json({ limit: "5mb" })); // Limit for base64-encoded files

// Serve static files from the public directory
app.use(express.static("public"));

// Create rate limiter for anonymous mode
const anonymousRateLimiter = createAnonymousRateLimiter(
  getAnonymousRateLimitConfig()
);

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

app.post("/mcp", authenticateBearer, anonymousRateLimiter, async (req, res) => {
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

  const accountId = (req.query.accountId as string) || process.env.ACCOUNT_ID;
  const workspaceId =
    (req.query.workspaceId as string) || process.env.WORKSPACE_ID;

  // Validate vault configuration using extracted validation function
  const validation = validateVaultConfig({
    vaultId,
    vaultUrl,
    accountId,
    workspaceId,
  });

  if (!validation.isValid) {
    return res.status(400).json({ error: validation.error });
  }

  if (!req.skyflowCredentials) {
    return res.status(401).json({ error: "Credentials are required" });
  }

  // Use validated config
  const { vaultId: validatedVaultId, clusterId } = validation.config!;

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
