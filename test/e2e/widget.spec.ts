import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const ME = "@alice:example.org";
const APP = "de.minagawa.widget_builder.app";
const EVENT = "de.minagawa.widget_builder.event";
const WIDGETS = "im.vector.modular.widgets";
const poll = readFileSync(new URL("../../src/skills/templates/poll.html", import.meta.url), "utf8");

const appState = (id: string, html: string, name = "Lunch poll") => ({
    type: APP,
    state_key: id,
    sender: "@bob:example.org",
    origin_server_ts: 1,
    event_id: `$state-${id}`,
    room_id: "!room:example.org",
    content: { name, html, version: 1 },
    unsigned: {},
});
const action = (id: string, app: string, data: unknown, sender: string, ts: number) => ({
    type: EVENT,
    event_id: id,
    sender,
    origin_server_ts: ts,
    room_id: "!room:example.org",
    content: { app, data },
    unsigned: {},
});

async function open(page: Page, fixture: Record<string, unknown>) {
    await page.addInitScript((f) => {
        (window as unknown as { __TEST_FIXTURE__: unknown }).__TEST_FIXTURE__ = f;
    }, fixture);
    await page.goto("/__test__/index.html");
    return page.frameLocator("iframe");
}

type Sent = { type: string; state_key?: string; content: Record<string, unknown> };
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __SENT__: Sent[] }).__SENT__);
const push = (page: Page, ev: unknown) =>
    page.evaluate((e) => (window as unknown as { __toWidget: (a: string, d: unknown) => void }).__toWidget("send_event", e), ev);

test("requests exactly the capabilities it needs", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await expect(w.getByText("in room")).toBeVisible();
    const caps = await page.evaluate(() => (window as unknown as { __REQUESTED_CAPABILITIES__: string[] }).__REQUESTED_CAPABILITIES__);
    expect(caps.sort()).toEqual(
        [
            "io.element.requires_client",
            `org.matrix.msc2762.send.state_event:${APP}`,
            `org.matrix.msc2762.receive.state_event:${APP}`,
            `org.matrix.msc2762.send.event:${EVENT}`,
            `org.matrix.msc2762.receive.event:${EVENT}`,
            `org.matrix.msc2762.send.state_event:${WIDGETS}`,
            `org.matrix.msc2762.receive.state_event:${WIDGETS}`,
        ].sort(),
    );
});

test("builds an app from a template, previews it locally and publishes it", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "App description" }).fill("a poll about lunch");
    await w.getByRole("button", { name: "Build app" }).click();
    await expect(w.getByText("Starting from the poll template.")).toBeVisible();

    // The app runs in the sandbox and works there, without touching the room.
    const app = w.frameLocator("iframe.app-frame");
    await app.getByRole("button", { name: /Pizza/ }).click();
    await expect(app.getByText("1 voted: alice")).toBeVisible();
    expect((await sent(page)).filter((e) => e.type === EVENT)).toHaveLength(0);

    await w.getByRole("textbox", { name: "App name" }).fill("Lunch poll");
    await w.getByRole("button", { name: "Publish to room" }).click();
    await expect(w.getByText(/Published "Lunch poll"/)).toBeVisible();
    const state = (await sent(page)).find((e) => e.type === APP)!;
    expect(state.state_key).toBe("lunch-poll");
    expect(state.content).toMatchObject({ name: "Lunch poll", version: 1 });
    expect(String(state.content.html)).toContain("miniapp.send({ vote: option })");

    // It is added to the room as its own widget; the URL names the app, the code stays in the state event.
    await expect(w.getByText(/in the room's widgets now/)).toBeVisible();
    const widget = (await sent(page)).find((e) => e.type === WIDGETS)!;
    expect(widget.state_key).toBe("widget_builder_lunch-poll");
    expect(widget.content).toMatchObject({ type: "m.custom", name: "Lunch poll", creatorUserId: ME, data: { app: "lunch-poll" } });
    const url = String(widget.content.url);
    expect(url).toContain("#/?app=lunch-poll&matrix_user_id=$matrix_user_id");
    expect(url).not.toContain("widgetId");
    expect(url).not.toContain("<html");

    // Publishing a new version keeps the one widget.
    await w.getByRole("button", { name: "Publish update" }).click();
    await expect(w.getByText(/Published "Lunch poll" \(version 2\)/)).toBeVisible();
    expect((await sent(page)).filter((e) => e.type === WIDGETS)).toHaveLength(1);

    await w.getByRole("button", { name: "Apps (1)" }).click();
    await expect(w.getByText(/room widget/)).toBeVisible();
    await w.getByRole("button", { name: "remove widget" }).click();
    await expect(w.getByRole("button", { name: "add as widget" })).toBeVisible();
    expect((await sent(page)).filter((e) => e.type === WIDGETS).at(-1)).toEqual({ type: WIDGETS, state_key: "widget_builder_lunch-poll", content: {} });
});

