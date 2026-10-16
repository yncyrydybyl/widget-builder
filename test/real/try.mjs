// Builds a two-player board game with a real model, then plays it as two people.
// Usage: node test/real/try.mjs [modelId]   (after pnpm build; REQUESTS="a|b" or REQUESTS_FILE for changes)
// Each request is sent in turn; the last version is played: alice and bob each get
// the app as a room widget, and every action one sends reaches the other, as in a
// room. Alice should win on the top row; one out-of-turn click must be ignored.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const model = process.argv[2] ?? "Qwen2.5-Coder-1.5B-Instruct";
// REQUESTS_FILE: one request per block, blocks separated by a line "---" (requests may contain "|").
const requests = process.env.REQUESTS_FILE
    ? readFileSync(process.env.REQUESTS_FILE, "utf8").split(/\n---\n/).map((r) => r.trim()).filter(Boolean)
    : (process.env.REQUESTS ?? "Tic-tac-toe for two players in the room").split("|");
const out = "test/real/try";
mkdirSync(out, { recursive: true });
const server = spawn("node", ["test/e2e/server.mjs"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const context = await chromium.launchPersistentContext("test/real/.profile", {
    channel: "chromium",
    headless: !process.env.HEADED,
    baseURL: "http://localhost:4184",
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist", "--use-angle=vulkan"],
});

async function build() {
    const page = await context.newPage();
    await page.addInitScript((model) => {
        localStorage.setItem("widget-builder.settings", JSON.stringify({ modelId: model }));
        window.__TEST_FIXTURE__ = { params: { matrix_user_id: "@alice:example.org" } };
    }, model);
    await page.goto("/__test__/index.html");
    const w = page.frameLocator("iframe");
    const t0 = Date.now();
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByText(/^Ready:/).waitFor({ timeout: 900_000 });
    console.log(`${model} loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    for (const req of requests) {
        const t1 = Date.now();
        await w.getByRole("textbox", { name: /App description|Change/ }).fill(req);
        await w.getByRole("button", { name: /Build app|Change app/ }).click();
        await w.locator('main[data-busy="true"]').waitFor({ timeout: 10_000 });
        for (let idle = 0; idle < 5; ) {
            await page.waitForTimeout(1000);
            idle = (await w.locator('main[data-busy="false"]').count()) ? idle + 1 : 0;
        }
        const chat = await w.locator(".chat li").allInnerTexts();
        console.log(`\n### ${req.slice(0, 100)}${req.length > 100 ? "…" : ""}  (${((Date.now() - t1) / 1000).toFixed(0)} s)`);
        for (const line of chat) console.log("   |", line.replace(/\s+/g, " ").slice(0, 200));
    }
    await w.getByText(/^Code \(/).click();
    const html = await w.getByRole("textbox", { name: "Code" }).inputValue();
    await page.close();
    return html;
}

/** One player: the app as a room widget, in the mock client. */
async function player(user, html) {
    const page = await context.newPage();
    const state = { type: "de.datanauten.widget_builder.app", state_key: "game", sender: "@alice:example.org", origin_server_ts: 1, event_id: "$app", room_id: "!r", content: { name: "Game", html, version: 1 }, unsigned: {} };
    await page.addInitScript((f) => (window.__TEST_FIXTURE__ = f), { params: { matrix_user_id: user, app: "game" }, state: [state] });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
    await page.goto("/__test__/index.html");
    const app = page.frameLocator("iframe").frameLocator("iframe.app-frame");
    await app.locator("body").waitFor();
    await page.waitForTimeout(800);
    return { user, page, app, errors, seen: 0 };
}

/** Delivers each player's new actions to the other, as the room would. */
async function relay(a, b) {
    await a.page.waitForTimeout(500); // a click's action reaches the host a moment later
    for (const [from, to] of [[a, b], [b, a]]) {
        const sent = await from.page.evaluate(() => window.__SENT__.filter((e) => e.type === "de.datanauten.widget_builder.event"));
        for (const e of sent.slice(from.seen)) {
            const id = `$${from.user.slice(1, 2)}${++from.seen}`;
            await to.page.evaluate((ev) => window.__toWidget("send_event", ev), {
                type: e.type, event_id: id, sender: from.user, origin_server_ts: Date.now(), room_id: "!r", content: e.content, unsigned: {},
            });
        }
    }
    await a.page.waitForTimeout(400);
}

/** The board: the largest group of 9 or more alike siblings (buttons, cells). */
const cells = (p) =>
    p.app.locator("body").evaluate(() => {
        let best = [];
        for (const el of document.querySelectorAll("body *")) {
            const kids = [...el.children].filter((c) => c.tagName === el.children[0]?.tagName);
            if (kids.length >= 9 && kids.length > best.length) best = kids;
        }
        const tds = [...document.querySelectorAll("td")];
        if (tds.length === 9 && best.length < 9) best = tds;
        best.forEach((c, i) => c.setAttribute("data-try", i));
        return best.map((c) => c.textContent.trim() || "·").join("");
    });
const click = (p, i) => p.app.locator(`[data-try="${i}"]`).click({ timeout: 3000 }).catch((e) => console.log(`   ${p.user} cannot click ${i}: ${e.message.split("\n")[0]}`));
const text = (p) => p.app.locator("body").innerText().then((t) => t.replace(/\s+/g, " ").slice(0, 160));

const html = await build();
writeFileSync(`${out}/${model}.html`, html);
console.log(`\n${html.split("\n").length} lines, saved to ${out}/${model}.html`);

const a = await player("@alice:example.org", html);
const b = await player("@bob:example.org", html);
// Some apps want a start or join first.
for (const p of [a, b]) {
    const start = p.app.getByRole("button", { name: /new game|start|join|play|accept/i }).first();
    if (await start.count()) {
        await start.click().catch(() => undefined);
        await relay(a, b);
    }
}
const moves = [[a, 0], [b, 3], [a, 1], [a, 6], [b, 4], [a, 2]]; // a's second click in a row is out of turn
let board = "";
for (const [p, i] of moves) {
    await cells(a);
    await cells(b);
    await click(p, i);
    await relay(a, b);
    board = `${await cells(a)} | ${await cells(b)}`;
    console.log(`   ${p.user.slice(1, 6)} → ${i}:  alice sees ${(await cells(a)).padEnd(9)}  bob sees ${await cells(b)}`);
}
const [ta, tb] = [await text(a), await text(b)];
console.log(`\nalice: ${ta}\nbob:   ${tb}`);
const shared = (await cells(a)) === (await cells(b));
const xs = new Set((await cells(a)).replace(/·/g, "")).size; // kinds of marks on the board
const verdict = {
    // Both see the same board, with alice's three marks and bob's two on it.
    shared: shared && xs >= 2 && (await cells(a)).replace(/·/g, "").length >= 4,
    outOfTurnIgnored: (await cells(a))[6] === "·",
    aliceWon: /alice|X/.test(ta) && /win|won|gewinnt|gewonnen/i.test(ta) && /win|won|gewinnt|gewonnen/i.test(tb),
    errors: [...a.errors, ...b.errors].slice(0, 3),
};
console.log("\nverdict:", JSON.stringify(verdict));
await a.page.screenshot({ path: `${out}/${model}-alice.png`, timeout: 5000 }).catch(() => undefined);
await b.page.screenshot({ path: `${out}/${model}-bob.png`, timeout: 5000 }).catch(() => undefined);
await context.close();
server.kill();
void board;
