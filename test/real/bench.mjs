// Which model is best on this machine, right now? Loads each model on your GPU,
// builds the same apps with it, checks that each app actually works (clicks and
// types in it), and ranks the models. Answers depend on the GPU, its driver,
// free memory and whatever else is using the GPU, so run it where you will use
// the widget.
//
//   pnpm build && node test/real/bench.mjs                # all models
//   MODELS="Qwen2.5-Coder-1.5B-Instruct,Qwen3.5-4B" node test/real/bench.mjs
//   HEADED=1 ...                                          # watch it
//   REPEAT=3 TASKS=poll,list LABEL=baseline ...           # repeat, pick tasks, name the results file
//   PARAMS="settings=0&probe=0" ...                       # widget parameters, to compare features
//   PORT=4190 ...                                         # serve the build on another port (default 4184)
//
// colibri (a `coli serve` on this machine) is the model "colibri"; it is not in the
// default list. Start colibri with this page's origin allowed, then:
//
//   coli serve --model ~/colibri-models/qwen3-coder-30b --cors-origin http://localhost:4184
//   MODELS=colibri COLIBRI_URL=http://127.0.0.1:8000 node test/real/bench.mjs
//
// COLIBRI_KEY passes its API key. A CPU model is slower than a GPU: the task timeout
// for colibri defaults to 30 minutes.
//
// Models are cached in test/real/.profile, so each downloads once. Results go to
// test/real/bench-results.json and a table on stdout; each app's code and a
// screenshot go to test/real/bench/.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const ALL = ["Qwen2.5-Coder-1.5B-Instruct", "Qwen2.5-Coder-3B-Instruct", "Qwen3.5-4B", "Qwen2.5-Coder-7B-Instruct"];
const models = process.env.MODELS ? process.env.MODELS.split(",") : ALL;
const PORT = Number(process.env.PORT ?? 4184);
const COLIBRI = { colibriUrl: process.env.COLIBRI_URL ?? "http://127.0.0.1:8000", colibriKey: process.env.COLIBRI_KEY ?? "" };
const taskTimeout = (model) => Number(process.env.TASK_TIMEOUT ?? (model === "colibri" ? 1800 : 420)) * 1000;
const LOAD_TIMEOUT = 20 * 60_000;
const TOKEN = "bench-kiwi-42";

/** Each task: a request, and a check that drives the finished app like a person would. */
const ALL_TASKS = [
    { id: "poll", request: "A poll: which day works for the team event? Monday to Friday", check: votes(["Monday", "Friday"]) },
    { id: "lunch", request: "A lunch poll: pizza, sushi or salad", check: votes(["Pizza", "Sushi", "Salad"]) },
    { id: "film", request: "Eine Umfrage: welcher Film am Freitag? Matrix, Alien oder Heat", check: votes(["Matrix", "Alien", "Heat"]) },
    { id: "list", request: "A shared shopping list where everyone can add items", check: addsText },
    { id: "packing", request: "A packing list for our camping trip", check: addsText },
    { id: "kanban", request: "A kanban board for our sprint", check: addsText },
    { id: "picker", request: "Pick a random person to bring cake next week", check: clickChanges },
    { id: "score", request: "A scoreboard for our table football tournament", check: clickChanges },
    { id: "countdown", request: "A countdown to the release on 1 December 2026", check: countsDown },
    { id: "sketch", request: "A shared sketch pad for postcards", check: draws },
    // No template fits these: how the model does on its own.
    { id: "guestbook", request: "A guestbook where everyone can leave a short message", check: addsText },
    { id: "ideas", request: "An idea board where everyone posts ideas and can upvote them", check: addsText },
];
const TASKS = process.env.TASKS ? ALL_TASKS.filter((t) => process.env.TASKS.split(",").includes(t.id)) : ALL_TASKS;
const REPEAT = Number(process.env.REPEAT ?? 1);
const PARAMS = Object.fromEntries(new URLSearchParams(process.env.PARAMS ?? ""));

