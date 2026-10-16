import { defineConfig } from "@playwright/test";

// PORT picks another port when 4184 is taken (another checkout's test server is reused otherwise).
const port = Number(process.env.PORT ?? 4184);

export default defineConfig({
    testDir: "./test/e2e",
    testMatch: "**/*.spec.ts",
    timeout: 30_000,
    use: { baseURL: `http://localhost:${port}` },
    webServer: {
        command: "node test/e2e/server.mjs",
        url: `http://localhost:${port}/index.html`,
        reuseExistingServer: true,
        timeout: 20_000,
    },
});
