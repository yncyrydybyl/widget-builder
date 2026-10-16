import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const ME = "@alice:example.org";
const APP = "de.datanauten.widget_builder.app";
const EVENT = "de.datanauten.widget_builder.event";
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

test("lists the room's apps on a host that pushes only state changes, like the Player", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, noInitialState: true, events: [appState("lunch", poll)] });
    await expect(w.getByRole("button", { name: "Apps (1)" })).toBeVisible();
    // A pushed change wins over the read, and later reads cannot undo it.
    await page.evaluate((e) => (window as unknown as { __pushState: (s: unknown[]) => void }).__pushState(e), [{ ...appState("lunch", poll, "Dinner poll"), event_id: "$v2" }]);
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await expect(w.getByText("Dinner poll")).toBeVisible();

    // A room widget reads its one app the same way.
    const r = await open(page, { params: { engine: "echo", matrix_user_id: ME, app: "lunch" }, noInitialState: true, events: [appState("lunch", poll)] });
    await expect(r.frameLocator("iframe.app-frame").getByText("Where do we have lunch?")).toBeVisible();
});

test("a template-shaped request only fills in the settings; more than that goes to code", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "App description" }).fill("Team lunch poll");
    await w.getByRole("button", { name: "Build app" }).click();
    await expect(w.getByText(/Set up the poll template, no code changed/)).toBeVisible();
    await expect(w.getByText("Tried the app out: it works.")).toBeVisible();
    await expect(w.getByText("Writing the app…")).toHaveCount(0);
    const app = w.frameLocator("iframe.app-frame");
    await expect(app.getByRole("heading", { name: "Where do we have lunch?" })).toBeVisible();
    await expect(w.getByRole("textbox", { name: "App name" })).toHaveValue("Team lunch poll");

    // A change that the settings cover stays settings only; one that needs code gets code.
    await w.getByRole("textbox", { name: "Change" }).fill("Lunch on Friday");
    await w.getByRole("button", { name: "Change app" }).click();
    await expect(w.getByText(/no code changed/)).toHaveCount(2);
    await expect(w.getByRole("textbox", { name: "App name" })).toHaveValue("Lunch on Friday");
    await w.getByRole("textbox", { name: "Change" }).fill("add comments, which needs code");
    await w.getByRole("button", { name: "Change app" }).click();
    await expect(w.getByText(/needs more than the template's settings/)).toBeVisible();
    await expect(w.locator('main[data-busy="false"]')).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText(/no code changed/)).toHaveCount(2);
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
    const v2 = poll.replaceAll("Where do we have lunch?", "Where do we have dinner?");
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
        "tic-tac-toe for two players",
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

test("edits a published app's settings without a model, previewing with the room's actions", async ({ page }) => {
    const w = await open(page, {
        params: { engine: "echo", matrix_user_id: ME },
        state: [appState("lunch", poll)],
        events: [action("$v1", "lunch", { vote: "Sushi" }, "@bob:example.org", 2)],
    });
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Edit" }).click();
    await expect(w.getByText(/Editing "Lunch poll" \(version 1\)\. Change its settings or code below/)).toBeVisible();

    // The preview starts with the room's vote; no model is loaded.
    const app = w.frameLocator("iframe.app-frame");
    await expect(app.getByText("1 voted: bob")).toBeVisible();
    await expect(w.getByText("actions here stay local, starting with the room's 1 action")).toBeVisible();

    // Settings that do not fit the template are refused with the reason.
    await w.getByRole("textbox", { name: "options" }).fill("Pizza\n\n");
    await w.getByRole("button", { name: "Apply settings" }).click();
    await expect(w.getByText('"options" needs 2 to 12 entries.')).toBeVisible();

    await w.getByRole("textbox", { name: "options" }).fill("Pizza\nSushi\nPasta");
    await w.getByRole("button", { name: "Apply settings" }).click();
    await expect(w.getByText("Changed the settings by hand, no code changed.")).toBeVisible();
    await expect(app.getByRole("button", { name: /Pasta/ })).toBeVisible();
    await expect(app.getByText("1 voted: bob")).toBeVisible();

    // Trying it out stays local; reset goes back to the room's actions.
    await app.getByRole("button", { name: /Pasta/ }).click();
    await expect(app.getByText("2 voted: bob, alice")).toBeVisible();
    await w.getByRole("button", { name: "reset data" }).click();
    await expect(app.getByText("1 voted: bob")).toBeVisible();
    expect((await sent(page)).filter((e) => e.type === EVENT)).toHaveLength(0);

    await w.getByRole("button", { name: "Publish update" }).click();
    await expect(w.getByText(/Published "Lunch poll" \(version 2\)/)).toBeVisible();
    const states = (await sent(page)).filter((e) => e.type === APP);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ state_key: "lunch", content: { name: "Lunch poll", version: 2 } });
    expect(String(states[0].content.html)).toContain('"options":["Pizza","Sushi","Pasta"]');
});

