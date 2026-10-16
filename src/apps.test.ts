import { describe, expect, it } from "vitest";
import { APP_TYPE, BRIDGE, Bucket, EVENT_TYPE, checkHtml, extractHtml, slug, titleOf, toApp, toAppEvent, withBridge } from "./apps";
import { TEMPLATES, buildMessages, pickTemplate } from "./skills";
import { prefillRounds } from "./chat";

const state = (key: string, content: Record<string, unknown>) =>
    ({ type: APP_TYPE, state_key: key, sender: "@anna:x", origin_server_ts: 5, content, event_id: "$s", room_id: "!r", unsigned: {} }) as never;

describe("apps in room state", () => {
    it("reads apps and treats empty content as removed", () => {
        expect(toApp(state("poll", { name: "Poll", html: "<html></html>", version: 2 }))).toMatchObject({ id: "poll", name: "Poll", version: 2, author: "@anna:x" });
        expect(toApp(state("poll", {}))).toBeNull();
    });

    it("reads app events", () => {
        const ev = { type: EVENT_TYPE, event_id: "$e", sender: "@bob:x", origin_server_ts: 9, content: { app: "poll", data: { vote: "A" } }, room_id: "!r", unsigned: {} } as never;
        expect(toAppEvent(ev)).toEqual({ id: "$e", app: "poll", sender: "@bob:x", ts: 9, data: { vote: "A" } });
    });

    it("slugs names", () => {
        expect(slug("Mittagessen-Umfrage für Dienstag!")).toBe("mittagessen-umfrage-fur-dienstag");
        expect(slug("!!!")).toBe("app");
    });
});

describe("model output", () => {
    it("extracts the html block, the bare document, or nothing", () => {
        expect(extractHtml("Sure:\n```html\n<!doctype html><html><body>x</body></html>\n```\nDone.")).toBe("<!doctype html><html><body>x</body></html>");
        expect(extractHtml("```js\nlet a\n```\n```html\n<html><body>b</body></html>\n```")).toBe("<html><body>b</body></html>");
        // Cut off before the closing fence.
        expect(extractHtml("```html\n<html><body>c")).toBe("<html><body>c");
        expect(extractHtml("Here: <!doctype html><html><body>d</body></html> ok")).toBe("<!doctype html><html><body>d</body></html>");
        expect(extractHtml("I cannot do that.")).toBeNull();
        expect(titleOf("<title> Lunch </title>")).toBe("Lunch");
    });

    it("finds what the sandbox will refuse", () => {
        const p = checkHtml('<html><script src="https://cdn.x/y.js"></script><script>fetch("/a"); localStorage.x=1; alert(1)</script>');
        expect(p.join(" ")).toMatch(/internet/);
        expect(p.join(" ")).toMatch(/network/);
        expect(p.join(" ")).toMatch(/storage/);
        expect(p.join(" ")).toMatch(/alert/);
        expect(p.join(" ")).toMatch(/cut off/);
        for (const t of TEMPLATES) expect(checkHtml(t.html), t.id).toEqual([]);
    });

    it("puts the bridge before the app's code", () => {
        const out = withBridge("<!doctype html><html><head><title>x</title></head><body><script>miniapp.on(()=>{})</script></body></html>");
        expect(out.indexOf("window.miniapp")).toBeLessThan(out.indexOf("miniapp.on(()"));
        expect(withBridge("<div>bare</div>")).toContain("<body><div>bare</div>");
        expect(BRIDGE).toContain("__miniapp");
    });

    it("limits the send rate", () => {
        const b = new Bucket(2, 1, 0);
        expect([b.take(0), b.take(0), b.take(0)]).toEqual([true, true, false]);
        expect(b.take(1000)).toBe(true);
    });
});

describe("skills", () => {
    it("picks a template from the request", () => {
        expect(pickTemplate("Eine Umfrage zum Mittagessen").id).toBe("poll");
        expect(pickTemplate("shared shopping list").id).toBe("checklist");
        expect(pickTemplate("roll a dice for who pays").id).toBe("picker");
        expect(pickTemplate("points for our quiz game").id).toBe("scoreboard");
        expect(pickTemplate("a clock").id).toBe("blank");
    });

    it("builds a prompt with rules, API and template, request last", () => {
        const m = buildMessages({ kind: "create", request: "lunch poll", template: TEMPLATES[0] }, "@anna:x");
        expect(m[1].content).toMatch(/^<rules>/);
        expect(m[1].content).toContain('<template name="poll">');
        expect(m[1].content).toMatch(/\n\nRequest from anna: Build this app: lunch poll/);
        const fix = buildMessages({ kind: "fix", error: "x is not defined", current: "<html></html>" }, "@anna:x");
        expect(fix[1].content).toContain("<error>\nx is not defined\n</error>");
        // On GPUs that need it, the material is read in parts and the request comes whole at the end.
        const r = prefillRounds(m, 1500);
        expect(r.rounds.at(-1)).toContain("Build this app: lunch poll");
    });
});
