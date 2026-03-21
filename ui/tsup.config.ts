import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    charts: "src/charts.ts",
    editor: "src/editor.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  treeshake: true,
  splitting: true,
  external: ["react", "react-dom", "@getcatalystiq/agent-plane", "swr", "react-markdown", "recharts", "@uiw/react-codemirror", "@codemirror/lang-markdown", "@codemirror/lang-javascript", "@codemirror/lang-json", "@codemirror/theme-one-dark"],
  outDir: "dist",
  clean: true,
});
