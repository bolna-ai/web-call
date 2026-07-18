import { defineConfig } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  timeout: 15_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    permissions: ["microphone"],
    launchOptions: {
      // synthetic mic input + auto-grant any getUserMedia prompt — no real hardware,
      // no human in the loop, deterministic in CI
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream=allow"],
    },
  },
  webServer: {
    command: `node e2e/server.mjs`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 10_000,
    stdout: "pipe",
  },
});
