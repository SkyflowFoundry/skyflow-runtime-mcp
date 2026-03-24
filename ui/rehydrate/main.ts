import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setupHostTheming, applyInitialContext } from "../shared/theme.js";
import type { RehydrateResult } from "../shared/types.js";
import "../shared/styles.css";

const root = document.getElementById("root")!;

// Token pattern: [ENTITY_TYPE_identifier] or [ENTITY_TYPE_N]
const TOKEN_REGEX = /\[([A-Z_]+?)_([a-zA-Z0-9]+)\]/g;

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function showLoading(inputText?: string): void {
  root.innerHTML = `
    <div class="container">
      ${inputText ? `
        <div class="panel" style="margin-bottom: 16px">
          <div class="panel-header">Input (Tokenized)</div>
          <div class="panel-body">${escapeHtml(inputText)}</div>
        </div>
      ` : ""}
      <div class="loading">
        <div class="spinner"></div>
        <span>Restoring original data...</span>
      </div>
    </div>
  `;
}

function getEntityClass(entityType: string): string {
  const key = entityType.toLowerCase().replace(/\s+/g, "_");
  return `entity-${key}`;
}

interface TokenMapping {
  token: string;
  entityType: string;
  originalValue: string;
  inputStart: number;
  inputEnd: number;
  outputStart: number;
  outputEnd: number;
}

