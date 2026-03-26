# Changelog

## [Unreleased]

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
