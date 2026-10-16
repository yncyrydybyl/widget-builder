/*
 * Mini-apps as room data. An app is one self-contained HTML file stored in a
 * room state event (one per app, so everyone who joins sees it). What people do
 * in an app travels as small timeline events; an app rebuilds its state by
 * replaying them. No server anywhere.
 *
 * Pure: parsing, validation, extraction from model output, the bridge script.
 */
import type { IRoomEvent } from "matrix-widget-api";

export const APP_TYPE = "de.datanauten.widget_builder.app";
export const EVENT_TYPE = "de.datanauten.widget_builder.event";

/** State events must stay under 64 KiB including JSON escaping. */
export const MAX_HTML = 48_000;
/** One app action. Apps send actions ("voted B"), not whole documents. */
export const MAX_EVENT_DATA = 4_000;

export interface AppDoc {
    id: string;
    name: string;
    description: string;
    html: string;
    version: number;
    author: string;
    updated: number;
    /** Built on the base stylesheet (0.3.0 and later); see `usesBase`. */
    base: boolean;
}

/**
 * The base stylesheet's version, written into every published app's state event
 * (`base`). Apps published before 0.3.0 have none: they were made and checked
 * without `BASE_CSS`, with the host's colours winning over their own, and run
 * that way still (`withBridge(html, extra, false)`); with the base stylesheet
 * some of them break (an app that sets its own `--bg` turns unreadable in dark
 * mode, the 0.1 scoreboard's buttons wrap). Rebuilding one (applying settings,
 * any change) publishes it with the marker.
 */
export const BASE_VERSION = 1;

/** When 0.3.0 was released. Apps published with 0.3.0 and 0.3.1 have no marker but are newer than this. */
export const BASE_SINCE = Date.UTC(2026, 9, 16, 19, 46, 12);

/** Whether a published app is built on the base stylesheet: it says so, or it is newer than 0.3.0. */
export function usesBase(content: { base?: unknown }, ts: number): boolean {
    return typeof content.base === "number" || ts >= BASE_SINCE;
}

/** Sent to an app when it starts (the bridge's `init`). */
export interface AppInfo {
    user: { id: string; name: string };
    theme: string;
    colors: Record<string, string>;
}

export interface AppEvent {
    id: string;
    app: string;
    sender: string;
    ts: number;
    data: unknown;
}

/** null for a removed app (empty content) or anything malformed. */
export function toApp(ev: IRoomEvent & { state_key?: string }): AppDoc | null {
    if (ev.type !== APP_TYPE || !ev.state_key) return null;
    const c = (ev.content ?? {}) as Partial<AppDoc>;
    if (typeof c.html !== "string" || !c.html) return null;
    return {
        id: ev.state_key,
        name: typeof c.name === "string" && c.name ? c.name : ev.state_key,
        description: typeof c.description === "string" ? c.description : "",
        html: c.html,
        version: typeof c.version === "number" ? c.version : 1,
        author: ev.sender,
        updated: ev.origin_server_ts ?? 0,
        base: usesBase(c as { base?: unknown }, ev.origin_server_ts ?? 0),
    };
}

export function toAppEvent(ev: IRoomEvent): AppEvent | null {
    if (ev.type !== EVENT_TYPE) return null;
    const c = (ev.content ?? {}) as { app?: unknown; data?: unknown };
    if (typeof c.app !== "string" || !c.app) return null;
    return { id: ev.event_id, app: c.app, sender: ev.sender, ts: ev.origin_server_ts ?? 0, data: c.data ?? null };
}

/** "Lunch poll!" → "lunch-poll" */
export function slug(name: string): string {
    return (
        name
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "app"
    );
}

/** The HTML file in a model answer: the last ```html block, else the bare document. */
export function extractHtml(answer: string): string | null {
    const blocks = [...answer.matchAll(/```(?:html)?[^\n]*\n([\s\S]*?)(?:```|$)/g)].map((m) => m[1].trim());
    const html = blocks.reverse().find((b) => /<(html|body|script|div)\b/i.test(b));
    if (html) return onlyDocument(html);
    return /<!doctype html|<html\b/i.test(answer) ? onlyDocument(answer) : null;
}

/**
 * Just the document, from `<!doctype html>` (or `<html>`) to `</html>`. Some
 * models copy the prompt's wrapper tags around it (`<template name="poll">`,
 * `<rules>`), and a leading `<template>` makes the browser treat the whole app
 * as inert: a blank page.
 */
function onlyDocument(text: string): string {
    const start = text.search(/<!doctype html|<html\b/i);
    if (start === -1) return text;
    const end = text.toLowerCase().lastIndexOf("</html>");
    return text.slice(start, end === -1 ? undefined : end + 7).trim();
}

