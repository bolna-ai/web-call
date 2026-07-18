import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/support/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