test("edits an app's code by hand, with the same checks as the model's code", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("lunch", poll)] });
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Edit" }).click();
    await w.getByText(/^Code \(/).click();
    const code = w.getByRole("textbox", { name: "Code" });
    await expect(code).toHaveValue(poll);

    await code.fill(poll.replaceAll("Where do we have lunch?", "Where do we have dinner?"));
    await w.getByRole("button", { name: "Apply code" }).click();
    await expect(w.getByText("Changed the code by hand.", { exact: true })).toBeVisible();
    await expect(w.getByText("Tried the app out: it works.")).toBeVisible();
    await expect(w.frameLocator("iframe.app-frame").getByRole("heading", { name: "Where do we have dinner?" })).toBeVisible();

    await code.fill(poll.replace("</body>", '<script>fetch("https://example.org")</script></body>'));
    await w.getByRole("button", { name: "Apply code" }).click();
    await expect(w.getByText("Changed the code by hand. It has problems:")).toBeVisible();
    await expect(w.getByText(/It uses the network/).first()).toBeVisible();

    // Undo goes back a version, and the editor follows.
    await w.getByRole("button", { name: "undo" }).click();
    await expect(code).toHaveValue(/Where do we have dinner\?/);
    await expect(code).not.toHaveValue(/fetch\(/);
});

test("warns before replacing a version someone else published while editing", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("lunch", poll)] });
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Edit" }).click();
    await w.getByRole("textbox", { name: "question" }).fill("Lunch where?");
    await w.getByRole("button", { name: "Apply settings" }).click();

    const theirs = { ...appState("lunch", poll), sender: "@carol:example.org", event_id: "$v2", content: { name: "Lunch poll", html: poll, version: 2 } };
    await page.evaluate((e) => (window as unknown as { __pushState: (s: unknown[]) => void }).__pushState(e), [theirs]);
    await w.getByRole("button", { name: "Publish update" }).click();
    await expect(w.getByText(/carol published version 2 of this app while you were editing/)).toBeVisible();
    expect((await sent(page)).filter((e) => e.type === APP)).toHaveLength(0);

    await w.getByRole("button", { name: "Publish anyway" }).click();
    await expect(w.getByText(/Published "Lunch poll" \(version 3\)/)).toBeVisible();
    expect((await sent(page)).filter((e) => e.type === APP)).toHaveLength(1);
    await expect(w.getByText(/while you were editing/)).toHaveCount(0);
});

