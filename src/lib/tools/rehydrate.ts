import { ReidentifyTextRequest, SkyflowError } from "skyflow-node";
import type { Skyflow } from "skyflow-node";
import type { RehydrateOutput, RehydrateErrorOutput, AnonymousModeError, ToolResult } from "./types.js";

/**
 * Handle the rehydrate tool logic.
 * Restores original sensitive data from dehydrated placeholders.
 */
export async function handleRehydrate(
  inputString: string,
  skyflow: Skyflow,
  anonymousMode: boolean
): Promise<ToolResult<RehydrateOutput | AnonymousModeError | RehydrateErrorOutput>> {
  if (anonymousMode) {
    return {
      output: {
        error: "rehydrate is not available in anonymous mode",
        anonymousModeRestricted: true,
        message:
          "The rehydrate tool requires authenticated access to restore sensitive data from vault tokens. " +
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
    const response = await skyflow
      .detect()
      .reidentifyText(new ReidentifyTextRequest(inputString));

    return {
      output: {
        inputText: inputString,
        processedText: response.processedText,
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
