import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express } from "express";
import { z } from "zod";
import {
  DeidentifyTextOptions,
  DeidentifyTextRequest,
  ReidentifyTextRequest,
  DeidentifyFileOptions,
  DeidentifyFileRequest,
  FileInput,
  TokenFormat,
  TokenType,
  Skyflow,
  SkyflowError,
} from "skyflow-node";
import { AsyncLocalStorage } from "async_hooks";
import {
  getEntityEnum,
  getMaskingMethodEnum,
  getTranscriptionEnum,
} from "./lib/mappings/entityMaps.js";
import { validateVaultConfig, looksLikePlaceholder } from "./lib/validation/vaultConfig.js";
import { authenticateBearer } from "./lib/middleware/authenticateBearer.js";
import {
  createAnonymousRateLimiter,
  getAnonymousRateLimitConfig,
} from "./lib/middleware/rateLimiter.js";

/** Default maximum wait time for file dehydration operations (in seconds) */
const DEFAULT_MAX_WAIT_TIME_SECONDS = 64;

/** TypeScript interface for detected entity response items */
interface DetectedEntityItem {
  file: string;
  extension: string;
}

/** TypeScript interface for dehydrate file output */
interface DeidentifyFileOutput {
  [x: string]: unknown;
  processedFileData?: string;
  mimeType?: string;
  extension?: string;
  detectedEntities?: Array<{
    file: string;
    extension: string;
  }>;
  wordCount?: number;
  charCount?: number;
  sizeInKb?: number;
  durationInSeconds?: number;
  pageCount?: number;
  slideCount?: number;
  runId?: string;
  status?: string;
}

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
  name: "demo-server",
  version: "1.0.0",
});

/**
 * Skyflow Dehydrate Tool
 * Replaces sensitive information in text with placeholder tokens
 */