test("runs a published app with the room's shared actions", async ({ page }) => {
    const w = await open(page, {
        params: { engine: "echo", matrix_user_id: ME },
        state: [appState("lunch", poll)],
        events: [action("$v1", "lunch", { vote: "Sushi" }, "@bob:example.org", 2)],
    });
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Open" }).click();
    const app = w.frameLocator("iframe.app-frame");
    await expect(app.getByText("1 voted: bob")).toBeVisible();

    // My vote goes to the room as an app event.
    await app.getByRole("button", { name: /Pizza/ }).click();
    await expect(app.getByText("2 voted: bob, alice")).toBeVisible();
    const actions = (await sent(page)).filter((e) => e.type === EVENT);
    expect(actions).toEqual([{ type: EVENT, content: { app: "lunch", data: { vote: "Pizza" } } }]);

    // Someone else's vote arrives live.
    await push(page, action("$v3", "lunch", { vote: "Pizza" }, "@carol:example.org", 5));
    await expect(app.getByText("3 voted: bob, alice, carol")).toBeVisible();
});

test("an app cannot reach the network or the widget", async ({ page }) => {
    const evil = `<!doctype html><html><head><title>x</title></head><body><p id="out">…</p><script>
      const out = [];
      try { parent.document.title; out.push("parent: yes"); } catch { out.push("parent: no"); }
      try { localStorage.length; out.push("storage: yes"); } catch { out.push("storage: no"); }
      fetch("http://localhost:4184/index.html").then(() => out.push("fetch: yes"), () => out.push("fetch: no"))
        .finally(() => { document.getElementById("out").textContent = out.join(", "); });
    </script></body></html>`;
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("evil", evil, "Evil")] });
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Open" }).click();
    await expect(w.frameLocator("iframe.app-frame").getByText("parent: no, storage: no, fetch: no")).toBeVisible();
});

test("a room widget loads its app's code from the app's state event, and nothing else", async ({ page }) => {
    const broken = "<!doctype html><html><head><title>b</title></head><body><script>undefinedThing()</script></body></html>";
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME, app: "lunch" }, state: [appState("lunch", poll), appState("broken", broken, "Broken")] });
    // Runner mode: just the app.
    await expect(w.frameLocator("iframe.app-frame").getByText("Where do we have lunch?")).toBeVisible();
    await expect(w.getByText("Widget Builder")).toHaveCount(0);
    const caps = await page.evaluate(() => (window as unknown as { __REQUESTED_CAPABILITIES__: string[] }).__REQUESTED_CAPABILITIES__);
    expect(caps.sort()).toEqual(
        [
            "io.element.requires_client",
            `org.matrix.msc2762.receive.state_event:${APP}#lunch`,
            `org.matrix.msc2762.send.event:${EVENT}`,
            `org.matrix.msc2762.receive.event:${EVENT}`,
        ].sort(),
    );

    // A new version published from the builder reaches the open widget.
    const v2 = poll.replace("Where do we have lunch?", "Where do we have dinner?");
    await page.evaluate((e) => (window as unknown as { __pushState: (s: unknown[]) => void }).__pushState(e), [{ ...appState("lunch", v2), event_id: "$v2" }]);
    await expect(w.frameLocator("iframe.app-frame").getByText("Where do we have dinner?")).toBeVisible();
});