test("an app gets its own accent colour, which survives settings changes and publishing", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("lunch", poll)] });
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Edit" }).click();
    await w.getByRole("button", { name: "Colour #d6336c" }).click();
    const app = w.frameLocator("iframe.app-frame");
    // The bridge turns data-accent into --accent, with a readable text colour on it.
    await expect(app.locator(".meter span").first()).toHaveCSS("background-color", "rgb(214, 51, 108)");

    await w.getByRole("textbox", { name: "question" }).fill("Lunch where?");
    await w.getByRole("button", { name: "Apply settings" }).click();
    await expect(app.getByRole("heading", { name: "Lunch where?" })).toBeVisible();
    await expect(app.locator(".meter span").first()).toHaveCSS("background-color", "rgb(214, 51, 108)");

    await w.getByRole("button", { name: "Publish update" }).click();
    await expect(w.getByText(/Published "Lunch poll" \(version 2\)/)).toBeVisible();
    const html = String((await sent(page)).find((e) => e.type === APP)!.content.html);
    expect(html).toContain('<html data-accent="#d6336c">');
    // Back to the client's colour, from the swatch or by taking data-accent out of the code.
    await w.getByRole("button", { name: "The room client's colour" }).click();
    await expect(app.locator(".meter span").first()).toHaveCSS("background-color", "rgb(11, 122, 95)");
    await w.getByRole("button", { name: "Colour #d6336c" }).click();
    await w.getByText(/^Code \(/).click();
    const code = w.getByRole("textbox", { name: "Code" });
    await code.fill((await code.inputValue()).replace(' data-accent="#d6336c"', ""));
    await w.getByRole("button", { name: "Apply code" }).click();
    await expect(app.locator(".meter span").first()).toHaveCSS("background-color", "rgb(11, 122, 95)");
});

test("removing an app or editing over an unpublished draft asks first", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("lunch", poll)] });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "App description" }).fill("a shared shopping list");
    await w.getByRole("button", { name: "Build app" }).click();
    await expect(w.locator('main[data-busy="false"]')).toBeVisible({ timeout: 30_000 });

    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Edit" }).click();
    await expect(w.getByText(/Your draft in Build is not published/)).toBeVisible();
    await w.getByRole("button", { name: "cancel" }).click();
    // A link, not a red button (0.3.0 drew it as one).
    await expect(w.getByRole("button", { name: "remove" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await w.getByRole("button", { name: "remove" }).click();
    // An open "remove" question is not a yes to editing.
    await w.getByRole("button", { name: "Edit" }).click();
    await expect(w.getByText(/Your draft in Build is not published/)).toBeVisible();
    await w.getByRole("button", { name: "remove" }).click();
    await expect(w.getByText(/Remove "Lunch poll" for everyone/)).toBeVisible();
    expect((await sent(page)).filter((e) => e.type === APP)).toHaveLength(0);
    await w.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(w.getByText("No apps in this room yet.", { exact: false })).toBeVisible();
    expect((await sent(page)).filter((e) => e.type === APP)).toEqual([{ type: APP, state_key: "lunch", content: {} }]);
});

test("an app's frame grows with its page", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "App description" }).fill("a shared shopping list");
    await w.getByRole("button", { name: "Build app" }).click();
    const frame = w.locator("iframe.app-frame");
    const app = w.frameLocator("iframe.app-frame");
    await expect(app.getByText("Nothing on the list yet.")).toBeVisible();
    for (const item of ["Tent", "Stove", "Lamp", "Rope", "Map", "Water"]) {
        await app.getByRole("textbox", { name: "New item" }).fill(item);
        await app.getByRole("textbox", { name: "New item" }).press("Enter");
    }
    await expect(app.getByText("Water")).toBeVisible();
    // The frame is as tall as the app's page (plus its border), with no scrolling inside.
    const page_ = () => app.locator("html").evaluate((el) => el.scrollHeight);
    await expect.poll(async () => Math.round((await frame.boundingBox())!.height - (await page_()))).toBe(2);
    expect(await page_()).toBeGreaterThan(320);
});

test("a page sized from its frame (100vh) does not make the frame grow without end", async ({ page }) => {
    const tall = "<!doctype html><html><head><title>t</title><style>body { min-height: 100vh; margin: 24px 0; }</style></head><body><h1>Tall</h1></body></html>";
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("tall", tall, "Tall")] });
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Open" }).click();
    await expect(w.frameLocator("iframe.app-frame").getByRole("heading", { name: "Tall" })).toBeVisible();
    await page.waitForTimeout(1500);
    expect((await w.locator("iframe.app-frame").boundingBox())!.height).toBeLessThan(500);
});

