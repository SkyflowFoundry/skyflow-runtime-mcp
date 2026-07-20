/**
 * Tool-level scope enforcement for enterprise-managed authorization.
 *
 * The enterprise IdP grants scopes in the ID-JAG (per admin policy), the
 * token endpoint copies them into the issued access token, and this module
 * enforces them when tools are invoked. Convention: each scope value names a
 * permitted tool (e.g. "de-identify", "re-identify").
 *
 * A token WITHOUT a scope claim is unrestricted — the IdP chose to gate at
 * the connection level only. A token WITH a scope claim is restricted to
 * exactly the named tools.
 */

/**
 * Standard OIDC identity scopes. IdPs commonly include these in every grant
 * (they describe identity data, not tool policy), so they are ignored when
 * deciding tool access — otherwise a default "openid profile email" claim
 * would silently deny every tool.
 */
const OIDC_IDENTITY_SCOPES = new Set([
  "openid",
  "profile",
  "email",
  "address",
  "phone",
  "offline_access",
]);

/**
 * Parse the space-delimited scope claim from an enterprise access token.
 *
 * - No scope claim → undefined (unrestricted)
 * - Claim with only standard OIDC identity scopes → undefined (they carry
 *   no tool policy; connection-level gating was intended)
 * - Empty claim ("") → [] (explicit deny-all)
 * - Anything else → the non-identity scope values; unrecognized custom
 *   scopes deny tools (fail closed) with an error naming what was granted
 */
export function parseGrantedScopes(
  scope: string | undefined
): string[] | undefined {
  if (scope === undefined) {
    return undefined;
  }
  const values = scope.split(" ").filter((s) => s.length > 0);
  const toolScopes = values.filter((s) => !OIDC_IDENTITY_SCOPES.has(s));
  if (values.length > 0 && toolScopes.length === 0) {
    return undefined;
  }
  return toolScopes;
}

/**
 * Check whether a tool may be invoked under the granted scopes.
 * `undefined` scopes (no scope claim, or non-enterprise request) permit all.
 */
export function isToolPermitted(
  toolName: string,
  grantedScopes: string[] | undefined
): boolean {
  return grantedScopes === undefined || grantedScopes.includes(toolName);
}

/** Structured error output returned when a tool is denied by scope */
export interface ScopeDenialOutput {
  error: string;
  message: string;
  [key: string]: unknown;
}

export function buildScopeDenial(
  toolName: string,
  grantedScopes: string[]
): ScopeDenialOutput {
  return {
    error: "insufficient_scope",
    message:
      `The enterprise access token does not grant the "${toolName}" scope. ` +
      (grantedScopes.length > 0
        ? `Granted scopes: ${grantedScopes.join(", ")}.`
        : "The token grants no tool scopes.") +
      " Ask your identity provider administrator to grant access to this tool.",
  };
}
