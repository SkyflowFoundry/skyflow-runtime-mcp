export interface VaultConfig {
  vaultId: string;
  vaultUrl: string;
  clusterId: string;
}

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  config?: VaultConfig;
}

/**
 * Check if a value looks like an unsubstituted template placeholder
 * Detects patterns like ${VAR_NAME}, $VAR_NAME, {{VAR}}, %VAR%
 *
 * @param value - The string to check
 * @returns true if the value appears to be an unsubstituted placeholder
 *
 * @example
 * looksLikePlaceholder("${SKYFLOW_VAULT_ID}") // => true
 * looksLikePlaceholder("$VAULT_ID") // => true
 * looksLikePlaceholder("{{vault_id}}") // => true
 * looksLikePlaceholder("%VAULT_ID%") // => true
 * looksLikePlaceholder("abc123") // => false
 * looksLikePlaceholder("https://abc.vault.skyflowapis.com") // => false
 */
export function looksLikePlaceholder(value: string | undefined): boolean {
  if (!value) return false;

  // ${VAR_NAME} - shell/env var style (most common)
  if (/^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value)) return true;

  // $VAR_NAME - direct env var reference
  if (/^\$[A-Z_][A-Z0-9_]*$/i.test(value)) return true;

  // {{VAR_NAME}} - mustache/handlebars style
  if (/^\{\{[A-Z_][A-Z0-9_]*\}\}$/i.test(value)) return true;

  // %VAR_NAME% - Windows env var style
  if (/^%[A-Z_][A-Z0-9_]*%$/i.test(value)) return true;

  return false;
}

/**
 * Extract clusterId from vaultUrl
 * Pure function - easy to test!
 *
 * @param vaultUrl - The vault URL (with or without https:// prefix)
 * @returns The cluster ID or null if invalid format
 *
 * @example
 * extractClusterId("https://abc123.vault.skyflowapis.com") // => "abc123"
 * extractClusterId("abc123.vault.skyflowapis.com") // => "abc123"
 * extractClusterId("https://invalid.com") // => null
 */
export function extractClusterId(vaultUrl: string): string | null {
  // Match with or without https:// prefix
  const match = vaultUrl.match(/(?:https?:\/\/)?([^.]+)\.vault/);
  return match?.[1] ?? null;
}

/**
 * Build the Skyflow vault REST base URL from a clusterId.
 *
 * Mirrors the skyflow-node SDK's `getVaultURL(clusterId, Env.PROD)`
 * (`https://<clusterId>.vault.skyflowapis.com`). Direct Detect REST calls MUST
 * use this rather than the client-supplied `vaultUrl`: `extractClusterId` only
 * requires the substring `<id>.vault` to appear anywhere, so a crafted
 * `vaultUrl` like `https://abc.vault.attacker.com` passes validation. The SDK
 * builds its host from `clusterId` alone, so deriving the REST base the same
 * way guarantees both paths hit the same Skyflow host and the bearer credential
 * is never forwarded to an attacker-controlled domain.
 *
 * Env assumption: this hardcodes the PROD host, matching the SDK instance this
 * server creates (which passes only `clusterId`, so the SDK defaults to
 * `Env.PROD`). If the server is ever pointed at a non-prod Skyflow environment,
 * update both the SDK config and this helper together — otherwise the
 * REST-based tools would target prod while the SDK path targets the other env.
 *
 * @param clusterId - The cluster identifier extracted from the vault URL
 * @returns The `https://<clusterId>.vault.skyflowapis.com` base URL
 */
export function getVaultBaseUrl(clusterId: string): string {
  return `https://${clusterId}.vault.skyflowapis.com`;
}

/**
 * Validate vault configuration parameters
 * Pure function that returns validation result with error message if invalid
 *
 * @param params - Vault configuration parameters
 * @returns ValidationResult with isValid, optional error, and optional config
 *
 * @example
 * validateVaultConfig({
 *   vaultId: "vault123",
 *   vaultUrl: "https://abc.vault.skyflowapis.com"
 * })
 * // => { isValid: true, config: { vaultId: "vault123", ... } }
 */
export function validateVaultConfig(params: {
  vaultId?: string;
  vaultUrl?: string;
}): ValidationResult {
  if (!params.vaultId) {
    return {
      isValid: false,
      error:
        "vaultId is required (provide as query parameter or VAULT_ID environment variable)",
    };
  }

  if (!params.vaultUrl) {
    return {
      isValid: false,
      error:
        "vaultUrl is required (provide as query parameter or VAULT_URL environment variable)",
    };
  }

  const clusterId = extractClusterId(params.vaultUrl);
  if (!clusterId) {
    return {
      isValid: false,
      error:
        "Invalid vaultUrl format. Expected format: https://<clusterId>.vault.skyflowapis.com or <clusterId>.vault.skyflowapis.com",
    };
  }

  return {
    isValid: true,
    config: {
      vaultId: params.vaultId,
      vaultUrl: params.vaultUrl,
      clusterId,
    },
  };
}
