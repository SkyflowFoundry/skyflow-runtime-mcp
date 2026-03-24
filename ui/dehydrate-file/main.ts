import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setupHostTheming, applyInitialContext } from "../shared/theme.js";
import "../shared/styles.css";

interface DehydrateFileResult {
  inputFileName?: string;
  inputMimeType?: string;
  processedFileData?: string;
  mimeType?: string;
  extension?: string;
  detectedEntities?: Array<{ file: string; extension: string }>;
  wordCount?: number;
  charCount?: number;
  sizeInKb?: number;
  durationInSeconds?: number;
  pageCount?: number;
  slideCount?: number;
  runId?: string;
  status?: string;
  error?: string;
  message?: string;
  anonymousModeRestricted?: boolean;
}

const root = document.getElementById("root")!;

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function showLoading(fileName?: string, mimeType?: string): void {
  root.innerHTML = `
    <div class="container">
      ${fileName ? `
        <div class="stats-bar">
          <div class="stat">
            <span class="stat-value" style="font-size: 14px;">${escapeHtml(fileName)}</span>
            <span class="stat-label">File</span>
          </div>
          ${mimeType ? `
            <div class="stat">
              <span class="stat-value" style="font-size: 14px;">${escapeHtml(mimeType)}</span>
              <span class="stat-label">Type</span>
            </div>
          ` : ""}
        </div>
      ` : ""}
      <div class="loading">
        <div class="spinner"></div>
        <span>Processing file for sensitive data...</span>
      </div>
    </div>
  `;
}

function formatSize(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${Math.round(kb)} KB`;
}

function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    const min = Math.floor(seconds / 60);
    const sec = Math.round(seconds % 60);
    return `${min}m ${sec}s`;
  }
  return `${Math.round(seconds)}s`;
}

function renderResult(data: DehydrateFileResult): void {
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

  const mime = data.mimeType || data.inputMimeType || "";
  const isImage = mime.startsWith("image/");
  const isAudio = mime.startsWith("audio/");

  // Build file viewer
  let fileViewerHtml = "";
  if (data.processedFileData) {
    if (isImage) {
      fileViewerHtml = `
        <div class="section-heading">Processed File</div>
        <div class="file-viewer">
          <img src="data:${escapeHtml(mime)};base64,${data.processedFileData}" alt="Processed file" loading="lazy" />
        </div>
      `;
    } else if (isAudio) {
      fileViewerHtml = `
        <div class="section-heading">Processed Audio</div>
        <div class="file-viewer">
          <audio controls src="data:${escapeHtml(mime)};base64,${data.processedFileData}"></audio>
        </div>
      `;
    } else {
      const ext = data.extension || "bin";
      fileViewerHtml = `
        <div class="section-heading">Processed File</div>
        <div class="file-viewer">
          <a href="data:${escapeHtml(mime)};base64,${data.processedFileData}"
             download="processed.${escapeHtml(ext)}"
             style="display: inline-block; padding: 8px 16px; background: #403e6b; color: white; border-radius: var(--border-radius-md, 8px); text-decoration: none;">
            Download Processed File (.${escapeHtml(ext)})
          </a>
        </div>
      `;
    }
  }

  // Build metadata cards
  const metaItems: { label: string; value: string }[] = [];
  if (data.inputFileName) metaItems.push({ label: "File Name", value: data.inputFileName });
  if (data.sizeInKb != null) metaItems.push({ label: "Size", value: formatSize(data.sizeInKb) });
  if (data.wordCount != null) metaItems.push({ label: "Words", value: String(data.wordCount) });
  if (data.charCount != null) metaItems.push({ label: "Characters", value: String(data.charCount) });
  if (data.pageCount != null) metaItems.push({ label: "Pages", value: String(data.pageCount) });
  if (data.slideCount != null) metaItems.push({ label: "Slides", value: String(data.slideCount) });
  if (data.durationInSeconds != null) metaItems.push({ label: "Duration", value: formatDuration(data.durationInSeconds) });
  if (data.extension) metaItems.push({ label: "Extension", value: `.${data.extension}` });

  let metaHtml = "";
  if (metaItems.length > 0) {
    const cards = metaItems
      .map(
        (m) => `
        <div class="stat">
          <span class="stat-value">${escapeHtml(m.value)}</span>
          <span class="stat-label">${escapeHtml(m.label)}</span>
        </div>
      `
      )
      .join("");
    metaHtml = `
      <div class="card-grid">${cards}</div>
    `;
  }

  // Status badge for async operations
  let statusHtml = "";
  if (data.runId) {
    const statusColor = data.status === "completed" ? "var(--color-text-success, #27ae60)" : "var(--color-text-warning, #f39c12)";
    statusHtml = `
      <div class="banner" style="background: var(--color-background-secondary, #f8f9fa); border: 1px solid var(--color-border-secondary, #e0e0e0); margin-bottom: 16px;">
        <strong>Status:</strong> <span style="color: ${statusColor}">${escapeHtml(data.status || "processing")}</span>
        &nbsp;&middot;&nbsp;
        <strong>Run ID:</strong> <code style="font-size: 11px;">${escapeHtml(data.runId)}</code>
      </div>
    `;
  }

  // Entity gallery
  let galleryHtml = "";
  if (data.detectedEntities && data.detectedEntities.length > 0) {
    const thumbs = data.detectedEntities
      .map(
        (e) => `<img src="data:image/${escapeHtml(e.extension)};base64,${e.file}" alt="Detected entity" loading="lazy" />`
      )
      .join("");
    galleryHtml = `
      <div class="section-heading">Detected Entities (${data.detectedEntities.length})</div>
      <div class="entity-gallery">${thumbs}</div>
    `;
  }

  root.innerHTML = `
    <div class="container">
      ${statusHtml}
      ${metaHtml}
      ${fileViewerHtml}
      ${galleryHtml}
    </div>
  `;
}

// Set up MCP App
const app = new App({ name: "Skyflow Dehydrate File", version: "1.0.0" });

setupHostTheming(app);

app.ontoolinput = (params) => {
  const args = params.arguments as Record<string, unknown> | undefined;
  showLoading(
    args?.fileName as string | undefined,
    args?.mimeType as string | undefined
  );
};

app.ontoolresult = (result: CallToolResult) => {
  const data = (result as { structuredContent?: DehydrateFileResult }).structuredContent;
  if (data) {
    renderResult(data);
  }
};

app.onteardown = async () => ({});

app.connect(new PostMessageTransport()).then(() => {
  applyInitialContext(app);
  showLoading();
});