function buildTokenMappings(inputText: string, processedText: string): TokenMapping[] {
  const mappings: TokenMapping[] = [];

  // Find all tokens in input
  const tokens: { token: string; entityType: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(TOKEN_REGEX.source, "g");
  while ((match = regex.exec(inputText)) !== null) {
    tokens.push({
      token: match[0],
      entityType: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  if (tokens.length === 0) return mappings;

  // Split input by tokens to get the non-token segments
  let inputPos = 0;
  let processedPos = 0;

  for (const t of tokens) {
    // Advance past the text before this token (same in both strings)
    const prefixLen = t.start - inputPos;
    processedPos += prefixLen;

    // Now find where the replacement ends in processed text
    // The next non-token segment starts after this token in input
    const nextTokenIdx = tokens.indexOf(t) + 1;
    const nextInputPos = nextTokenIdx < tokens.length ? tokens[nextTokenIdx].start : inputText.length;
    const suffixInInput = inputText.slice(t.end, nextInputPos);

    let replacementEnd: number;
    if (suffixInInput.length > 0) {
      // Find the suffix in processed text after current position
      const suffixIdx = processedText.indexOf(suffixInInput, processedPos);
      replacementEnd = suffixIdx > processedPos ? suffixIdx : processedPos;
    } else {
      // Last token — replacement goes to end of processed text
      replacementEnd = processedText.length;
    }

    const originalValue = processedText.slice(processedPos, replacementEnd);

    mappings.push({
      token: t.token,
      entityType: t.entityType,
      originalValue,
      inputStart: t.start,
      inputEnd: t.end,
      outputStart: processedPos,
      outputEnd: replacementEnd,
    });

    inputPos = t.end;
    processedPos = replacementEnd;
  }

  return mappings;
}

function highlightTokensInInput(text: string, mappings: TokenMapping[]): string {
  const sorted = [...mappings].sort((a, b) => a.inputStart - b.inputStart);
  let html = "";
  let pos = 0;

  for (const m of sorted) {
    if (m.inputStart > pos) {
      html += escapeHtml(text.slice(pos, m.inputStart));
    }
    const cls = getEntityClass(m.entityType);
    const label = m.entityType.replace(/_/g, " ");
    html += `<span class="entity-highlight ${cls}" title="${escapeHtml(label)}: ${escapeHtml(m.originalValue)}">`;
    html += escapeHtml(m.token);
    html += `</span>`;
    pos = m.inputEnd;
  }
  if (pos < text.length) {
    html += escapeHtml(text.slice(pos));
  }

  return html;
}

function highlightValuesInOutput(text: string, mappings: TokenMapping[]): string {
  // Use computed output positions from buildTokenMappings instead of indexOf
  const sorted = [...mappings]
    .filter((m) => m.originalValue)
    .sort((a, b) => a.outputStart - b.outputStart);

  let html = "";
  let pos = 0;

  for (const m of sorted) {
    if (m.outputStart < pos) continue; // skip overlapping
    if (m.outputStart > pos) {
      html += escapeHtml(text.slice(pos, m.outputStart));
    }
    const cls = getEntityClass(m.entityType);
    const label = m.entityType.replace(/_/g, " ");
    html += `<span class="entity-highlight ${cls}" title="${escapeHtml(label)}: ${escapeHtml(m.token)}">`;
    html += escapeHtml(text.slice(m.outputStart, m.outputEnd));
    html += `</span>`;
    pos = m.outputEnd;
  }
  if (pos < text.length) {
    html += escapeHtml(text.slice(pos));
  }

  return html;
}

function renderResult(data: RehydrateResult): void {
  if (data.error || data.anonymousModeRestricted) {
    const isAnonymous = data.anonymousModeRestricted;
    root.innerHTML = `
      <div class="container">
        <div class="banner banner-warning">
          ${isAnonymous ? `
            <strong>Anonymous mode</strong>
            <div>Currently running in unauthenticated mode using ephemeral entity tokens. Configure Skyflow credentials for full functionality.</div>
          ` : escapeHtml(data.message || data.error || "An error occurred")}
        </div>
      </div>
    `;
    return;
  }

  const inputText = data.inputText || "";
  const processedText = data.processedText || "";
  const mappings = buildTokenMappings(inputText, processedText);

  const inputHighlighted = highlightTokensInInput(inputText, mappings);
  const outputHighlighted = highlightValuesInOutput(processedText, mappings);

  // Build mapping table
  let tableRows = "";
  for (const m of mappings) {
    const cls = getEntityClass(m.entityType);
    const label = m.entityType.replace(/_/g, " ");
    tableRows += `
      <tr>
        <td>
          <span class="badge ${cls}">
            <span class="badge-dot" style="background: var(--entity-color)"></span>
            ${escapeHtml(label)}
          </span>
        </td>
        <td style="font-family: var(--font-mono, monospace); font-size: 11px;">${escapeHtml(m.token)}</td>
        <td style="font-family: var(--font-mono, monospace); font-size: 11px;">${escapeHtml(m.originalValue)}</td>
      </tr>
    `;
  }

  root.innerHTML = `
    <div class="container">
      <div class="stats-bar">
        <div class="stat">
          <span class="stat-value">${mappings.length}</span>
          <span class="stat-label">Tokens Restored</span>
        </div>
      </div>

      <div class="panels">
        <div class="panel">
          <div class="panel-header">Tokenized Input</div>
          <div class="panel-body">${inputHighlighted}</div>
        </div>
        <div class="panel">
          <div class="panel-header">Restored Output</div>
          <div class="panel-body">${outputHighlighted}</div>
        </div>
      </div>

      ${mappings.length > 0 ? `
        <div class="section-heading">Token Mappings</div>
        <div class="entity-table-wrap">
          <table class="entity-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Token</th>
                <th>Original Value</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      ` : ""}
    </div>
  `;
}

// Set up MCP App
const app = new App({ name: "Skyflow Rehydrate", version: "1.0.0" });

setupHostTheming(app);

app.ontoolinput = (params) => {
  const args = params.arguments as Record<string, unknown> | undefined;
  showLoading(args?.inputString as string | undefined);
};

app.ontoolresult = (result: CallToolResult) => {
  const data = (result as { structuredContent?: RehydrateResult }).structuredContent;
  if (data) {
    renderResult(data);
  }
};

app.onteardown = async () => ({});

app.connect(new PostMessageTransport()).then(() => {
  applyInitialContext(app);
  showLoading();
});