/** The options are there, and voting for the first one counts a vote. */
function votes(options) {
    return async (app) => {
        const body = await text(app);
        const missing = options.filter((o) => !new RegExp(o, "i").test(body));
        if (missing.length) return `options missing: ${missing.join(", ")}`;
        const before = await text(app);
        await app.getByRole("button", { name: new RegExp(options[0], "i") }).first().click({ timeout: 3000 });
        await app.locator("body").getByText(/\b1\b/).first().waitFor({ timeout: 4000 }).catch(() => {});
        if ((await text(app)) === before) return "voting changes nothing";
        if (!/\b1\b/.test(await text(app))) return "the vote is not counted";
    };
}

/** Clicking the app's first button changes what it shows. */
async function clickChanges(app) {
    const button = app.locator("button").first();
    if (!(await button.count())) return "has no button";
    // Some apps want names or teams first.
    const input = app.locator('input[type="text"], input:not([type]), textarea').first();
    if (await input.count()) {
        for (const name of ["Anna", "Ben"]) {
            await input.fill(name, { timeout: 3000 });
            await input.press("Enter");
            await app.locator("body").getByText(name).first().waitFor({ timeout: 1500 }).catch(() => {});
        }
    }
    const before = await text(app);
    for (const b of (await app.locator("button").all()).slice(0, 4)) {
        await b.click({ timeout: 2000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
        if ((await text(app)) !== before) return;
    }
    return "clicking its buttons changes nothing";
}

async function countsDown(app) {
    const a = await text(app);
    if (!/\d/.test(a)) return "shows no numbers";
    await new Promise((r) => setTimeout(r, 2200));
    if ((await text(app)) === a) return "does not count down";
}

/** A stroke on the canvas leaves ink. */
async function draws(app) {
    const canvas = app.locator("canvas").first();
    if (!(await canvas.count())) return "has no canvas";
    const box = await canvas.boundingBox();
    if (!box) return "the canvas is not visible";
    const page = canvas.page();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 12 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 600));
    const ink = await canvas.evaluate((c) => {
        const ctx = c.getContext("2d");
        if (!ctx) return -1;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const bg = [d[0], d[1], d[2], d[3]];
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] !== bg[0] || d[i + 1] !== bg[1] || d[i + 2] !== bg[2] || d[i + 3] !== bg[3]) n++;
        return n;
    });
    if (ink < 0) return "the canvas has no 2d context";
    if (ink < 50) return "drawing leaves no ink";
}

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

const server = spawn("node", ["test/e2e/server.mjs"], { stdio: "ignore", env: { ...process.env, PORT: String(PORT) } });
await new Promise((r) => setTimeout(r, 800));
const context = await chromium.launchPersistentContext("test/real/.profile", {
    channel: "chromium",
    headless: !process.env.HEADED,
    baseURL: `http://localhost:${PORT}`,
    // Headless Chrome otherwise may pick SwiftShader, WebGPU on the CPU: minutes per answer.
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist", "--use-angle=vulkan"],
    ignoreDefaultArgs: ["--use-angle=swiftshader-webgl"],
});