/** The `<title>` of a document, for naming a new app. */
export function titleOf(html: string): string {
    return html.match(/<title>([^<]*)<\/title>/i)?.[1].trim() ?? "";
}

/**
 * Problems a generated app is known to have before it runs. Not a sandbox (the
 * sandbox is the iframe and its CSP); this is feedback for the model.
 */
export function checkHtml(html: string): string[] {
    const problems: string[] = [];
    if (html.length > MAX_HTML) problems.push(`The file is ${html.length} characters; the limit is ${MAX_HTML}.`);
    if (/\b(src|href)\s*=\s*["']?https?:/i.test(html) || /@import\s+url\(\s*["']?https?:/i.test(html))
        problems.push("It loads files from the internet; apps must be self-contained (inline CSS and JS).");
    if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(html)) problems.push("It uses the network; apps have no network access.");
    if (/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(html))
        problems.push("It uses browser storage, which is not available; keep shared state in miniapp events.");
    if (/\b(alert|confirm|prompt)\s*\(/.test(html)) problems.push("It uses alert/confirm/prompt, which are blocked; show messages in the page.");
    if (!/<\/html>\s*$/i.test(html.trim()) && !/<\/body>/i.test(html)) problems.push("The file looks cut off (no closing </html>).");
    problems.push(...checkElements(html));
    return problems;
}

/**
 * Elements the script looks up but the page does not have: the most common
 * crash in small-model apps ("Cannot set properties of null", "getContext is not
 * a function"). Found before the app runs, so the model gets the exact cause.
 */
export function checkElements(html: string): string[] {
    const problems: string[] = [];
    // Ids the page defines, in markup or from code (`el.id = "x"`, `setAttribute("id", "x")`).
    const tags = new Map<string, string>();
    for (const m of html.matchAll(/<([a-z][\w-]*)\b[^>]*?\bid\s*=\s*["']([^"']+)["']/gi)) tags.set(m[2], m[1].toLowerCase());
    for (const m of html.matchAll(/\.id\s*=\s*["'`]([^"'`]+)["'`]|setAttribute\(\s*["']id["']\s*,\s*["'`]([^"'`]+)["'`]/g))
        tags.set(m[1] ?? m[2], tags.get(m[1] ?? m[2]) ?? "?");
    // Built ids (`"item-" + i`) cannot be checked; only literal ones are.
    const looked = new Set<string>();
    for (const m of html.matchAll(/getElementById\(\s*["'`]([^"'`$]+)["'`]\s*\)|querySelector(?:All)?\(\s*["'`]#([\w-]+)["'`]\s*\)/g))
        looked.add(m[1] ?? m[2]);
    const missing = [...looked].filter((id) => !tags.has(id));
    for (const id of missing.slice(0, 3))
        problems.push(`The script looks up the element with id "${id}", but the page has no element with id="${id}". Add it to the HTML, or use an id that exists.`);

    // `x.getContext(...)` needs x to be a <canvas>.
    if (/\.getContext\(/.test(html)) {
        const vars = new Map<string, string>();
        for (const m of html.matchAll(/(\w+)\s*=\s*document\.(?:getElementById\(\s*["']([\w-]+)["']|querySelector\(\s*["']#([\w-]+)["'])/g))
            vars.set(m[1], m[2] ?? m[3]);
        const created = /createElement\(\s*["']canvas["']\s*\)/.test(html);
        const wrong: string[] = [];
        for (const m of html.matchAll(/(\w+)\.getContext\(/g)) {
            const id = vars.get(m[1]);
            const tag = id ? tags.get(id) : undefined;
            if (tag && tag !== "canvas" && tag !== "?")
                wrong.push(`"${m[1]}.getContext" is called on the <${tag} id="${id}">, which is not a canvas. Make that element a <canvas>.`);
        }
        problems.push(...wrong);
        if (!wrong.length && !/<canvas\b/i.test(html) && !created)
            problems.push('The script calls getContext, but the page has no <canvas> element. Add <canvas id="canvas" width="600" height="400"></canvas>.');
    }
    return [...new Set(problems)];
}

/**
 * Every app's starting look, in front of its own CSS: plain elements already
 * look finished, and a few classes cover what apps keep needing (rows, cards,
 * lists, badges, avatars, meters). Apps then need little CSS of their own,
 * which keeps them short for a small model and alike in the room. The colours
 * are the host's, set by the bridge, light or dark.
 */
export const BASE_CSS = `
:root { --radius: 12px; --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent); --shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 4px 12px rgb(0 0 0 / 0.05); }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1 { font-size: 20px; line-height: 1.25; margin: 0 0 14px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 0 0 8px; }
p { margin: 0 0 10px; }
small, .muted { color: var(--muted); }
small { font-size: 12px; }
button { font: inherit; font-weight: 600; min-height: 38px; padding: 0 16px; border: 1px solid transparent; border-radius: 10px; background: var(--accent); color: var(--accent-fg); cursor: pointer; transition: filter 0.15s, background 0.15s, transform 0.08s; }
button:hover { filter: brightness(1.07); }
button:active { transform: translateY(1px); }
button:disabled { opacity: 0.5; cursor: default; filter: none; transform: none; }
button.secondary { background: var(--card); color: var(--fg); border-color: var(--line); }
button.ghost { background: transparent; color: var(--muted); font-weight: 400; min-height: 30px; padding: 0 8px; }
button.ghost:hover { background: var(--card); color: var(--fg); filter: none; }
input, select, textarea { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; min-height: 38px; padding: 6px 12px; min-width: 0; }
textarea { width: 100%; min-height: 84px; resize: vertical; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
input[type=checkbox], input[type=radio] { width: 18px; height: 18px; min-height: 0; padding: 0; accent-color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row > input:not([type=checkbox]):not([type=radio]) { flex: 1; }
form.row { margin: 0 0 14px; }
.stack { display: flex; flex-direction: column; gap: 8px; }
.grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; box-shadow: var(--shadow); }
.list { list-style: none; margin: 0; padding: 0; }
.list > li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.list > li:last-child { border-bottom: 0; }
.grow { flex: 1; min-width: 0; }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; background: var(--accent-soft); font-size: 12px; font-weight: 600; }
.avatar { display: inline-grid; place-items: center; flex: none; width: 24px; height: 24px; border-radius: 50%; font-size: 12px; font-weight: 700; }
.meter { height: 8px; border-radius: 999px; background: var(--line); overflow: hidden; }
.meter > span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 0.3s; }
.big { font-size: 44px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.center { text-align: center; }
.empty { text-align: center; color: var(--muted); padding: 20px 8px; }
.appear { animation: miniapp-in 0.2s ease-out; }
@keyframes miniapp-in { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;

/** Accent colours offered for an app (`<html data-accent>`): readable on light and dark. */
export const ACCENTS = ["#0b7a5f", "#2f6fde", "#7c4dce", "#d6336c", "#e8590c", "#d4a106", "#0c8599", "#495057"];

/** The app's chosen accent colour, if any. */
export function accentOf(html: string): string | null {
    return /<html\b[^>]*\bdata-accent="(#[0-9a-f]{6})"/i.exec(html)?.[1] ?? null;
}

/** The app with this accent colour, or with the host's when null. */
export function withAccent(html: string, accent: string | null): string {
    return html.replace(/<html\b[^>]*>/i, (tag) => {
        const rest = tag.replace(/\s+data-accent="[^"]*"/i, "");
        return accent ? rest.replace(/^<html\b/i, `<html data-accent="${accent}"`) : rest;
    });
}

/**
 * Runs inside the app's sandbox, before the app's own code. Gives the app
 * `window.miniapp` and talks to the builder over postMessage. The builder
 * attaches the sender to every event, so an app cannot pretend to be someone.
 */
export const BRIDGE = `(() => {
  const listeners = [], events = [], readyCbs = [];
  let info = null;
  const post = (m) => parent.postMessage(Object.assign({ __miniapp: true }, m), "*");
  // The host's colours as a rule, not inline styles, so an app's own CSS can override them.
  // An app from before the base stylesheet gets them inline, as it was made with: the host's win.
  function theme(colors) {
    if (!document.getElementById("miniapp-base")) {
      for (const [k, v] of Object.entries(colors)) document.documentElement.style.setProperty(k, v);
      return;
    }
    const vars = Object.assign({}, colors);
    const accent = document.documentElement.dataset.accent;
    if (/^#[0-9a-f]{6}$/i.test(accent || "")) {
      const n = parseInt(accent.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      vars["--accent"] = accent;
      vars["--accent-fg"] = lum > 0.6 ? "#111111" : "#ffffff";
    }
    document.getElementById("miniapp-theme").textContent = ":root { color-scheme: " + (info.theme === "dark" ? "dark" : "light") + "; " + Object.entries(vars).map(([k, v]) => k + ": " + v).join("; ") + "; }";
  }
  // The frame fits the app: report the page's height whenever it changes. The box, not
  // scrollHeight, which never drops below the frame's own height. A page sized from
  // the frame (100vh) grows by exactly what the frame just grew, without end; once
  // that shows, stop reporting and let the app scroll in the frame it has.
  let height = 0, viewport = innerHeight, grew = 0, grewAt = 0, follows = false;
  addEventListener("resize", () => { grew = innerHeight - viewport; viewport = innerHeight; grewAt = Date.now(); });
  new ResizeObserver(() => {
    if (follows) return;
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height && grew > 0 && Date.now() - grewAt < 250 && Math.abs(h - height - grew) <= 2) { follows = true; return; }
    if (Math.abs(h - height) > 1) post({ kind: "size", height: (height = h) });
  }).observe(document.documentElement);
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || !e.data.__miniapp) return;
    const m = e.data;
    if (m.kind === "init") {
      info = m.info;
      document.documentElement.dataset.theme = info.theme;
      theme(info.colors);
      readyCbs.splice(0).forEach((f) => f(info));
    } else if (m.kind === "events") {
      for (const ev of m.events) {
        ev.mine = !!info && ev.sender === info.user.id;
        events.push(ev);
        listeners.forEach((f) => { try { f(ev); } catch (err) { report(err); } });
      }
    }
  });
  function report(err) { post({ kind: "error", message: String(err && err.stack || err) }); }
  addEventListener("error", (e) => post({ kind: "error", message: e.message + (e.lineno ? " (line " + e.lineno + ")" : "") }));
  addEventListener("unhandledrejection", (e) => report(e.reason));
  window.miniapp = {
    get user() { return info ? info.user : { id: "", name: "" }; },
    get theme() { return info ? info.theme : "light"; },
    ready(cb) { info ? cb(info) : readyCbs.push(cb); },
    send(data) {
      const s = JSON.stringify(data === undefined ? null : data);
      if (s.length > ${MAX_EVENT_DATA}) throw new Error("miniapp.send: data larger than ${MAX_EVENT_DATA} characters");
      post({ kind: "send", data: JSON.parse(s) });
    },
    on(cb) { listeners.push(cb); events.forEach((ev) => { try { cb(ev); } catch (err) { report(err); } }); },
    events() { return events.slice(); },
    displayName(id) { const m = /^@([^:]+)/.exec(id || ""); return m ? m[1] : id; },
    color(id) {
      let h = 0;
      for (const ch of String(id || "")) h = (h * 31 + ch.codePointAt(0)) % 360;
      return "hsl(" + h + " 60% " + (info && info.theme === "dark" ? 65 : 42) + "%)";
    },
    avatar(id) {
      const el = document.createElement("span");
      el.className = "avatar";
      el.style.background = this.color(id);
      el.style.color = info && info.theme === "dark" ? "#111111" : "#ffffff";
      el.textContent = (this.displayName(id) || "?").slice(0, 1).toUpperCase();
      el.title = this.displayName(id);
      return el;
    },
  };
  post({ kind: "hello" });
})();`;

/**
 * The app document with the base styles and the bridge (and any extra script, such
 * as the probe) first. Without `base`, as before 0.3.0: no base styles, host colours inline.
 */
export function withBridge(html: string, extra = "", base = true): string {
    const styles = base ? `<style id="miniapp-base">${BASE_CSS}</style><style id="miniapp-theme"></style>` : "";
    const tag = `${styles}<script>${BRIDGE}</script>${extra ? `<script>${extra}</script>` : ""}`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
    return `<!doctype html><html><head><meta charset="utf-8">${tag}</head><body>${html}</body></html>`;
}

/** Simple token bucket: an app may not flood the room. */
export class Bucket {
    private tokens: number;
    private last: number;

    constructor(
        private size = 5,
        private perSecond = 0.5,
        now = Date.now(),
    ) {
        this.tokens = size;
        this.last = now;
    }

    take(now = Date.now()): boolean {
        this.tokens = Math.min(this.size, this.tokens + ((now - this.last) / 1000) * this.perSecond);
        this.last = now;
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }
}

/*
 * A published app as its own room widget: an `im.vector.modular.widgets` state
 * event whose URL is this builder in runner mode (`#/?app=<id>`). The URL holds
 * no code; the runner reads the app's HTML from its state event in the room, so
 * a new version of the app reaches the widget without touching the widget.
 */
export const WIDGET_TYPE = "im.vector.modular.widgets";

/** The room widget's state key: one per app, so republishing never adds a second one. */
export function roomWidgetId(appId: string): string {
    return `widget_builder_${appId}`;
}

/** The app a room widget shows, if it is one of ours. */
export function appOfRoomWidget(stateKey: string): string | null {
    return stateKey.startsWith("widget_builder_") ? stateKey.slice("widget_builder_".length) || null : null;
}

export function roomWidgetContent(appId: string, name: string, url: string, creator: string): Record<string, unknown> {
    return {
        type: "m.custom",
        url,
        name,
        creatorUserId: creator,
        waitForIframeLoad: true,
        data: { title: name, app: appId },
    };
}
