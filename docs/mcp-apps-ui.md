# MCP Apps UI — Developer Guide

This is an internal guide to the interactive UIs that ship with this MCP
server via the [MCP Apps SDK](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps).
It covers which tools have an inline app UI, how the apps are wired
together, and the shared components each app is built from.

## Tools with an Apps UI

| Tool | Status | UI directory | Resource URI | Result type |
|------|--------|--------------|--------------|-------------|
| `de-identify` | Registered | `ui/de-identify/` | `ui://de-identify/mcp-app.html` | `DeIdentifyResult` |
| `re-identify` | Registered | `ui/re-identify/` | `ui://re-identify/mcp-app.html` | `ReIdentifyResult` |
| `de-identify_file` | UI exists, tool disabled | `ui/de-identify-file/` | _not registered_ | `DeIdentifyFileResult` |

Registration lives in `src/server.ts` — each tool calls `registerAppResource`
(to expose the HTML at a `ui://` URI) and `registerAppTool` (passing the
URI through `_meta.ui.resourceUri`). Hosts that support MCP Apps render
the UI inline; text-only hosts fall back to the JSON in `content`.

## Per-app anatomy

Every app directory contains exactly two files:

- `mcp-app.html` — minimal shell with a single `<div id="root">` and a
  module import of `main.ts`.
- `main.ts` — wires the app to the host and renders into `#root`.

The HTML is built into a single self-contained file by Vite with
`vite-plugin-singlefile` (`ui/vite.config.ts`), one entry per run. The
built artifacts in `dist/ui/` are imported as strings from
`src/generated/ui-html.js` and served as the resource body.

## SDK building blocks

Each `main.ts` follows the same shape, pulling from
`@modelcontextprotocol/ext-apps`:

| Symbol | Purpose |
|--------|---------|
| `App` | Top-level app instance, holds lifecycle callbacks. Constructed with `{ name, version }`. |
| `PostMessageTransport` | Default transport — talks to the host frame over `postMessage`. Passed to `app.connect()`. |
| `applyDocumentTheme` | Applies the host's light/dark theme to the document. |
| `applyHostStyleVariables` | Forwards CSS variables (colors, spacing) supplied by the host. |
| `applyHostFonts` | Loads font-face declarations supplied by the host. |
| `McpUiHostContext` (type) | Shape of the context object emitted on host changes. |

Lifecycle hooks each app sets:

- `app.ontoolinput(params)` — fires the moment the tool is invoked, before
  the result lands. Both apps use this to render a loading state seeded
  with the input string.
- `app.ontoolresult(result)` — reads `structuredContent` and renders the
  final view.
- `app.onhostcontextchanged(ctx)` — re-applies theme/styles/fonts when
  the host changes context.
- `app.onteardown()` — returns `{}` (no cleanup needed today).
- `app.connect(new PostMessageTransport())` — opens the channel, then
  the app calls `applyInitialContext` and shows the loading state.

## Shared helpers (`ui/shared/`)

The shared directory is what keeps the apps consistent. There is no UI
framework — just plain TypeScript, the SDK, and a stylesheet.

### `ui/shared/theme.ts`

Two helpers that every app calls:

- `setupHostTheming(app)` — registers `onhostcontextchanged` to re-apply
  the host's theme, CSS variables, fonts, and safe-area insets.
- `applyInitialContext(app)` — pulls the current host context once at
  startup and applies the same set of values, so the first paint matches
  the host.

### `ui/shared/types.ts`

Shared response types used by both the server and the UIs:

- `EntityInfo` — single detected entity (`token`, `value`, `entity`,
  `textIndex`, `processedIndex`, `scores`).
- `DeIdentifyResult` — input/processed text, counts, `entities[]`,
  `anonymousMode`, `note`.
- `ReIdentifyResult` — input/processed text, plus the error fields
  (`error`, `message`, `anonymousModeRestricted`).
- `DeIdentifyFileResult` — kept around for the disabled file tool.

When you change the tool output schema in `src/server.ts`, update the
matching type here so the UI keeps compiling.

### `ui/shared/styles.css`

The visual vocabulary used across the apps. Treat these as the component
library — re-use them in any new app rather than inventing new classes.

| Class | Use |
|-------|-----|
| `.container` | Outer wrapper, sets padding and max width. |
| `.panel`, `.panel-header`, `.panel-body`, `.panels` | Boxed sections (e.g. "Input" / "Output" cards). |
| `.tab-bar`, `.tab`, `.tab-content`, `.tab.active`, `.tab-content.active` | Tabbed views (`de-identify` toggles between original and de-identified text). |
| `.stats-bar`, `.stat`, `.stat-value`, `.stat-label` | Summary KPIs above the entity table. |
| `.entity-table`, `.entity-table-wrap` | Tabular entity / token breakdown. |
| `.badge`, `.badge-dot` | Entity-type chips, color-keyed via `getEntityClass()` → `entity-<type>` modifier. |
| `.entity-highlight` + `entity-<type>` | Inline highlights inside the input/output text. |
| `.banner`, `.banner-warning` | Inline notices (used for anonymous-mode warnings and error states). |
| `.section-heading` | Section dividers between panels and tables. |
| `.score-bar`, `.score-bar-track`, `.score-bar-fill` | Confidence bar inside the entity table. |
| `.loading`, `.spinner` | Loading placeholder shown from `ontoolinput`. |

Entity color tokens follow the convention `entity-<lowercased_snake_case>`
(see `getEntityClass()` in both `main.ts` files). New entity types pick
up a default style unless an explicit variant is added.

## Adding a new app

1. Create `ui/<tool>/mcp-app.html` (copy an existing one) and
   `ui/<tool>/main.ts`.
2. In `main.ts`: instantiate `new App(...)`, call `setupHostTheming`,
   implement `ontoolinput`/`ontoolresult`/`onteardown`, connect with
   `PostMessageTransport`, then call `applyInitialContext` and show a
   loading state.
3. Add a matching result type to `ui/shared/types.ts`.
4. Re-use the classes in `ui/shared/styles.css`; only add new ones if no
   existing component fits.
5. Register the new HTML import in `src/generated/ui-html.js` (generated
   from the Vite build) and add `registerAppResource` +
   `registerAppTool` in `src/server.ts`, wiring `_meta.ui.resourceUri`
   to the new `ui://` URI.
6. Run `pnpm build:ui` to regenerate the single-file bundle, then
   `pnpm dev` to verify in the Inspector.

See the "Modifying Tools" checklist in `CLAUDE.md` for the full
end-to-end change list whenever you touch a tool's schema.
