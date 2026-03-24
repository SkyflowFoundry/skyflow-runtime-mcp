import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

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
