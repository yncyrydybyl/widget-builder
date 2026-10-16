/*
 * What the model knows about building apps: the miniapp API, the rules, and a
 * working template close to the request. Small models write far better code
 * when they adapt a working example than when they start from nothing, so
 * every new app starts from a template.
 *
 * Pure: prompt building only.
 */
import { withAccent } from "./apps";
import type { ChatMessage } from "./chat";
import api from "./skills/api.md?raw";
import rules from "./skills/rules.md?raw";
import blank from "./skills/templates/blank.html?raw";
import checklist from "./skills/templates/checklist.html?raw";
import countdown from "./skills/templates/countdown.html?raw";
import game from "./skills/templates/game.html?raw";
import kanban from "./skills/templates/kanban.html?raw";
import picker from "./skills/templates/picker.html?raw";
import poll from "./skills/templates/poll.html?raw";
import scoreboard from "./skills/templates/scoreboard.html?raw";
import sketch from "./skills/templates/sketch.html?raw";

export interface Template {
    id: string;
    label: string;
    /** Words in a request that make this template the starting point. */
    keywords: string[];
    html: string;
    /**
     * What the app does, for settings-only mode: the model fills in the template's
     * SETTINGS line instead of writing code. One field description per setting.
     */
    does?: string;
    fields?: Record<string, string>;
}

export const TEMPLATES: Template[] = [
    {
        id: "poll",
        label: "Poll",
        keywords: ["poll", "vote", "voting", "survey", "umfrage", "abstimmung", "abstimmen", "choose", "option", "rating", "rate", "bewertung"],
        html: poll,
        does: "Each person votes for one of a fixed list of options and can change their vote. It shows the counts and who voted.",
        fields: { title: "a short name for the app", question: "the question people vote on", options: "the answers to choose from, 2 to 12" },
    },
    {
        id: "checklist",
        label: "Checklist",
        keywords: ["list", "todo", "to-do", "task", "checklist", "shopping", "packing", "liste", "aufgabe", "einkauf", "agenda", "items", "bring"],
        html: checklist,
        does: "Everyone adds items to one shared list, ticks them off and removes them. It shows who added each item.",
        fields: { title: "the heading", placeholder: "the hint in the text field, e.g. \"New item\"", button: "the label of the add button" },
    },
    {
        id: "game",
        label: "Board game for two",
        keywords: ["tic-tac-toe", "tictactoe", "tic", "tac", "toe", "noughts", "crosses", "gomoku", "five in a row", "board game", "two players", "2 players", "opponent", "tris", "drei gewinnt", "tic tac toe"],
        html: game,
        does: "Two people take turns putting their mark on an empty square of a square board; whoever first has enough marks in a row (across, down or diagonally) wins, a full board is a draw. The first person to move plays the first mark, the next other person the second; everyone else watches. A New game button starts over.",
        fields: {
            title: "the heading",
            marks: "the two players' marks, usually emoji, e.g. ❌ and ⭕",
            size: "the board's width and height, 3 to 9",
            line: "how many marks in a row win, 3 up to the size",
        },
    },
    {
        id: "kanban",
        label: "Kanban board",
        keywords: ["kanban", "board", "trello", "columns", "column", "backlog", "sprint", "workflow", "spalten"],
        html: kanban,
        does: "Everyone adds cards to the first column, moves cards between the columns with arrow buttons and removes them.",
        fields: { title: "the heading", placeholder: "the hint in the text field, e.g. \"New card\"", columns: "the column names, left to right, 2 to 6" },
    },
    {
        id: "picker",
        label: "Random picker",
        keywords: ["random", "pick", "picker", "dice", "draw", "lottery", "wheel", "spin", "zufall", "zufällig", "würfel", "würfeln", "auslosen", "losen", "glücksrad", "rad", "drehen", "roulette", "who's next", "shuffle"],
        html: picker,
        does: "A list of names or choices that anyone can edit; a button picks one at random and everyone sees the same result.",
        fields: { title: "the heading, e.g. the question that is decided", choices: "the names or choices to pick from", button: "the label of the button" },
    },
    {
        id: "scoreboard",
        label: "Scoreboard",
        keywords: ["score", "points", "scoreboard", "leaderboard", "game", "counter", "tally", "punkte", "punktestand", "spiel", "zähler", "tournament", "turnier"],
        html: scoreboard,
        does: "Anyone adds players or teams and gives or takes points with + and − buttons; sorted by points.",
        fields: { title: "the heading", placeholder: "the hint in the name field, e.g. \"Player or team\"" },
    },
    {
        id: "countdown",
        label: "Countdown",
        keywords: ["countdown", "timer", "deadline", "until", "release", "date", "clock", "frist"],
        html: countdown,
        does: "Counts down the days, hours, minutes and seconds to one date and time. Anyone can set a new date and name.",
        fields: { title: "what is counted down to", target: "the date and time, as YYYY-MM-DDTHH:MM" },
    },
    {
        id: "sketch",
        label: "Drawing",
        keywords: ["sketch", "draw", "drawing", "paint", "painting", "canvas", "whiteboard", "doodle", "postcard", "postcards", "pictionary", "zeichnen", "zeichnung", "malen", "skizze", "postkarte", "tafel"],
        html: sketch,
        does: "A shared drawing canvas that everyone draws on with a few colours, and a Clear button.",
        fields: { title: "the heading", colors: "the pen colours, as #rrggbb, 2 to 8" },
    },
    { id: "blank", label: "Blank", keywords: [], html: blank },
];

