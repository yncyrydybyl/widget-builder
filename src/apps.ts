/*
 * Mini-apps as room data. An app is one self-contained HTML file stored in a
 * room state event (one per app, so everyone who joins sees it). What people do
 * in an app travels as small timeline events; an app rebuilds its state by
 * replaying them. No server anywhere.
 *
 * Pure: parsing, validation, extraction from model output, the bridge script.
 */
import type { IRoomEvent } from "matrix-widget-api";

export const APP_TYPE = "de.minagawa.widget_builder.app";
export const EVENT_TYPE = "de.minagawa.widget_builder.event";

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
    if (html) return html;
    const start = answer.search(/<!doctype html|<html\b/i);
    if (start === -1) return null;
    const end = answer.toLowerCase().lastIndexOf("</html>");
    return answer.slice(start, end === -1 ? undefined : end + 7).trim();
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
    return problems;
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
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || !e.data.__miniapp) return;
    const m = e.data;
    if (m.kind === "init") {
      info = m.info;
      document.documentElement.dataset.theme = info.theme;
      for (const [k, v] of Object.entries(info.colors)) document.documentElement.style.setProperty(k, v);
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
  };
  post({ kind: "hello" });
})();`;

/** The app document with the bridge as its first script. */
export function withBridge(html: string): string {
    const tag = `<script>${BRIDGE}</script>`;
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
