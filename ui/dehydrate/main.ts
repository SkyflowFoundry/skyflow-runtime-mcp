import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setupHostTheming, applyInitialContext } from "../shared/theme.js";
import type { EntityInfo, DehydrateResult } from "../shared/types.js";
import "../shared/styles.css";

const root = document.getElementById("root")!;

function showLoading(inputText?: string): void {
  root.innerHTML = `
    <div class="container">
      ${inputText ? `
        <div class="panel" style="margin-bottom: 16px">
          <div class="panel-header">Input</div>
          <div class="panel-body">${escapeHtml(inputText)}</div>
        </div>
      ` : ""}
      <div class="loading">
        <div class="spinner"></div>
        <span>Scanning for sensitive data...</span>
      </div>
    </div>
  `;
}

function getEntityClass(entity: string): string {
  const key = entity.toLowerCase().replace(/\s+/g, "_");
  return `entity-${key}`;
}

function highlightText(
  text: string,
  entities: EntityInfo[],
  indexKey: "textIndex" | "processedIndex"
): string {
  // Sort entities by start position descending so we can insert from end
  const sorted = entities
    .filter((e) => e[indexKey]?.start != null && e[indexKey]?.end != null)
    .sort((a, b) => (b[indexKey]!.start ?? 0) - (a[indexKey]!.start ?? 0));

  const segments: { start: number; end: number; entity: string }[] = [];

  for (const e of sorted) {
    const start = e[indexKey]!.start!;
    const end = e[indexKey]!.end!;
    const entity = e.entity || "default";
    segments.push({ start, end, entity });
  }

  // Sort ascending for building
  segments.sort((a, b) => a.start - b.start);

  // Build highlighted HTML
  let html = "";
  let pos = 0;
  for (const seg of segments) {
    if (seg.start < pos) continue; // skip overlapping segment
    if (seg.start > pos) {
      html += escapeHtml(text.slice(pos, seg.start));
    }
    const cls = getEntityClass(seg.entity);
    const label = seg.entity.replace(/_/g, " ");
    html += `<span class="entity-highlight ${cls}" title="${escapeHtml(label)}">`;
    html += escapeHtml(text.slice(seg.start, seg.end));
    html += `</span>`;
    pos = seg.end;
  }
  if (pos < text.length) {
    html += escapeHtml(text.slice(pos));
  }

  return html;
}

function renderResult(data: DehydrateResult): void {
  const entities = data.entities || [];
  const entityTypes = new Map<string, EntityInfo[]>();
  for (const e of entities) {
    const type = e.entity || "unknown";
    if (!entityTypes.has(type)) entityTypes.set(type, []);
    entityTypes.get(type)!.push(e);
  }

  const inputHighlighted = data.inputText
    ? highlightText(data.inputText, entities, "textIndex")
    : escapeHtml(data.processedText || "");

  const outputHighlighted = data.processedText
    ? highlightText(data.processedText, entities, "processedIndex")
    : "";

  // Build entity table rows
  let tableRows = "";
  const sortedTypes = [...entityTypes.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );

  for (const [type, items] of sortedTypes) {
    const cls = getEntityClass(type);
    const label = type.replace(/_/g, " ");

    // Average score
    let avgScore = "";
    const scoresArr: number[] = [];
    for (const item of items) {
      if (item.scores) {
        for (const v of Object.values(item.scores)) {
          scoresArr.push(v);
        }
      }
    }
    if (scoresArr.length > 0) {
      const avg = scoresArr.reduce((a, b) => a + b, 0) / scoresArr.length;
      const pct = Math.round(avg * 100);
      avgScore = `
        <div class="score-bar">
          <div class="score-bar-track"><div class="score-bar-fill" style="width: ${pct}%"></div></div>
          <span>${pct}%</span>
        </div>
      `;
    } else {
      avgScore = `<span style="color: var(--color-text-tertiary, #999)">-</span>`;
    }

    // Sample tokens
    const sampleTokens = items
      .slice(0, 3)
      .map((i) => i.token || "")
      .filter(Boolean)
      .join(", ");

    tableRows += `
      <tr>
        <td>
          <span class="badge ${cls}">
            <span class="badge-dot" style="background: var(--entity-color)"></span>
            ${escapeHtml(label)}
          </span>
        </td>
        <td>${items.length}</td>
        <td style="font-family: var(--font-mono, monospace); font-size: 11px;">${escapeHtml(sampleTokens)}</td>
        <td>${avgScore}</td>
      </tr>
    `;
  }

  root.innerHTML = `
    <div class="container">
      ${data.anonymousMode ? `
        <div class="banner banner-warning">
          <strong>Anonymous mode</strong>
          <div>Currently running in unauthenticated mode using ephemeral entity tokens. Configure Skyflow credentials for full functionality.</div>
        </div>
      ` : ""}

      <div class="panel" style="margin-bottom: 16px;">
        <div class="tab-bar">
          <button class="tab active" data-tab="dehydrated">Dehydrated</button>
          <button class="tab" data-tab="original">Original</button>
        </div>
        <div class="tab-content active" data-tab-content="dehydrated">
          <div class="panel-body">${outputHighlighted}</div>
        </div>
        <div class="tab-content" data-tab-content="original">
          <div class="panel-body">${inputHighlighted}</div>
        </div>
      </div>

      ${sortedTypes.length > 0 ? `
        <div class="section-heading">Entity Breakdown</div>
        <div class="stats-bar">
          <div class="stat">
            <span class="stat-value">${entities.length}</span>
            <span class="stat-label">Entities</span>
          </div>
          <div class="stat">
            <span class="stat-value">${entityTypes.size}</span>
            <span class="stat-label">Types</span>
          </div>
          <div class="stat">
            <span class="stat-value">${data.wordCount ?? "-"}</span>
            <span class="stat-label">Words</span>
          </div>
        </div>
        <div class="entity-table-wrap">
          <table class="entity-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Count</th>
                <th>Tokens</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      ` : ""}
    </div>
  `;

  // Wire up tab switching
  root.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab!;
      root.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      root.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      root.querySelector(`.tab-content[data-tab-content="${tabId}"]`)?.classList.add("active");
    });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Set up MCP App
const app = new App({ name: "Skyflow Dehydrate", version: "1.0.0" });

setupHostTheming(app);

app.ontoolinput = (params) => {
  const args = params.arguments as Record<string, unknown> | undefined;
  showLoading(args?.inputString as string | undefined);
};

app.ontoolresult = (result: CallToolResult) => {
  const data = (result as { structuredContent?: DehydrateResult }).structuredContent;
  if (data) {
    renderResult(data);
  }
};

app.onteardown = async () => ({});

app.connect(new PostMessageTransport()).then(() => {
  applyInitialContext(app);
  showLoading();
});
