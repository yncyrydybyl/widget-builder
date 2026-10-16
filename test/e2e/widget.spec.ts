import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const ME = "@alice:example.org";
const APP = "de.minagawa.widget_builder.app";
const EVENT = "de.minagawa.widget_builder.event";
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
    await expect(w.getByRole("button", { name: "Apps (1)" })).toBeVisible();
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

test("reports an app's runtime error, and shows one app on its own as a widget", async ({ page }) => {
    const broken = "<!doctype html><html><head><title>b</title></head><body><script>undefinedThing()</script></body></html>";
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME, app: "lunch" }, state: [appState("lunch", poll), appState("broken", broken, "Broken")] });
    // Runner mode: just the app.
    await expect(w.frameLocator("iframe.app-frame").getByText("Where do we have lunch?")).toBeVisible();
    await expect(w.getByText("Widget Builder")).toHaveCount(0);

    const w2 = await open(page, { params: { engine: "echo", matrix_user_id: ME }, state: [appState("broken", broken, "Broken")] });
    await w2.getByRole("button", { name: "Apps (1)" }).click();
    await w2.getByRole("button", { name: "Open" }).click();
    await expect(w2.getByText(/Broken: .*undefinedThing/)).toBeVisible();
});
