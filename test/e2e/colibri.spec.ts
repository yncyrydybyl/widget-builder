// colibri as the engine, against a fake `coli serve` (fake-colibri.mjs) on
// 127.0.0.1: the built widget with its production CSP, from the mock host.
import { expect, test, type Page } from "@playwright/test";
import { MODEL_ID, startFakeColibri } from "./fake-colibri.mjs";

const ME = "@alice:example.org";

type Fake = Awaited<ReturnType<typeof startFakeColibri>>;
let fake: Fake;
test.afterEach(async () => fake?.close());

/** The builder with colibri chosen in the UI, pointed at `url`. */
async function openWithColibri(page: Page, url: string, key = "") {
    await page.addInitScript((f) => {
        (window as unknown as { __TEST_FIXTURE__: unknown }).__TEST_FIXTURE__ = f;
    }, { params: { matrix_user_id: ME } });
    await page.goto("/__test__/index.html");
    const w = page.frameLocator("iframe");
    await w.getByRole("combobox", { name: "Model" }).selectOption("colibri");
    await w.getByRole("textbox", { name: "colibri server" }).fill(`${url}/v1`);
    if (key) await w.getByLabel("API key, if it has one").fill(key);
    // No WebGPU in headless Chromium: colibri does not need it.
    await w.getByRole("button", { name: "Load model" }).click();
    return w;
}

test("builds apps with a colibri server: settings only, code, a change", async ({ page }) => {
    fake = await startFakeColibri({ key: "s3cret" });
    const w = await openWithColibri(page, fake.url, "s3cret");
    await expect(w.getByText(`Ready: ${MODEL_ID}. Runs on colibri at ${fake.url}, on this machine`)).toBeVisible();

    // Settings only.
    await w.getByRole("textbox", { name: "App description" }).fill("Team lunch poll");
    await w.getByRole("button", { name: "Build app" }).click();
    await expect(w.getByText(/Set up the poll template, no code changed/)).toBeVisible();
    await expect(w.getByRole("textbox", { name: "App name" })).toHaveValue("Team lunch poll");

    // A change that needs code: streamed, checked, tried out.
    await w.getByRole("textbox", { name: "Change" }).fill("add comments, which needs code");
    await w.getByRole("button", { name: "Change app" }).click();
    await expect(w.getByText(/^It is a .*add comments/)).toBeVisible();
    await expect(w.getByText("Tried the app out: it works.")).toHaveCount(2);
    await expect(w.locator('main[data-busy="false"]')).toBeVisible();
    await w.frameLocator("iframe.app-frame").getByRole("button", { name: /Pizza/ }).click();
    await expect(w.frameLocator("iframe.app-frame").getByText("1 voted: alice")).toBeVisible();

    const chats = fake.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(chats.length).toBe(3); // settings, settings again for the change, then code
    for (const r of chats) {
        expect(r.auth).toBe("Bearer s3cret");
        expect(r.body).toMatchObject({ model: MODEL_ID, stream: true });
    }
    // One message with the whole prompt: no "reply only with OK" rounds.
    expect(JSON.stringify(chats.map((r) => r.body.messages))).not.toContain("Do not answer yet");
    expect(chats[2].body.max_tokens).toBe(3000);

    // The address and key stay in this browser's preferences.
    const prefs = await page.frames()[1].evaluate(() => JSON.parse(localStorage.getItem("widget-builder.settings") ?? "{}"));
    expect(prefs).toMatchObject({ modelId: "colibri", colibriUrl: `${fake.url}/v1`, colibriKey: "s3cret" });
});

test("an answer with problems goes back to colibri in a fix round", async ({ page }) => {
    fake = await startFakeColibri();
    const w = await openWithColibri(page, fake.url);
    await expect(w.getByText(/^Ready:/)).toBeVisible();
    await w.getByRole("textbox", { name: "App description" }).fill("a broken app that needs code");
    await w.getByRole("button", { name: "Build app" }).click();
    await expect(w.getByText("It uses the network; apps have no network access.").first()).toBeVisible();
    await expect(w.getByText("Asking the model to fix these problems…")).toBeVisible();
    await expect(w.locator('main[data-busy="false"]')).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText("Tried the app out: it works.").last()).toBeVisible();
    const chats = fake.requests.filter((r) => r.path === "/v1/chat/completions").map((r) => JSON.stringify(r.body.messages));
    expect(chats.at(-1)).toContain("<current-app>");
    expect(chats.at(-1)).toContain("It uses the network");
});

test("Stop aborts the colibri request; its errors are reported, not treated as a GPU reset", async ({ page }) => {
    fake = await startFakeColibri();
    const w = await openWithColibri(page, fake.url);
    await expect(w.getByText(/^Ready:/)).toBeVisible();
    await w.getByRole("textbox", { name: "App description" }).fill("a slow app");
    await w.getByRole("button", { name: "Build app" }).click();
    await expect(w.locator('main[data-busy="true"]')).toBeVisible();
    await page.waitForTimeout(600);
    await w.getByRole("button", { name: "Stop" }).click();
    await expect(w.getByText("Stopped.")).toBeVisible();
    await expect(w.locator('main[data-busy="false"]')).toBeVisible();
    await expect.poll(() => fake.closed).toEqual([expect.stringContaining("a slow app")]);
    expect(fake.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(1);

    await w.getByRole("textbox", { name: "App description" }).fill("this will fail");
    await w.getByRole("button", { name: "Build app" }).click();
    await expect(w.getByText("colibri answered 500: device lost (from the fake server)").first()).toBeVisible();
    await expect(w.locator('main[data-busy="false"]')).toBeVisible();
    await expect(w.getByText(/GPU reset|reloading the model/)).toHaveCount(0);
    await expect(w.getByText(/^Ready:/)).toBeVisible();
});

test("an unreachable colibri or one without this origin shows the exact command", async ({ page }) => {
    // Running, but not started with --cors-origin for this page.
    fake = await startFakeColibri({ cors: false });
    const w = await openWithColibri(page, fake.url);
    const port = new URL(fake.url).port;
    const command = `coli serve --model <model folder> --cors-origin ${new URL(page.url()).origin} --port ${port}`;
    await expect(w.locator(".note.warn").filter({ hasText: `Could not reach colibri at ${fake.url}. Start it so that this page may call it: ${command}` })).toBeVisible();
    // The hint shows it before anything fails, too.
    await expect(w.locator("code").filter({ hasText: command })).toBeVisible();

    // Nothing listening at all; and an address the CSP blocks.
    await fake.close();
    await w.getByRole("button", { name: "Load model" }).click();
    await expect(w.locator(".note.warn").filter({ hasText: `Could not reach colibri at ${fake.url}` })).toBeVisible();
    await w.getByRole("textbox", { name: "colibri server" }).fill("http://192.0.2.1:8000");
    await w.getByRole("button", { name: "Load model" }).click();
    await expect(w.locator(".note.warn").filter({ hasText: "blocked by its security policy" })).toBeVisible();
});