/** Lower-case words, so "countdown" does not count as "count". */
function words(text: string): Set<string> {
    return new Set(text.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? []);
}

/** The template whose keywords best match the request; the blank one otherwise. */
export function pickTemplate(request: string): Template {
    const text = request.toLowerCase();
    const have = words(text);
    let best = TEMPLATES[TEMPLATES.length - 1];
    let bestScore = 0;
    for (const t of TEMPLATES) {
        // Multi-word keywords match as phrases, single words as whole words.
        const score = t.keywords.filter((k) => (k.includes(" ") ? text.includes(k) : have.has(k))).length;
        if (score > bestScore) {
            best = t;
            bestScore = score;
        }
    }
    return best;
}

export const SYSTEM_PROMPT =
    "You are an expert web developer who builds small apps for a chat room. " +
    "Reply with ONE complete HTML file in a single ```html code block, then one short sentence saying what you built. " +
    "Follow the rules and use the miniapp API exactly as documented. Keep the app small.";

export type Task =
    | { kind: "create"; request: string; template: Template }
    | { kind: "change"; request: string; current: string }
    | { kind: "fix"; error: string; current: string };

/**
 * One user message: the reference material first, the request last (prefillRounds
 * splits the material into rounds on GPUs that need it and keeps the request whole).
 */
export function buildMessages(task: Task, sender: string): ChatMessage[] {
    const parts = [`<rules>\n${rules.trim()}\n</rules>`, `<api>\n${api.trim()}\n</api>`];
    let request: string;
    if (task.kind === "create") {
        parts.push(`<template name="${task.template.id}">\n${task.template.html.trim()}\n</template>`);
        request =
            `Build this app: ${task.request}\n` +
            `Start from the template and change it to do exactly this. Give the app a fitting <title>. Return the whole file.`;
    } else if (task.kind === "change") {
        parts.push(`<current-app>\n${task.current.trim()}\n</current-app>`);
        request = `Change the current app: ${task.request}\nKeep everything else working. Return the whole updated file.`;
    } else {
        parts.push(`<current-app>\n${task.current.trim()}\n</current-app>`);
        parts.push(`<error>\n${task.error}\n</error>`);
        request = "The current app fails with the error above. Find the cause and fix it. Return the whole fixed file.";
    }
    const name = /^@([^:]+)/.exec(sender)?.[1] ?? sender;
    return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${parts.join("\n\n")}\n\nRequest from ${name}: ${request}` },
    ];
}

/*
 * Settings-only mode. A template-shaped request ("a lunch poll: pizza, sushi or
 * salad") needs no new code: the model fills in the template's SETTINGS line,
 * the code stays the tested template. Asks for a few lines of JSON instead of a
 * whole file, so it is faster and cannot break the app. Requests that need more
 * than the settings allow get {"custom": true} and go to the code path.
 */
export type Settings = Record<string, string | string[]>;

const SETTINGS_LINE = /^( *)const SETTINGS = (\{.*\});$/m;

/** A template's settings, parsed from its SETTINGS line. */
export function defaultSettings(t: Template): Settings | null {
    if (!t.fields) return null;
    const m = SETTINGS_LINE.exec(t.html);
    return m ? (JSON.parse(m[2]) as Settings) : null;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The template with these settings, and its <title> set to match. */
export function applySettings(t: Template, settings: Settings): string {
    // "<" escaped, so a value never closes the script.
    const json = JSON.stringify(settings).replace(/</g, "\\u003c");
    return t.html
        .replace(SETTINGS_LINE, (_, indent: string) => `${indent}const SETTINGS = ${json};`)
        .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(String(settings.title ?? t.label))}</title>`);
}

/** An app without what may differ between apps of one template: the title, the settings and the accent colour. */
const codeOnly = (h: string): string => withAccent(h, null).replace(SETTINGS_LINE, "").replace(/<title>[^<]*<\/title>/i, "");

