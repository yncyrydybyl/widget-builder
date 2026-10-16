/*
 * What the model knows about building apps: the miniapp API, the rules, and a
 * working template close to the request. Small models write far better code
 * when they adapt a working example than when they start from nothing, so
 * every new app starts from a template.
 *
 * Pure: prompt building only.
 */
import type { ChatMessage } from "./chat";
import api from "./skills/api.md?raw";
import rules from "./skills/rules.md?raw";
import blank from "./skills/templates/blank.html?raw";
import checklist from "./skills/templates/checklist.html?raw";
import picker from "./skills/templates/picker.html?raw";
import poll from "./skills/templates/poll.html?raw";
import scoreboard from "./skills/templates/scoreboard.html?raw";

export interface Template {
    id: string;
    label: string;
    /** Words in a request that make this template the starting point. */
    keywords: string[];
    html: string;
}

export const TEMPLATES: Template[] = [
    {
        id: "poll",
        label: "Poll",
        keywords: ["poll", "vote", "voting", "survey", "umfrage", "abstimmung", "abstimmen", "choose", "option", "rating", "rate", "bewertung"],
        html: poll,
    },
    {
        id: "checklist",
        label: "Checklist",
        keywords: ["list", "todo", "to-do", "task", "checklist", "shopping", "packing", "liste", "aufgabe", "einkauf", "agenda", "items", "bring"],
        html: checklist,
    },
    {
        id: "picker",
        label: "Random picker",
        keywords: ["random", "pick", "picker", "dice", "draw", "lottery", "wheel", "zufall", "würfel", "auslosen", "losen", "roulette", "who's next", "shuffle"],
        html: picker,
    },
    {
        id: "scoreboard",
        label: "Scoreboard",
        keywords: ["score", "points", "scoreboard", "leaderboard", "game", "counter", "count", "tally", "punkte", "spiel", "zähler", "tournament", "turnier"],
        html: scoreboard,
    },
    { id: "blank", label: "Blank", keywords: [], html: blank },
];

/** The template whose keywords best match the request; the blank one otherwise. */
export function pickTemplate(request: string): Template {
    const text = request.toLowerCase();
    let best = TEMPLATES[TEMPLATES.length - 1];
    let bestScore = 0;
    for (const t of TEMPLATES) {
        const score = t.keywords.filter((k) => text.includes(k)).length;
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
