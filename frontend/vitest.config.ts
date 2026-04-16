import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    css: true,
    coverage: { provider: "v8" },
  },
  resolve: {
    conditions: ["development", "browser"],
    alias: {
      "~": new URL("./src", import.meta.url).pathname,
    },
  },
});