/** A short fingerprint of a template's code (FNV-1a over `codeOnly`). */
export function fingerprint(html: string): string {
    let h = 0x811c9dc5;
    for (const ch of codeOnly(html)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, "0");
}

/*
 * Earlier versions of the templates (0.1.0 to 0.2.0), by fingerprint. Apps built
 * from them are still that template: their settings stay editable, and applying
 * settings rebuilds them on the current version, which upgrades their look.
 */
const LEGACY: Record<string, string> = {
    "4494147f": "poll",
    "16075318": "checklist",
    "c68f075a": "kanban",
    "6a92cec9": "picker",
    "247ee3a0": "scoreboard",
    "2a1055f2": "countdown",
    "011ecea0": "sketch",
};

/** The template an app is, with its settings, when nothing but the settings was changed. */
export function settingsOf(html: string): { template: Template; settings: Settings } | null {
    const m = SETTINGS_LINE.exec(html);
    if (!m) return null;
    const legacy = LEGACY[fingerprint(html)];
    const template = TEMPLATES.find((t) => t.fields && (t.id === legacy || codeOnly(t.html) === codeOnly(html)));
    if (!template) return null;
    try {
        return { template, settings: JSON.parse(m[2]) as Settings };
    } catch {
        return null;
    }
}

const isColor = (s: string): boolean => /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s);

/**
 * The settings from the model's answer, checked against the template's: the same
 * keys with the same kinds of values. Null for {"custom": true} or anything unusable.
 */
export function parseSettings(answer: string, t: Template): Settings | null {
    const defaults = defaultSettings(t);
    if (!defaults) return null;
    const block = /```(?:json)?\s*([\s\S]*?)```/.exec(answer)?.[1] ?? answer;
    const start = block.indexOf("{");
    const end = block.lastIndexOf("}");
    if (start === -1 || end < start) return null;
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(block.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!raw || typeof raw !== "object" || raw.custom) return null;
    const checked = checkSettings(raw, t);
    return typeof checked === "string" ? null : checked;
}

/**
 * Settings checked against the template's: the same keys with the same kinds of
 * values, trimmed and cut to length. A missing key keeps the template's value.
 * The model's answers and the settings form both go through here; a string says
 * what is wrong.
 */
export function checkSettings(raw: Record<string, unknown>, t: Template): Settings | string {
    const defaults = defaultSettings(t);
    if (!defaults) return `The ${t.label.toLowerCase()} template has no settings.`;
    const out: Settings = {};
    for (const [key, fallback] of Object.entries(defaults)) {
        const v = raw[key];
        if (v === undefined) out[key] = fallback;
        else if (Array.isArray(fallback)) {
            if (!Array.isArray(v)) return `"${key}" must be a list.`;
            const items = [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))].map((x) => x.slice(0, 80));
            const min = key === "choices" ? 1 : 2;
            if (items.length < min || items.length > 20) return `"${key}" needs ${min} to 20 entries.`;
            if (key === "colors" && !items.every(isColor)) return `"${key}" must be colours written as #rrggbb.`;
            out[key] = items;
        } else {
            // Models write numbers as numbers ("size": 5); the settings keep them as text.
            const text = typeof v === "number" && isFinite(v) ? String(v) : v;
            if (typeof text !== "string" || !text.trim()) return `"${key}" must not be empty.`;
            if (key === "target" && isNaN(new Date(text).getTime())) return `"${key}" must be a date and time.`;
            out[key] = text.trim().slice(0, 120);
        }
    }
    return out;
}

/** The short prompt for settings-only mode: what the app does, its settings, the request. */
export function buildSettingsMessages(t: Template, current: Settings, request: string, sender: string, today = new Date()): ChatMessage[] {
    const name = /^@([^:]+)/.exec(sender)?.[1] ?? sender;
    const fields = Object.entries(t.fields ?? {})
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n");
    return [
        {
            role: "system",
            content: "You set up ready-made apps for a chat room. Reply with ONE JSON object in a ```json code block and nothing else.",
        },
        {
            role: "user",
            content:
                `The ${t.label.toLowerCase()} app. What it does: ${t.does}\n\n` +
                `Its settings now:\n\`\`\`json\n${JSON.stringify(current, null, 1)}\n\`\`\`\n\n` +
                `The settings:\n${fields}\n\n` +
                `Today is ${today.toISOString().slice(0, 10)}.\n\n` +
                `Request from ${name}: ${request}\n\n` +
                "If this app does what is asked once its settings are changed, reply with the settings changed to fit the request, with the same keys. " +
                "Write the texts in the language of the request. " +
                'If the request needs anything the app cannot do (another feature, other buttons, other behaviour), reply with {"custom": true}.',
        },
    ];
}
