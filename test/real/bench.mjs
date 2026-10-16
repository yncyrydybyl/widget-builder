// Which model is best on this machine, right now? Loads each model on your GPU,
// builds the same apps with it, checks that each app actually works (clicks and
// types in it), and ranks the models. Answers depend on the GPU, its driver,
// free memory and whatever else is using the GPU, so run it where you will use
// the widget.
//
//   pnpm build && node test/real/bench.mjs                # all models
//   MODELS="Qwen2.5-Coder-1.5B-Instruct,Qwen3.5-4B" node test/real/bench.mjs
//   HEADED=1 ...                                          # watch it
//
// Models are cached in test/real/.profile, so each downloads once. Results go to
// test/real/bench-results.json and a table on stdout; each app's code and a
// screenshot go to test/real/bench/.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const ALL = ["Qwen2.5-Coder-1.5B-Instruct", "Qwen2.5-Coder-3B-Instruct", "Qwen3.5-4B", "Qwen2.5-Coder-7B-Instruct"];
const models = process.env.MODELS ? process.env.MODELS.split(",") : ALL;
const TASK_TIMEOUT = Number(process.env.TASK_TIMEOUT ?? 420) * 1000;
const LOAD_TIMEOUT = 20 * 60_000;
const TOKEN = "bench-kiwi-42";

/** Each task: a request, and a check that drives the finished app like a person would. */
const TASKS = [
    {
        id: "poll",
        request: "A poll: which day works for the team event? Monday to Friday",
        async check(app) {
            const body = await text(app);
            if (!/monday/i.test(body) || !/friday/i.test(body)) return "Monday to Friday are not all there";
            await app.getByRole("button", { name: /monday/i }).first().click({ timeout: 3000 });
            await app.locator("body").getByText(/\b1\b/).first().waitFor({ timeout: 4000 });
        },
    },
    {
        id: "list",
        request: "A shared shopping list where everyone can add items",
        check: addsText,
    },
    {
        // No template fits: shows how the model does on its own.
        id: "guestbook",
        request: "A guestbook where everyone can leave a short message",
        check: addsText,
    },
    {
        id: "countdown",
        request: "A countdown to the release on 1 December 2026",
        async check(app) {
            const a = await text(app);
            if (!/\d/.test(a)) return "shows no numbers";
            await new Promise((r) => setTimeout(r, 2200));
            if ((await text(app)) === a) return "does not count down";
        },
    },
];

async function text(app) {
    return (await app.locator("body").innerText({ timeout: 3000 })).replace(/\s+/g, " ");
}

/** Types into the app's text field, submits, and expects the text on the page. */
async function addsText(app) {
    const input = app.locator('input[type="text"], input:not([type]), textarea').first();
    // Some apps show their text field only after a click ("Add message").
    if (!(await input.count())) await app.locator("button").first().click({ timeout: 3000 });
    await input.fill(TOKEN, { timeout: 3000 });
    await input.press("Enter");
    if (!(await shows(app))) {
        await input.fill(TOKEN).catch(() => {});
        await app.locator("button").first().click({ timeout: 3000 });
    }
    if (!(await shows(app))) return "what was typed does not show up";
}

async function shows(app) {
    try {
        await app.locator("body").getByText(TOKEN).first().waitFor({ timeout: 2500 });
        return true;
    } catch {
        return false;
    }
}

