import { describe, expect, it } from "vitest";
import { judgeProbe, type ProbeStep } from "./probe";

const step = (s: Partial<ProbeStep>): ProbeStep => ({ label: "click 'x'", kind: "click", sent: 0, errors: [], changed: false, ...s });

describe("judgeProbe", () => {
    it("passes an app whose actions are shared and shown", () => {
        expect(
            judgeProbe({
                startErrors: [],
                timedOut: false,
                steps: [step({ label: "type into 'New item'", kind: "type", token: "Kiwi41", sent: 1, shows: true, changed: true }), step({ sent: 1, changed: true })],
            }),
        ).toEqual([]);
    });

    it("passes an app with nothing to use, such as a countdown", () => {
        expect(judgeProbe({ startErrors: [], timedOut: false, steps: [] })).toEqual([]);
    });

    it("names what a person would see go wrong", () => {
        const problems = judgeProbe({
            startErrors: ["TypeError: x is null (line 3)"],
            timedOut: false,
            steps: [
                step({ label: "type into 'Message'", kind: "type", token: "Kiwi41", sent: 0 }),
                step({ label: "type into 'Name'", kind: "type", token: "Kiwi42", sent: 1, shows: false }),
                step({ label: "click 'Spin'", errors: ["TypeError: Assignment to constant variable."] }),
            ],
        });
        expect(problems).toEqual([
            "The app fails when it starts: TypeError: x is null (line 3)",
            "Typing into the field and pressing Enter or its button (type into 'Message') shares nothing: miniapp.send is never called.",
            'After typing "Kiwi42" (type into \'Name\') and sending it, "Kiwi42" never appears on the page. Render it from the state you update inside miniapp.on.',
            "When a person tries to click 'Spin', the app fails: TypeError: Assignment to constant variable.",
        ]);
    });

    it("notices an app that shares nothing at all", () => {
        const problems = judgeProbe({ startErrors: [], timedOut: false, steps: [step({ changed: true }), step({ label: "click 'y'" })] });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/Nothing in the app calls miniapp.send/);
    });
});
