/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./frontend"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./frontend/__tests__/setup.ts"],
    include: ["frontend/__tests__/**/*.test.{ts,tsx}"],
  },
});