test("a board of clickable <div>s that shares nothing is caught by the click-through test", async ({ page }) => {
    // From a real session: the squares are <div>s with click handlers, and moves never reach the room.
    const local = `<!doctype html><html><head><title>Tic Tac Toe</title><style>
      .board { display: grid; grid-template-columns: repeat(3, 60px); gap: 6px; } .cell { height: 60px; border: 1px solid; cursor: pointer; }
    </style></head><body><h1>Tic Tac Toe</h1><div id="log"></div><div class="board">
      ${Array.from({ length: 9 }, (_, i) => `<div class="cell" data-i="${i}"></div>`).join("")}
    </div><script>
      const board = ["", "", "", "", "", "", "", "", ""];
      let player = "X";
      document.querySelectorAll(".cell").forEach((cell) => cell.addEventListener("click", () => {
        if (board[cell.dataset.i]) return;
        board[cell.dataset.i] = cell.textContent = player;
        player = player === "X" ? "O" : "X";
      }));
      miniapp.on((ev) => {});
    </script></body></html>`;
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("ttt", local, "Tic Tac Toe")] });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("button", { name: "Apps (1)" }).click();
    await w.getByRole("button", { name: "Edit" }).click();
    await w.getByRole("textbox", { name: "Change" }).fill("make it nicer");
    await w.getByRole("button", { name: "Change app" }).click();
    await expect(w.locator('main[data-busy="false"]')).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText(/Nothing in the app calls miniapp.send/).first()).toBeVisible();
    await expect(w.getByText("Tried the app out: it works.")).toHaveCount(0);
});

test("the board game template is a real two-player game", async ({ page, context }) => {
    const game = readFileSync(new URL("../../src/skills/templates/game.html", import.meta.url), "utf8");
    const BOB = "@bob:example.org";
    const players = [
        { user: ME, page, seen: 0 },
        { user: BOB, page: await context.newPage(), seen: 0 },
        { user: "@carol:example.org", page: await context.newPage(), seen: 0 },
    ];
    for (const p of players) await open(p.page, { params: { engine: "echo", matrix_user_id: p.user, app: "game" }, state: [appState("game", game, "Game")] });
    const app = (i: number) => players[i].page.frameLocator("iframe").frameLocator("iframe.app-frame");
    // Every action a player sends reaches the others, as in a room.
    const relay = async () => {
        for (const from of players) {
            const out = (await sent(from.page)).filter((e) => e.type === EVENT);
            for (const e of out.slice(from.seen)) {
                const ev = action(`$${from.user.slice(1, 4)}-${++from.seen}`, "game", e.content.data, from.user, Date.now());
                for (const to of players) if (to !== from) await push(to.page, ev);
            }
        }
    };
    const actions = async (i: number) => (await sent(players[i].page)).filter((e) => e.type === EVENT).length;
    const play = async (i: number, square: number) => {
        const before = await actions(i);
        await app(i).getByRole("button", { name: new RegExp(`^Square ${square}$`) }).click();
        await expect.poll(() => actions(i)).toBe(before + 1);
        await relay();
    };
    await expect(app(0).getByText("Click a square to play ❌.")).toBeVisible();
    await play(0, 1);
    await expect(app(1).getByText("alice's turn.")).toHaveCount(0);
    await expect(app(1).getByText("Click a square to play ⭕.")).toBeVisible();
    // Not alice's turn: her squares are disabled.
    await expect(app(0).getByRole("button", { name: /^Square 2$/ })).toBeDisabled();
    await play(1, 4);
    await expect(app(2).getByText("alice's turn.")).toBeVisible();
    // Carol only watches.
    await expect(app(2).getByRole("button", { name: /^Square 2$/ })).toBeDisabled();
    // A move sent out of turn anyway is ignored on every screen.
    await push(page, action("$cheat", "game", { move: 8 }, BOB, Date.now()));
    await play(0, 2);
    await play(1, 5);
    await play(0, 3);
    for (const i of [0, 1, 2]) {
        await expect(app(i).getByText("🏆 alice wins!")).toBeVisible();
        await expect(app(i).locator("#board button.win")).toHaveCount(3);
        await expect(app(i).getByRole("button", { name: /^Square 9/ })).toHaveAccessibleName("Square 9");
    }
    await app(1).getByRole("button", { name: "New game" }).click();
    await expect.poll(() => actions(1)).toBe(3);
    await relay();
    for (const i of [0, 1, 2]) await expect(app(i).getByText("Click a square to play ❌.")).toBeVisible();
});