const server = spawn("node", ["test/e2e/server.mjs"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const context = await chromium.launchPersistentContext("test/real/.profile", {
    channel: "chromium",
    headless: !process.env.HEADED,
    baseURL: "http://localhost:4184",
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"],
});

mkdirSync("test/real/bench", { recursive: true });
const results = [];
let gpu = "unknown";
for (const model of models) {
    const result = { model, loaded: false, loadSeconds: null, tasks: [], resets: 0, error: null };
    results.push(result);
    const page = await context.newPage();
    await page.addInitScript((model) => {
        localStorage.setItem("widget-builder.settings", JSON.stringify({ modelId: model }));
        window.__TEST_FIXTURE__ = { params: { matrix_user_id: "@alice:example.org" } };
    }, model);
    await page.goto("/__test__/index.html");
    const w = page.frameLocator("iframe");
    if (gpu === "unknown") {
        gpu = await page.evaluate(async () => {
            const a = await navigator.gpu?.requestAdapter();
            const i = a?.info;
            return i ? [i.vendor, i.architecture, i.description || i.device].filter(Boolean).join(" ") : "no WebGPU";
        });
    }
    console.log(`\n## ${model}`);
    const t0 = Date.now();
    try {
        await w.getByRole("button", { name: "Load model" }).click();
        await w.getByText(/^Ready:/).or(w.locator(".note.warn")).first().waitFor({ timeout: LOAD_TIMEOUT });
        if (!(await w.getByText(/^Ready:/).count())) throw new Error(await w.locator(".note.warn").first().innerText());
        result.loaded = true;
        result.loadSeconds = Math.round((Date.now() - t0) / 1000);
        console.log(`loaded in ${result.loadSeconds} s`);
    } catch (e) {
        result.error = `load: ${String(e.message ?? e).split("\n")[0].slice(0, 160)}`;
        console.log(result.error);
        await page.close();
        continue;
    }

    for (const task of TASKS) {
        const r = { id: task.id, works: false, starts: false, fixes: 0, seconds: null, problem: null };
        result.tasks.push(r);
        const t1 = Date.now();
        try {
            if (await w.getByRole("button", { name: "new app" }).count()) await w.getByRole("button", { name: "new app" }).click();
            await w.getByRole("textbox", { name: "App description" }).fill(task.request);
            await w.getByRole("button", { name: "Build app" }).click();
            await w.locator('main[data-busy="true"]').waitFor({ timeout: 10_000 });
            // Idle for 5 s in a row: an automatic fix may start right after the first answer.
            for (let idle = 0; idle < 5; ) {
                if (Date.now() - t1 > TASK_TIMEOUT) throw new Error("timed out");
                await page.waitForTimeout(1000);
                idle = (await w.locator('main[data-busy="false"]').count()) ? idle + 1 : 0;
            }
            r.seconds = Math.round((Date.now() - t1) / 1000);
            const chat = (await w.locator(".chat li").allInnerTexts()).join("\n");
            result.resets += (chat.match(/The GPU reset/g) ?? []).length;
            r.fixes = (chat.match(/asking the model to fix|Asking the model to fix/g) ?? []).length;
            // No preview at all: the last chat line says why (GPU, cut off, no code).
            if (!(await w.locator("iframe.app-frame").count())) throw new Error(`no app: ${chat.trim().split("\n").pop()}`);
            const runtime = await w.getByText("The app reported an error").count();
            r.starts = !runtime;
            if (!r.starts) throw new Error("crashes on start");
            const problem = await task.check(w.frameLocator("iframe.app-frame").first());
            if (problem) throw new Error(problem);
            if (await w.getByText("The app reported an error").count()) throw new Error("crashes when used");
            r.works = true;
        } catch (e) {
            r.problem = String(e.message ?? e).split("\n")[0].slice(0, 160);
            r.seconds ??= Math.round((Date.now() - t1) / 1000);
            // The engine may be stuck after a timeout; stop it before the next task.
            await w.getByRole("button", { name: "Stop" }).click({ timeout: 1000 }).catch(() => {});
        }
        // Keep what was built, to look at why a check failed.
        const name = `test/real/bench/${model}-${task.id}`;
        await w.locator("details pre").first().textContent({ timeout: 1000 }).then((html) => writeFileSync(`${name}.html`, html ?? ""), () => {});
        await page.screenshot({ path: `${name}.png`, fullPage: true }).catch(() => {});
        console.log(`  ${task.id.padEnd(10)} ${r.works ? "works" : r.starts ? "starts, broken" : "fails"}  ${r.seconds} s${r.fixes ? `, ${r.fixes} fix` : ""}${r.problem ? `  (${r.problem})` : ""}`);
    }
    await w.getByRole("button", { name: "Unload" }).click().catch(() => {});
    await page.close();
}
await context.close();
server.kill();

// Rank: apps that work first, then apps that at least start, then speed.
const score = (r) => r.tasks.filter((t) => t.works).length * 10 + r.tasks.filter((t) => t.starts).length * 3 - r.resets;
const time = (r) => r.tasks.reduce((s, t) => s + (t.seconds ?? TASK_TIMEOUT / 1000), 0);
const ranked = [...results].sort((a, b) => score(b) - score(a) || time(a) - time(b));

console.log(`\nGPU: ${gpu}\n`);
console.log("| Rank | Model | Load | Works | Starts | Time for all | GPU resets |");
console.log("|---|---|---|---|---|---|---|");
ranked.forEach((r, i) => {
    const works = r.tasks.filter((t) => t.works).length;
    const starts = r.tasks.filter((t) => t.starts).length;
    console.log(
        r.loaded
            ? `| ${i + 1} | ${r.model} | ${r.loadSeconds} s | ${works}/${TASKS.length} | ${starts}/${TASKS.length} | ${time(r)} s | ${r.resets} |`
            : `| – | ${r.model} | ${r.error} | | | | |`,
    );
});
const best = ranked.find((r) => r.loaded && r.tasks.some((t) => t.works));
console.log(best ? `\nBest here now: ${best.model}` : "\nNo model built a working app on this machine.");
writeFileSync("test/real/bench-results.json", JSON.stringify({ date: new Date().toISOString(), gpu, best: best?.model ?? null, results }, null, 2));
