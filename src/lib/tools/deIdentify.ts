import {
  DeidentifyTextOptions,
  DeidentifyTextRequest,
  SkyflowError,
  TokenFormat,
  TokenType,
} from "skyflow-node";
import type { Skyflow } from "skyflow-node";
import type { DeIdentifyOutput, DeIdentifyErrorOutput, ToolResult } from "./types.js";

/**
 * Handle the de-identify tool logic.
 * Detects and replaces sensitive information in text with tokens.
 */
export async function handleDeIdentify(
  inputString: string,
  skyflow: Skyflow,
  anonymousMode: boolean
): Promise<ToolResult<DeIdentifyOutput | DeIdentifyErrorOutput>> {
  try {
    const tokenFormat = new TokenFormat();
    if (anonymousMode) {
      tokenFormat.setDefault(TokenType.ENTITY_UNIQUE_COUNTER);
    } else {
      tokenFormat.setDefault(TokenType.VAULT_TOKEN);
    }

    const options = new DeidentifyTextOptions();
    options.setTokenFormat(tokenFormat);

    const response = await skyflow
      .detect()
      .deidentifyText(new DeidentifyTextRequest(inputString), options);

    return {
      output: {
        inputText: inputString,
        processedText: response.processedText,
        wordCount: response.wordCount,
        charCount: response.charCount,
        entities: response.entities.map((e) => ({
          token: e.token,
          value: e.value,
          entity: e.entity,
          textIndex: e.textIndex,
          processedIndex: e.processedIndex,
          scores: e.scores,
        })),
        ...(anonymousMode && {
          anonymousMode: true,
          note: "Running in anonymous mode. Tokens are not persisted. Configure credentials for full functionality.",
        }),
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
