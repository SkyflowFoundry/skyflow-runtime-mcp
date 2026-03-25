import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// vite-plugin-singlefile only processes one entry at a time, so each UI app
// is built sequentially via the build:ui script with a separate INPUT per run.
const INPUT = process.env.INPUT;
if (!INPUT) throw new Error("INPUT environment variable is required");

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: false,
    rollupOptions: {
      input: INPUT,
    },
  },
});
