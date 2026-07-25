# Changelog

## [Unreleased]

### Added

- **File de-identification and re-identification tools** — Three new MCP tools expose Skyflow's file endpoints:
  - **`de-identify-file`** — Detects and redacts sensitive data in images, PDFs, Office documents, txt/csv/json/xml, dcm, and audio. Accepts the file as a **signed/public URL** (`fileUrl`, downloaded server-side with a 25 MB cap and converted to the base64 the Skyflow API requires) or as inline base64 (`fileDataBase64` + `fileName`). Supports the common Skyflow file options: `entities`, `allowRegexList`/`restrictRegexList`, `tokenType`, `maskingMethod`, `outputProcessedFile`, `outputOcrText`, `outputTranscription`, `pixelDensity`/`maxResolution`, `dateShift`, and audio `bleep` settings.
  - **`get-file-run-status`** — Polls the asynchronous de-identification run by `runId`, with optional bounded server-side long-polling (`waitSeconds`). File processing at Skyflow is async: `de-identify-file` waits up to `waitTimeSeconds` (default 25s, max 64s) and returns either the completed result or `runId` + `IN_PROGRESS` with instructions to poll — the standard MCP job-handle pattern for long-running work on a stateless server.
  - **`re-identify-file`** — Restores original values in previously de-identified csv/doc/docx/json/txt/xls/xlsx/xml files via Skyflow's synchronous reidentify-file endpoint, with `redactedEntities`/`maskedEntities`/`plainTextEntities` routing.
  - New `ui/re-identify-file/` MCP Apps UI; `get-file-run-status` shares the de-identify-file app. New shared helpers: `src/lib/files/fileSource.ts` (URL download with SSRF guard, size/timeout limits, filename inference) and `src/lib/detect/detectRest.ts` (direct REST client for the runs and reidentify-file endpoints, tolerant of both camelCase and snake_case response fields).
  - All three tools require authenticated mode; in anonymous mode they return setup instructions.

- **Re-identify output format control** — The `re-identify` tool now accepts an optional `format` object (`{ redacted?, masked?, plaintext? }`, each a list of entity type strings) that lets the caller specify, per entity type, how tokens are rendered on the way out — fully restored (plaintext), partially masked, or fully redacted. Omitting `format` preserves existing behavior exactly; entity types not listed in a provided `format` fall back to the Detect API's default and are restored as full plaintext. Maps to the `skyflow-node` SDK's `ReidentifyTextOptions` per the Detect API spec. The requested format is echoed back (normalized) in the response and summarized in the re-identify UI.

### Changed (file tools)

- **`skyflow-node` upgraded to ^2.1.2** — required for the fixed `IN_PROGRESS` timeout path in `deidentifyFile` (2.0.0 crashed with a destructuring TypeError when a run outlived the SDK wait window).
- **JSON body limit raised from 5 MB to 25 MB** to accommodate inline base64 file payloads.
- **`de-identify_file` handler reworked** — the previously disabled handler was redesigned (URL input, format validation, new options, polling note) and registered as `de-identify-file`.

### Added

- **MCP Apps UI for all three tools** — Each tool (`dehydrate`, `rehydrate`, `dehydrate_file`) now has an interactive vanilla TypeScript UI that renders inline in MCP Apps-capable hosts. Text-only hosts continue to receive JSON responses as before.
  - **Dehydrate UI**: Side-by-side before/after text panels with color-coded entity highlights, confidence scores, and an entity breakdown table. Shows anonymous mode banner when applicable.
  - **Rehydrate UI**: Token-to-original mapping display with color-matched highlights across before/after panels.
  - **Dehydrate File UI**: File viewer (image/audio/document), detected entity gallery thumbnails, metadata stat cards, and async operation status badges.
  - Shared theme system (`ui/shared/`) with host style integration via CSS variables and a color palette for 30+ entity types.

- **Entity metadata in dehydrate output** — The `dehydrate` tool now exposes the full `entities` array from the Skyflow API response, including `token`, `value`, `entity`, `textIndex`, `processedIndex`, and `scores` for each detected entity. Previously this data was discarded.

- **`inputText` / `inputFileName` passthrough** — All tools now echo back input identifiers (`inputText` for text tools, `inputFileName` and `inputMimeType` for file tool) in their output, making it easier for UIs and downstream consumers to correlate requests with responses.

- **Unit tests for tool handlers** (28 new tests) — Covers `dehydrate`, `rehydrate`, and `dehydrate_file` handler logic including authenticated mode, anonymous mode, entity metadata, error handling, and optional field behavior.

### Changed

- **Extracted tool handler logic from `src/server.ts`** — Inline handler bodies moved to dedicated pure functions in `src/lib/tools/{dehydrate,rehydrate,dehydrateFile}.ts` with explicit parameters instead of relying on `AsyncLocalStorage` context. This improves testability and separation of concerns. `src/server.ts` now only handles MCP response wrapping (`content` + `structuredContent`).

- **Tool registration uses `registerAppTool`** — Tools are now registered via `@modelcontextprotocol/ext-apps/server` instead of `server.tool()`, linking each tool to its UI resource via `_meta.ui.resourceUri`.

- **TypeScript module resolution** — Changed from `"moduleResolution": "node"` to `"moduleResolution": "Node16"` to support `@modelcontextprotocol/ext-apps` subpath exports.

- **Shared output types** — Added `src/lib/tools/types.ts` with typed interfaces (`DehydrateOutput`, `RehydrateOutput`, `DehydrateFileOutput`, `AnonymousModeError`, `ToolResult<T>`, etc.) used by both handler functions and tests.

### Dependencies

- Added `@modelcontextprotocol/ext-apps` (MCP Apps SDK)
- Added `vite` and `vite-plugin-singlefile` (dev dependencies for UI build)
- Upgraded `@modelcontextprotocol/sdk` from v1.19.1 to v1.27.1 (required by ext-apps peer dependency)

### Build

- Added `pnpm build:ui` — Builds each tool's UI into a single self-contained HTML file via Vite + vite-plugin-singlefile (`dist/ui/`)
- Added `pnpm build:server` — TypeScript compilation only
- `pnpm build` now runs `build:ui` then `build:server` in sequence
