import { defineConfig } from "tsup";

export default defineConfig([
  // npm build: ESM + type declarations (sip.js bundled — self-contained)
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    noExternal: ["sip.js"],
  },
  // CDN build: one minified <script> file exposing window.BolnaWebCall
  {
    entry: { "bolna-web-call.min": "src/global.ts" },
    format: ["iife"],
    minify: true,
    sourcemap: true,
    noExternal: ["sip.js"],
    outExtension: () => ({ js: ".js" }),
  },
]);
