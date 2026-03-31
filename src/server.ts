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
import { deIdentifyHtml, reIdentifyHtml } from "./generated/ui-html.js";
import { Skyflow } from "skyflow-node";
import { AsyncLocalStorage } from "async_hooks";
import { validateVaultConfig, looksLikePlaceholder } from "./lib/validation/vaultConfig.js";
import { ENTITY_KEYS } from "./lib/mappings/entityMaps.js";
import { handleDeIdentify } from "./lib/tools/deIdentify.js";
import { handleReIdentify } from "./lib/tools/reIdentify.js";
import { toStructuredContent } from "./lib/tools/types.js";
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

// MCP Apps: Resource URIs
const DE_IDENTIFY_RESOURCE_URI = "ui://de-identify/mcp-app.html";
const RE_IDENTIFY_RESOURCE_URI = "ui://re-identify/mcp-app.html";

// Register UI resources for each tool
registerAppResource(server, "De-identify UI", DE_IDENTIFY_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: DE_IDENTIFY_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: deIdentifyHtml }],
}));

registerAppResource(server, "Re-identify UI", RE_IDENTIFY_RESOURCE_URI, {}, async () => ({
  contents: [{ uri: RE_IDENTIFY_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: reIdentifyHtml }],
}));

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