mkdirSync("test/real/bench", { recursive: true });
const results = [];
let gpu = "unknown";
for (const model of models) {
    const result = { model, loaded: false, loadSeconds: null, tasks: [], resets: 0, error: null };
    results.push(result);
    const page = await context.newPage();
    await page.addInitScript(
        ([model, params, colibri]) => {
            localStorage.setItem("widget-builder.settings", JSON.stringify({ modelId: model, ...colibri }));
            window.__TEST_FIXTURE__ = { params: { ...params, matrix_user_id: "@alice:example.org" } };
        },
        [model, PARAMS, COLIBRI],
    );
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
        // colibri: which model the server runs ("Ready: <id>. Runs on colibri…").
        if (model === "colibri") result.served = (await w.getByText(/^Ready:/).innerText()).match(/^Ready: (.+?)\. Runs/)?.[1] ?? null;
        console.log(`loaded in ${result.loadSeconds} s${result.served ? `: ${result.served}` : ""}`);
    } catch (e) {
        result.error = `load: ${String(e.message ?? e).split("\n")[0].slice(0, 160)}`;
        console.log(result.error);
        await page.close();
        continue;
    }

    for (const task of TASKS.flatMap((t) => Array.from({ length: REPEAT }, (_, i) => ({ ...t, run: i + 1 })))) {
        const r = { id: task.id, run: task.run, works: false, starts: false, fixes: 0, settingsOnly: false, seconds: null, problem: null };
        result.tasks.push(r);
        const t1 = Date.now();
        try {
            if (await w.getByRole("button", { name: "new app" }).count()) await w.getByRole("button", { name: "new app" }).click();
            await w.getByRole("textbox", { name: "App description" }).fill(task.request);
            await w.getByRole("button", { name: "Build app" }).click();
            await w.locator('main[data-busy="true"]').waitFor({ timeout: 10_000 });
            // Idle for 5 s in a row: an automatic fix may start right after the first answer.
            for (let idle = 0; idle < 5; ) {
                if (Date.now() - t1 > taskTimeout(model)) throw new Error("timed out");
                await page.waitForTimeout(1000);
                idle = (await w.locator('main[data-busy="false"]').count()) ? idle + 1 : 0;
            }
            r.seconds = Math.round((Date.now() - t1) / 1000);
            const chat = (await w.locator(".chat li").allInnerTexts()).join("\n");
            result.resets += (chat.match(/The GPU reset/g) ?? []).length;
            r.fixes = (chat.match(/asking the model to fix|Asking the model to fix/g) ?? []).length;
            r.settingsOnly = /no code changed/.test(chat) && !/Writing the app|writing code instead/.test(chat);
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
        const name = `test/real/bench/${model}-${task.id}${REPEAT > 1 ? `-${task.run}` : ""}`;
        await w.locator("details pre").first().textContent({ timeout: 1000 }).then((html) => writeFileSync(`${name}.html`, html ?? ""), () => {});
        await page.screenshot({ path: `${name}.png`, fullPage: true }).catch(() => {});
        console.log(`  ${`${task.id}${REPEAT > 1 ? ` #${task.run}` : ""}`.padEnd(13)} ${r.works ? "works" : r.starts ? "starts, broken" : "fails"}  ${r.seconds} s${r.settingsOnly ? ", settings only" : ""}${r.fixes ? `, ${r.fixes} fix` : ""}${r.problem ? `  (${r.problem})` : ""}`);
    }
    await w.getByRole("button", { name: "Unload" }).click().catch(() => {});
    await page.close();
}
await context.close();
server.kill();

// Rank: apps that work first, then apps that at least start, then speed.
const score = (r) => r.tasks.filter((t) => t.works).length * 10 + r.tasks.filter((t) => t.starts).length * 3 - r.resets;
const time = (r) => r.tasks.reduce((s, t) => s + (t.seconds ?? taskTimeout(r.model) / 1000), 0);
const ranked = [...results].sort((a, b) => score(b) - score(a) || time(a) - time(b));

console.log(`\nGPU: ${gpu}\n`);
console.log("| Rank | Model | Load | Works | Starts | Time for all | GPU resets |");
console.log("|---|---|---|---|---|---|---|");
ranked.forEach((r, i) => {
    const works = r.tasks.filter((t) => t.works).length;
    const starts = r.tasks.filter((t) => t.starts).length;
    console.log(
        r.loaded
            ? `| ${i + 1} | ${r.served ? `colibri: ${r.served}` : r.model} | ${r.loadSeconds} s | ${works}/${r.tasks.length} (${Math.round((works / r.tasks.length) * 100)}%) | ${starts}/${r.tasks.length} | ${time(r)} s | ${r.resets} |`
            : `| – | ${r.model} | ${r.error} | | | | |`,
    );
});
// Per task, so a change can be seen where it helps.
console.log(`\n| Task | ${ranked.filter((r) => r.loaded).map((r) => r.model).join(" | ")} |`);
console.log(`|---|${ranked.filter((r) => r.loaded).map(() => "---").join("|")}|`);
for (const t of TASKS) {
    const cells = ranked.filter((r) => r.loaded).map((r) => {
        const runs = r.tasks.filter((x) => x.id === t.id);
        return `${runs.filter((x) => x.works).length}/${runs.length}`;
    });
    console.log(`| ${t.id} | ${cells.join(" | ")} |`);
}
const best = ranked.find((r) => r.loaded && r.tasks.some((t) => t.works));
console.log(best ? `\nBest here now: ${best.model}` : "\nNo model built a working app on this machine.");
writeFileSync(`test/real/bench-results${process.env.LABEL ? `-${process.env.LABEL}` : ""}.json`, JSON.stringify({ date: new Date().toISOString(), gpu, best: best?.model ?? null, results }, null, 2));