server.registerTool(
  "dehydrate",
  {
    title: "Skyflow Dehydrate Tool",
    description:
      "Dehydrate sensitive information in strings using Skyflow. This tool accepts a string and returns another string, but with placeholders for sensitive data. The placeholders tell you what they are replacing. For example, a credit card number might be replaced with [CREDIT_CARD_abc123].",
    inputSchema: { inputString: z.string().min(1) },
    outputSchema: {
      processedText: z.string(),
      wordCount: z.number(),
      charCount: z.number(),
      anonymousMode: z
        .boolean()
        .optional()
        .describe("True when running in anonymous mode (no credentials provided)"),
      note: z
        .string()
        .optional()
        .describe("Additional information about the response, such as anonymous mode limitations"),
    },
  },
  async ({ inputString }) => {
    const anonymousMode = isAnonymousMode();

    const tokenFormat = new TokenFormat();
    if (anonymousMode) {
      // Anonymous mode: use ENTITY_UNIQUE_COUNTER (no vault storage)
      tokenFormat.setDefault(TokenType.ENTITY_UNIQUE_COUNTER);
    } else {
      // Authenticated mode: use VAULT_TOKEN (persistent storage)
      tokenFormat.setDefault(TokenType.VAULT_TOKEN);
    }

    const options = new DeidentifyTextOptions();
    options.setTokenFormat(tokenFormat);
    // TODO: add support for custom restrict regex list, include in the tool input schema
    // options.setRestrictRegexList([
    //   "/.{3,}@[a-zA-Z]{2,}\.[a-zA-Z]{2,}/g", // Email addresses with at least 3 characters before '@'
    // ]);
    // TODO: add support for custom allow regex list, include in the tool input schema. Note that allow wins over restrict if the same pattern is in both lists.
    // options.setAllowRegexList([
    //   "/.{3,}@[a-zA-Z]{2,}\.[a-zA-Z]{2,}/g", // Email addresses with at least 3 characters before '@'
    // ]);

    // Get the per-request Skyflow instance
    const skyflow = getCurrentSkyflow();

    const response = await skyflow
      .detect()
      .deidentifyText(new DeidentifyTextRequest(inputString), options);

    const output = {
      processedText: response.processedText,
      wordCount: response.wordCount,
      charCount: response.charCount,
      ...(anonymousMode && {
        anonymousMode: true,
        note: "Running in anonymous mode. Tokens are not persisted. Configure credentials for full functionality.",
      }),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
);

/**
 * Skyflow Rehydrate Tool
 * Restores original sensitive data from dehydrated placeholders
 */
server.registerTool(
  "rehydrate",
  {
    title: "Skyflow Rehydrate Tool",
    description:
      "Rehydrate previously dehydrated sensitive information in strings using Skyflow. This tool accepts a string with redacted placeholders (like [CREDIT_CARD_abc123]) and returns the original sensitive data.",
    inputSchema: { inputString: z.string().min(1) },
    outputSchema: {
      processedText: z.string(),
    },
  },
  async ({ inputString }) => {
    // Check if in anonymous mode
    if (isAnonymousMode()) {
      const errorOutput = {
        error: "rehydrate is not available in anonymous mode",
        anonymousModeRestricted: true,
        message:
          "The rehydrate tool requires authenticated access to restore sensitive data from vault tokens. " +
          "To use this feature, configure your Skyflow credentials:\n\n" +
          "1. Get your API key from the Skyflow dashboard\n" +
          "2. Add via Authorization header: 'Bearer <api-key>'\n" +
          "   Or via query parameter: '?apiKey=<api-key>'",
        helpUrl: "https://docs.skyflow.com/",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(errorOutput) }],
        structuredContent: errorOutput,
        isError: true,
      };
    }

    // Get the per-request Skyflow instance
    const skyflow = getCurrentSkyflow();

    const response = await skyflow
      .detect()
      .reidentifyText(new ReidentifyTextRequest(inputString));

    const output = {
      processedText: response.processedText,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
);

/**
 * Skyflow Dehydrate File Tool
 * Processes files to detect and redact sensitive information
 * Maximum file size: 5MB (due to base64 encoding overhead, original binary files should be ~3.75MB or less)
 */
server.registerTool(
  "dehydrate_file",
  {
    title: "Skyflow Dehydrate File Tool",
    description:
      "Dehydrate sensitive information in files (images, PDFs, audio, documents) using Skyflow. Accepts base64-encoded file data and returns the processed file with sensitive data redacted or masked. Maximum file size: 5MB (base64-encoded). Due to base64 encoding overhead, original binary files should be approximately 3.75MB or smaller.",
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
    },
  },
  async ({
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
  }) => {
    // Check if in anonymous mode
    if (isAnonymousMode()) {
      const errorOutput = {
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
      };
      return {
        content: [{ type: "text", text: JSON.stringify(errorOutput) }],
        structuredContent: errorOutput,
        isError: true,
      };
    }

    try {
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

      // Get the per-request Skyflow instance and vaultId
      const skyflow = getCurrentSkyflow();
      const vaultId = getCurrentVaultId();

      const response = await skyflow
        .detect(vaultId)
        .deidentifyFile(fileReq, options);

      // Prepare the output with proper typing
      const output: DeidentifyFileOutput = {};

      // If there's a processed file base64, include it
      if (response.fileBase64) {
        output.processedFileData = response.fileBase64;
      }

      // Include file metadata
      if (response.type) {
        output.mimeType = response.type;
      }

      if (response.extension) {
        output.extension = response.extension;
      }

      // Add detected entities if available with proper typing
      if (response.entities && response.entities.length > 0) {
        output.detectedEntities = response.entities.map(
          (e: DetectedEntityItem) => ({
            file: e.file,
            extension: e.extension,
          })
        );
      }

      // Add file statistics
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

      // Include run ID and status if this was an async operation
      if (response.runId) {
        output.runId = response.runId;
        output.status = response.status;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      if (error instanceof SkyflowError) {
        const errorOutput = {
          error: true,
          code: error.error?.http_code,
          message: error.message,
          details: error.error?.details,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(errorOutput) }],
          isError: true,
        };
      } else {
        const errorOutput = {
          error: true,
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(errorOutput) }],
          isError: true,
        };
      }
    }
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
