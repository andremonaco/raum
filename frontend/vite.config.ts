import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const HOST = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: HOST || false,
    hmr: HOST ? { protocol: "ws", host: HOST, port: 5174 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  /* overlayscrollbars-solid's `solid` export condition points at raw JSX
     source (packages/overlayscrollbars-solid/source/*.js). vite-plugin-solid
     injects the `solid` condition for HMR on solid libraries, but this
     package is already pre-compiled — resolve directly to the `.mjs`
     artifact so the JSX-in-JS source never reaches esbuild's dep bundler. */
  resolve: {
    alias: {
      "~": new URL("./src", import.meta.url).pathname,
      "overlayscrollbars-solid": new URL(
        "./node_modules/overlayscrollbars-solid/overlayscrollbars-solid.mjs",
        import.meta.url,
      ).pathname,
    },
  },
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // xterm (core feature, eager) and file-editor-modal (lazy, CodeMirror) are
    // both intentionally large — raise the limit to suppress the noise.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "xterm",
              test: /@xterm\//,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