test("reports an app's runtime error", async ({ page }) => {
    const broken = "<!doctype html><html><head><title>b</title></head><body><script>undefinedThing()</script></body></html>";

    const w2 = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("broken", broken, "Broken")] });
    await w2.getByRole("button", { name: "Apps (1)" }).click();
    await w2.getByRole("button", { name: "Open" }).click();
    await expect(w2.getByText(/Broken: .*undefinedThing/)).toBeVisible();
});

test("the drawing template shares strokes", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "App description" }).fill("a sketch app for postcards");
    await w.getByRole("button", { name: "Build app" }).click();
    await expect(w.getByText("Starting from the drawing template.")).toBeVisible();

    const canvas = w.frameLocator("iframe.app-frame").locator("canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 90, { steps: 12 });
    await page.mouse.up();
    // The stroke came back through miniapp.on and is on the canvas.
    const inked = await w.frameLocator("iframe.app-frame").locator("canvas").evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
    });
    expect(inked).toBeGreaterThan(200);
    await expect(w.getByText("Fix:")).toHaveCount(0);
});

test("apps that add items through a form work, and a form cannot navigate away", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "App description" }).fill("a shared shopping list");
    await w.getByRole("button", { name: "Build app" }).click();
    const app = w.frameLocator("iframe.app-frame");
    await app.getByRole("textbox", { name: "New item" }).fill("Milk");
    await app.getByRole("textbox", { name: "New item" }).press("Enter");
    await expect(app.getByText("Milk")).toBeVisible();
    await app.getByRole("textbox", { name: "New item" }).fill("Bread");
    await app.getByRole("button", { name: "Add" }).click();
    await expect(app.getByText("Bread")).toBeVisible();

    const leaky = `<!doctype html><html><head><title>x</title></head><body><p id="out">here</p>
      <form id="f" action="http://localhost:4184/index.html" method="get"><button>go</button></form>
      <script>document.getElementById("f").submit();</script></body></html>`;
    const w2 = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("leaky", leaky, "Leaky")] });
    await w2.getByRole("button", { name: "Apps (1)" }).click();
    await w2.getByRole("button", { name: "Open" }).click();
    await page.waitForTimeout(500);
    // Still the app's own document: the submit was blocked by form-action 'none'.
    await expect(w2.frameLocator("iframe.app-frame").getByText("here")).toBeVisible();
});

test("every template passes the click-through test", async ({ page }) => {
    test.setTimeout(90_000);
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await w.getByRole("button", { name: "Load model" }).click();
    const requests = [
        "a poll about lunch",
        "a shared shopping list",
        "a kanban board",
        "pick a random person for cake",
        "a scoreboard for our game",
        "a countdown to the release",
        "a sketch pad",
        "a guestbook",
    ];
    for (const request of requests) {
        if (await w.getByRole("button", { name: "new app" }).count()) await w.getByRole("button", { name: "new app" }).click();
        await w.getByRole("textbox", { name: "App description" }).fill(request);
        await w.getByRole("button", { name: "Build app" }).click();
        await expect(w.locator('main[data-busy="false"]'), request).toBeVisible({ timeout: 30_000 });
        await expect(w.getByText(/^Tried the app out/), request).toHaveText("Tried the app out: it works.");
    }
});

test("an app that does not share what is typed goes back to the model with that finding", async ({ page }) => {
    const local = `<!doctype html><html><head><title>Notes</title></head><body>
      <form id="f"><input id="t" type="text" aria-label="Note"><button>Add</button></form><ul id="l"></ul>
      <script>
        const notes = [];
        document.getElementById("f").onsubmit = (e) => {
          e.preventDefault();
          notes.push(document.getElementById("t").value);   // never shared with the room
          document.getElementById("t").value = "";
        };
      </script></body></html>`;
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("notes", local, "Notes")] });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Edit" }).click();
    await w.getByRole("textbox", { name: "Change" }).fill("call it Our notes");
    await w.getByRole("button", { name: "Change app" }).click();
    await expect(w.locator('main[data-busy="false"]')).toBeVisible({ timeout: 30_000 });
    // The echo model never fixes anything, so all attempts are used and the finding is shown.
    await expect(w.getByText(/shares nothing: miniapp.send is never called/).first()).toBeVisible();
    await expect(w.getByText("Asking the model to fix these problems…")).toHaveCount(2);
    await expect(w.getByText(/^Tried the app out: /)).toHaveCount(3);
});
