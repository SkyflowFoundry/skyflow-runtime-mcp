import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setupHostTheming, applyInitialContext } from "../shared/theme.js";
import type { ReIdentifyFileResult } from "../shared/types.js";
import "../shared/styles.css";

const root = document.getElementById("root")!;

/** Text-like extensions we can decode and preview inline. */
const TEXT_EXTENSIONS = new Set(["txt", "json", "xml", "csv"]);

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function showLoading(fileName?: string): void {
  root.innerHTML = `
    <div class="container">
      ${fileName ? `
        <div class="stats-bar">
          <div class="stat">
            <span class="stat-value" style="font-size: 14px;">${escapeHtml(fileName)}</span>
            <span class="stat-label">File</span>
          </div>
        </div>
      ` : ""}
      <div class="loading">
        <div class="spinner"></div>
        <span>Restoring original data in file...</span>
      </div>
    </div>
  `;
}

function decodeBase64Text(base64: string): string | undefined {
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function renderResult(data: ReIdentifyFileResult): void {
  if (data.error || data.anonymousModeRestricted) {
    root.innerHTML = `
      <div class="container">
        <div class="banner banner-warning">
          ${escapeHtml(data.message || data.error || "An error occurred")}
        </div>
      </div>
    `;
    return;
  }

  const extension = data.extension || "bin";

  // Metadata cards
  const metaItems: { label: string; value: string }[] = [];
  if (data.inputFileName) metaItems.push({ label: "File Name", value: data.inputFileName });
  if (data.status) metaItems.push({ label: "Status", value: data.status });
  if (data.extension) metaItems.push({ label: "Extension", value: `.${data.extension}` });

  const metaHtml = metaItems.length
    ? `<div class="card-grid">${metaItems
        .map(
          (m) => `
        <div class="stat">
          <span class="stat-value">${escapeHtml(m.value)}</span>
          <span class="stat-label">${escapeHtml(m.label)}</span>
        </div>
      `
        )
        .join("")}</div>`
    : "";

  // Inline preview for text formats, download link for everything
  let previewHtml = "";
  let downloadHtml = "";
  if (data.processedFileData) {
    if (TEXT_EXTENSIONS.has(extension.toLowerCase())) {
      const text = decodeBase64Text(data.processedFileData);
      if (text !== undefined) {
        previewHtml = `
          <div class="section-heading">Re-identified Content</div>
          <div class="panel">
            <div class="panel-body" style="white-space: pre-wrap; max-height: 320px; overflow: auto;">${escapeHtml(text)}</div>
          </div>
        `;
      }
    }
    downloadHtml = `
      <div class="file-viewer" style="margin-top: 16px;">
        <a href="data:application/octet-stream;base64,${data.processedFileData}"
           download="reidentified.${escapeHtml(extension)}"
           style="display: inline-block; padding: 8px 16px; background: #403e6b; color: white; border-radius: var(--border-radius-md, 8px); text-decoration: none;">
          Download Re-identified File (.${escapeHtml(extension)})
        </a>
      </div>
    `;
  }

  root.innerHTML = `
    <div class="container">
      ${metaHtml}
      ${previewHtml}
      ${downloadHtml}
    </div>
  `;
}

// Set up MCP App
const app = new App({ name: "Skyflow Re-identify File", version: "1.0.0" });

setupHostTheming(app);

app.ontoolinput = (params) => {
  const args = params.arguments as Record<string, unknown> | undefined;
  showLoading(
    (args?.fileName as string | undefined) ?? (args?.fileUrl as string | undefined)
  );
};

app.ontoolresult = (result: CallToolResult) => {
  const data = (result as { structuredContent?: ReIdentifyFileResult }).structuredContent;
  if (data) {
    renderResult(data);
  }
};

app.onteardown = async () => ({});

app.connect(new PostMessageTransport()).then(() => {
  applyInitialContext(app);
  showLoading();
});
