// Manual check with a real model on your GPU: builds apps from requests and
// reports whether each runs. Usage: HEADED=1 node test/real/build.mjs [modelId]
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";

const model = process.argv[2] ?? "Qwen2.5-Coder-3B-Instruct";
const requests = (process.env.REQUESTS ?? "A poll: which day works for the team event? Monday to Friday|Add Saturday and Sunday as options||A countdown timer to the release on 1 December 2026 that everyone sees||Ein gemeinsames Glücksrad: Namen eingeben, drehen, alle sehen das Ergebnis").split("|");
const server = spawn("node", ["test/e2e/server.mjs"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({
    channel: "chromium",
    headless: !process.env.HEADED,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"],
});
const page = await (await browser.newContext({ baseURL: "http://localhost:4184" })).newPage();
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log("console:", m.text().slice(0, 200)));
await page.addInitScript(([model]) => {
    localStorage.setItem("widget-builder.settings", JSON.stringify({ modelId: model }));
    window.__TEST_FIXTURE__ = { params: { matrix_user_id: "@alice:example.org" } };
}, [model]);
await page.goto("/__test__/index.html");
const w = page.frameLocator("iframe");
const t0 = Date.now();
await w.getByRole("button", { name: "Load model" }).click();
await w.getByText(/^Ready:/).waitFor({ timeout: 900_000 });
console.log(`${model} loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

let n = 0;
for (const req of requests) {
    if (!req) {
        // Empty entry: start a new app.
        await w.getByRole("button", { name: "new app" }).click();
        continue;
    }
    const t1 = Date.now();
    await w.getByRole("textbox", { name: /App description|Change/ }).fill(req);
    await w.getByRole("button", { name: /Build app|Change app/ }).click();
    await w.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 900_000 });
    await page.waitForTimeout(1500);
    const chat = await w.locator(".chat li").allInnerTexts();
    const err = await w.getByText("The app reported an error").count();
    let body = "(no preview)";
    try {
        body = (await w.frameLocator("iframe.app-frame").first().locator("body").innerText({ timeout: 3000 })).replace(/\s+/g, " ").slice(0, 200);
    } catch {}
    console.log(`\n### ${req}  (${((Date.now() - t1) / 1000).toFixed(0)} s)`);
    console.log("chat:", chat.slice(-3).join(" / ").slice(0, 300));
    console.log("runtime error:", err ? await w.getByText("The app reported an error").innerText() : "none");
    console.log("app shows:", body);
    await page.screenshot({ path: `test/real/build-${++n}.png`, fullPage: true });
}
await browser.close();
server.kill();
