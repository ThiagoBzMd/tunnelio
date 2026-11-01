// Playwright against the REAL stack: Vite dev server (:5173, proxying to the Django server on
// :8080 started by scripts/e2e.sh) + headless trays started by the spec + local Ollama.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // One serial flow: sign-up by code, chats, a vision turn (model load), dictation, documents (a PDF
  // page image to the vision model), a second browser, two-step sign-in (each code waits for a fresh
  // 30 s step), password change, offline, re-pair, reset by code, delete all conversations.
  timeout: 600_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    // A click that can never land (element gone, pointer events blocked) fails here instead of
    // hanging until the test timeout.
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
