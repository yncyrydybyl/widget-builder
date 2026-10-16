import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEMPLATES, applySettings, buildSettingsMessages, checkSettings, defaultSettings, parseSettings, settingsOf } from "./skills";
import { titleOf, withAccent } from "./apps";

const poll = TEMPLATES.find((t) => t.id === "poll")!;

describe("settings-only mode", () => {
    it("gives every template but the blank one settings that match its fields", () => {
        for (const t of TEMPLATES) {
            const s = defaultSettings(t);
            if (t.id === "blank") expect(s).toBeNull();
            else expect(Object.keys(s!).sort()).toEqual(Object.keys(t.fields!).sort());
        }
    });

    it("reads the model's settings and checks them against the template's", () => {
        const answer = '```json\n{"title": "Film night", "question": "Welcher Film?", "options": ["Matrix", "Alien", "Heat", "Alien"]}\n```';
        expect(parseSettings(answer, poll)).toEqual({ title: "Film night", question: "Welcher Film?", options: ["Matrix", "Alien", "Heat"] });
        // Missing keys keep their defaults; the wrong kind of value is unusable.
        expect(parseSettings('{"options": ["A", "B"]}', poll)).toMatchObject({ question: "Where do we have lunch?", options: ["A", "B"] });
        expect(parseSettings('{"options": "A, B"}', poll)).toBeNull();
        expect(parseSettings('{"options": ["A"]}', poll)).toBeNull();
        expect(parseSettings('{"custom": true}', poll)).toBeNull();
        expect(parseSettings("I would need to write code for that.", poll)).toBeNull();
        const countdown = TEMPLATES.find((t) => t.id === "countdown")!;
        expect(parseSettings('{"target": "next week"}', countdown)).toBeNull();
        expect(parseSettings('{"target": "2026-12-24T18:00"}', countdown)).toMatchObject({ target: "2026-12-24T18:00" });
        const sketch = TEMPLATES.find((t) => t.id === "sketch")!;
        expect(parseSettings('{"colors": ["red", "blue"]}', sketch)).toBeNull();
    });

    it("writes the settings into the template and recognises the result", () => {
        const html = applySettings(poll, { title: "Day </script> & poll", question: "Which day?", options: ["Monday", "Friday"] });
        expect(html).not.toContain("</script> &");
        expect(titleOf(html)).toBe("Day &lt;/script&gt; &amp; poll");
        expect(settingsOf(html)).toMatchObject({ template: { id: "poll" }, settings: { options: ["Monday", "Friday"] } });
        // Changed code: not a settings-only app any more.
        expect(settingsOf(html.replace("miniapp.ready(render)", "miniapp.ready(() => render())"))).toBeNull();
        expect(settingsOf(TEMPLATES.find((t) => t.id === "blank")!.html)).toBeNull();
        // An accent colour is a look, not code: still the template.
        expect(settingsOf(withAccent(html, "#d6336c"))).toMatchObject({ template: { id: "poll" } });
    });

    it("still knows apps built from the templates of 0.1 and 0.2, and upgrades them when their settings change", () => {
        for (const t of TEMPLATES.filter((t) => t.fields)) {
            const old = readFileSync(`test/fixtures/templates-0.1/${t.id}.html`, "utf8").replace("Lunch poll", "Team poll");
            const found = settingsOf(withAccent(old, "#2f6fde"));
            expect(found?.template.id, t.id).toBe(t.id);
            expect(Object.keys(found!.settings).sort()).toEqual(Object.keys(defaultSettings(t)!).sort());
            // Applying settings writes the current template.
            expect(settingsOf(applySettings(t, found!.settings))?.template.id).toBe(t.id);
        }
        // Changed code is not the template, old or new.
        const poll0 = readFileSync("test/fixtures/templates-0.1/poll.html", "utf8");
        expect(settingsOf(poll0.replace("render();", "render(); render();"))).toBeNull();
    });

    it("checks settings from the form and says what is wrong", () => {
        // One option per line: blank lines and repeats drop out, the rest is trimmed.
        expect(checkSettings({ title: " Lunch ", question: "Where?", options: ["Pizza", "", " Sushi ", "Pizza"] }, poll)).toEqual({
            title: "Lunch",
            question: "Where?",
            options: ["Pizza", "Sushi"],
        });
        expect(checkSettings({ title: "Lunch", question: "  ", options: ["A", "B"] }, poll)).toBe('"question" must not be empty.');
        expect(checkSettings({ title: "Lunch", question: "Where?", options: ["Pizza", ""] }, poll)).toBe('"options" needs 2 to 20 entries.');
        const picker = TEMPLATES.find((t) => t.id === "picker")!;
        expect(checkSettings({ choices: ["Anna"] }, picker)).toMatchObject({ choices: ["Anna"] });
        const sketch = TEMPLATES.find((t) => t.id === "sketch")!;
        expect(checkSettings({ colors: ["red", "#00f"] }, sketch)).toBe('"colors" must be colours written as #rrggbb.');
        expect(checkSettings({}, TEMPLATES.find((t) => t.id === "blank")!)).toBe("The blank template has no settings.");
    });

    it("tells the model what the app does and when to ask for code", () => {
        const [, user] = buildSettingsMessages(poll, defaultSettings(poll)!, "A lunch poll: pizza or sushi", "@anna:x", new Date("2026-10-16"));
        expect(user.content).toContain("Each person votes");
        expect(user.content).toContain("Today is 2026-10-16");
        expect(user.content).toContain("Request from anna: A lunch poll");
        expect(user.content).toContain('{"custom": true}');
    });
});
