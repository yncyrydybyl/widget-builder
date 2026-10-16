import { describe, expect, it } from "vitest";
import { TEMPLATES, applySettings, buildSettingsMessages, defaultSettings, parseSettings, settingsOf } from "./skills";
import { titleOf } from "./apps";

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
    });

    it("tells the model what the app does and when to ask for code", () => {
        const [, user] = buildSettingsMessages(poll, defaultSettings(poll)!, "A lunch poll: pizza or sushi", "@anna:x", new Date("2026-10-16"));
        expect(user.content).toContain("Each person votes");
        expect(user.content).toContain("Today is 2026-10-16");
        expect(user.content).toContain("Request from anna: A lunch poll");
        expect(user.content).toContain('{"custom": true}');
    });
});
