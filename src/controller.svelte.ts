/*
 * The builder: a chat with the model that produces an app, a sandboxed preview,
 * publishing into room state, and running published apps with their shared
 * events. Reactive with runes; App.svelte renders it.
 */
import type { IRoomEvent, WidgetApi } from "matrix-widget-api";
import { APP_TYPE, BASE_VERSION, Bucket, accentOf, withAccent, EVENT_TYPE, WIDGET_TYPE, appOfRoomWidget, checkHtml, roomWidgetContent, roomWidgetId, extractHtml, slug, titleOf, toApp, toAppEvent, type AppDoc, type AppEvent, type AppInfo } from "./apps";
import { stripThinking, type ChatMessage } from "./chat";
import { DEFAULT_MODEL, EchoEngine, MODELS, availableModels, isCached, loadModel, webGpuStatus, type ChatOptions, type Engine, type ModelInfo } from "./llm";
import { TEMPLATES, applySettings, buildMessages, checkSettings, buildSettingsMessages, defaultSettings, parseSettings, pickTemplate, settingsOf, type Settings, type Task, type Template } from "./skills";
import { judgeProbe, probeApp, type ProbeReport } from "./probe";
import { capabilitiesFor, connect, initialTheme, readParams, type Params } from "./widget-connect";

export type RoomStatus = "standalone" | "connecting" | "ready" | "no-permission";
export type EngineStatus = "idle" | "loading" | "ready" | "error";

export interface ChatEntry {
    id: number;
    role: "user" | "model" | "note";
    text: string;
    /** Model turns: lines of code written so far, while streaming. */
    lines?: number;
    problems?: string[];
    error?: boolean;
}

export interface Draft {
    html: string;
    /** Set when editing a published app: publishing updates it. */
    appId: string | null;
    name: string;
    /** The app's version this draft started from; a newer one in the room is a conflict. */
    baseVersion: number | null;
}

/** Someone else published the app while it was being edited here. */
export interface Conflict {
    version: number;
    author: string;
}

/** The builder's own preferences, kept in this browser. */
interface Prefs {
    modelId: string;
    /** Per model: the largest prompt part this GPU prefills in one pass (see llm-widget). */
    chunks: Record<string, number>;
}

const SETTINGS_KEY = "widget-builder.settings";
const LOCAL_USER = "@you:local";
const MIN_CHUNK = 300;
/*
 * Prompt part size before this GPU has shown its limit. Integrated GPUs (a
 * Radeon 860M) lose the device on one long prefill even with a 1.5B model; reading
 * in parts costs a few seconds on fast GPUs and saves a reset on slow ones.
 */
const FIRST_CHUNK = 2400;
const MAX_GPU_RETRIES = 3;
/** Model calls per request: the answer, a fix with the probe's findings, a fresh start. */
const MAX_ATTEMPTS = 3;
// "Model not loaded": the engine died with an earlier device loss. "Stalled": our
// watchdog gave up on a GPU that stopped answering without reporting anything.
const isGpuLoss = (msg: string): boolean => /device (was )?lost|GPUBuffer|mapAsync|DEVICE_LOST|ModelNotLoaded|not loaded|stalled/i.test(msg);
/*
 * A prompt part or an answer that makes no progress for this long counts as a
 * hung GPU. Seen on a Radeon 860M: a prefill round that never returned, with no
 * device-lost event. Generous: a round normally answers within seconds.
 */
const STALL_MS = 90_000;

function loadPrefs(): Prefs {
    const defaults: Prefs = { modelId: DEFAULT_MODEL, chunks: {} };
    try {
        const s = { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Prefs>) };
        if (!MODELS.some((m) => m.id === s.modelId)) s.modelId = DEFAULT_MODEL;
        return s;
    } catch {
        return defaults;
    }
}

/** One state slot: its type and state key. */
const stateId = (ev: IRoomEvent): string => `${ev.type}\u0000${(ev as IRoomEvent & { state_key?: string }).state_key ?? ""}`;

export class Controller {
    readonly params: Params = readParams();
    readonly userId: string = this.params.get("matrix_user_id") ?? this.params.get("userId") ?? LOCAL_USER;
    readonly useEcho = this.params.get("engine") === "echo";
    /** `#/?app=<id>`: show only that app, as its own widget. */
    readonly runnerOnly: string | null = this.params.get("app");

    theme = $state<"light" | "dark">(initialTheme(this.params));
    room = $state<RoomStatus>("connecting");
    missing = $state<string[]>([]);
    settings = $state<Prefs>(loadPrefs());

    engineStatus = $state<EngineStatus>("idle");
    progress = $state(0);
    progressText = $state("");
    engineError = $state("");
    gpuProblem = $state<string | null>(null);
    f16 = $state(true);
    cached = $state<Record<string, boolean>>({});

    chat = $state<ChatEntry[]>([]);
    draft = $state<Draft | null>(null);
    busy = $state(false);
    /** The draft's last runtime error, reported by its sandbox. */
    draftError = $state<string | null>(null);
    /** "auto" or a template id: what a new app starts from. */
    startFrom = $state("auto");

    apps = $state<AppDoc[]>([]);
    /** Shared actions per published app, oldest first. */
    events = $state<Record<string, AppEvent[]>>({});
    /** Actions in the preview: local only, never sent. */
    previewEvents = $state<AppEvent[]>([]);
    /** What the preview starts with: the room's actions when editing a published app. */
    previewBase = $state<AppEvent[]>([]);
    /** Counts preview resets: the preview reloads on each, an app cannot unlearn actions it has seen. */
    previewRun = $state(0);
    /** Set when publishing would replace a version someone else published meanwhile. */
    conflict = $state<Conflict | null>(null);
    /** Apps that are also room widgets of their own: app id → widget name. */
    roomWidgets = $state<Record<string, string>>({});
    view = $state<"build" | "apps">("build");
    running = $state<string | null>(null);
    notice = $state("");

    private api: WidgetApi | null = null;
    private engine: Engine | null = null;
    private abort: AbortController | null = null;
    private undoStack: Draft[] = [];
    private nextEntry = 1;
    private nextLocal = 1;
    private buckets = new Map<string, Bucket>();
    private lastPromptChars = 0;
    /** The best version so far of the app being built, by number of problems found. */
    private best: { html: string; problems: string[] } | null = null;
    /** State slots the host has pushed; a later read of older state must not undo them. */
    private readonly pushed = new Set<string>();
    /** `#/?probe=0` turns the click-through test off (for tests of the plain flow). */
    readonly useProbe = this.params.get("probe") !== "0";
    /** `#/?settings=0`: always write code, even for a request a template's settings cover. */
    readonly useSettings = this.params.get("settings") !== "0";

    get model(): string {
        return this.engine?.modelId ?? "";
    }

    get models(): ModelInfo[] {
        return availableModels(this.f16);
    }

    get selected(): ModelInfo | undefined {
        return this.models.find((m) => m.id === this.settings.modelId);
    }

    /** A draft that is not in the room yet, or differs from its published version. */
    get unsaved(): boolean {
        if (!this.draft) return false;
        return this.draft.html !== this.apps.find((a) => a.id === this.draft!.appId)?.html;
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    saveSettings(): void {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
        } catch {
            /* private window */
        }
    }

    async start(): Promise<void> {
        if (this.runnerOnly) this.running = this.runnerOnly;
        void webGpuStatus().then((g) => {
            this.gpuProblem = this.useEcho ? null : g.problem;
            this.f16 = g.f16 && this.params.get("f16") !== "0";
            if (!this.models.some((m) => m.id === this.settings.modelId)) this.settings.modelId = this.models[0].id;
            void this.refreshCache();
        });
        const capabilities = capabilitiesFor(this.runnerOnly);
        const conn = await connect(this.params, capabilities, {
            onState: (events) => this.onState(events),
            onEvent: (ev) => this.onEvent(ev),
            onTheme: (name) => (this.theme = name.startsWith("dark") ? "dark" : "light"),
        });
        if (!conn) {
            this.room = "standalone";
            return;
        }
        this.api = conn.api;
        const needed = capabilities.filter((c) => c !== "io.element.requires_client");
        this.missing = needed.filter((c) => !conn.approved.includes(c));
        if (this.missing.length === needed.length) {
            this.room = "no-permission";
            return;
        }
        this.room = "ready";
        // The Player pushes only state changes, not the state already there, so
        // read that once. A push for the same key wins: it is newer.
        try {
            const types = this.runnerOnly ? [[APP_TYPE, this.runnerOnly]] : [[APP_TYPE], [WIDGET_TYPE]];
            for (const [type, key] of types) {
                const found = await this.api.readStateEvents(type, 100, key);
                this.onState(found.filter((ev) => !this.pushed.has(stateId(ev))), false);
            }
        } catch {
            /* pushes only */
        }
        try {
            for (const ev of await this.api.readRoomEvents(EVENT_TYPE, 100)) this.onEvent(ev);
        } catch {
            /* live events only */
        }
    }

    private onState(events: IRoomEvent[], pushed = true): void {
        for (const ev of events) {
            const key = (ev as IRoomEvent & { state_key?: string }).state_key;
            if (pushed) this.pushed.add(stateId(ev));
            if (ev.type === WIDGET_TYPE) {
                const app = appOfRoomWidget(key ?? "");
                if (!app) continue;
                const { [app]: _, ...rest } = this.roomWidgets;
                const name = (ev.content as { name?: unknown } | undefined)?.name;
                this.roomWidgets = (ev.content as { url?: unknown } | undefined)?.url ? { ...rest, [app]: typeof name === "string" ? name : app } : rest;
                continue;
            }
            if (ev.type !== APP_TYPE) continue;
            const app = toApp(ev);
            const rest = this.apps.filter((a) => a.id !== key);
            this.apps = app ? [...rest, app].sort((a, b) => a.name.localeCompare(b.name)) : rest;
        }
    }

    private onEvent(ev: IRoomEvent): void {
        // Element pushes state changes as send_event too.
        if (ev.type === APP_TYPE || ev.type === WIDGET_TYPE) return this.onState([ev]);
        const e = toAppEvent(ev);
        if (e) this.addEvent(e);
    }

    private addEvent(e: AppEvent): void {
        const list = this.events[e.app] ?? [];
        if (list.some((x) => x.id === e.id)) return;
        this.events[e.app] = [...list, e].sort((a, b) => a.ts - b.ts);
    }

    /** An action from an app's sandbox. Preview actions stay local. */
    async sendAppEvent(appId: string | null, data: unknown): Promise<void> {
        if (appId === null || !this.api) {
            this.previewEvents = [...this.previewEvents, { id: `local-${this.nextLocal++}`, app: "", sender: this.userId, ts: Date.now(), data }];
            return;
        }
        let bucket = this.buckets.get(appId);
        if (!bucket) this.buckets.set(appId, (bucket = new Bucket()));
        if (!bucket.take()) {
            this.notice = "The app is sending too fast; an action was dropped.";
            return;
        }
        try {
            const res = await this.api.sendRoomEvent(EVENT_TYPE, { app: appId, data });
            // Hosts differ in whether they echo our own events; the event id dedupes.
            this.addEvent({ id: res.event_id ?? `sent-${this.nextLocal++}`, app: appId, sender: this.userId, ts: Date.now(), data });
        } catch (e) {
            this.notice = `Could not send: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    reportAppError(appId: string | null, message: string): void {
        if (appId === null) {
            // Fixing it is the probe's job while building; afterwards the "fix it" button.
            this.draftError = message;
        } else this.notice = `${this.apps.find((a) => a.id === appId)?.name ?? appId}: ${message}`;
    }

    private say(role: ChatEntry["role"], text: string, extra: Partial<ChatEntry> = {}): ChatEntry {
        const entry: ChatEntry = { id: this.nextEntry++, role, text, ...extra };
        this.chat = [...this.chat, entry];
        return this.chat[this.chat.length - 1];
    }

    /** Changes a chat entry already shown (streamed text, a result). */
    private patch(entry: ChatEntry, patch: Partial<ChatEntry>): void {
        const i = this.chat.findIndex((e) => e.id === entry.id);
        if (i !== -1) this.chat[i] = { ...this.chat[i], ...patch };
    }

    /** A message in the build chat: a new app, or a change to the current draft. */
    async ask(request: string): Promise<void> {
        const text = request.trim();
        if (!text || this.busy) return;
        this.say("user", text);
        let task: Task;
        if (this.draft) {
            // Still the template with other settings: a change may be settings only too.
            const s = settingsOf(this.draft.html);
            if (s && (await this.trySettings(s.template, s.settings, text)) !== "code") return;
            task = { kind: "change", request: text, current: this.draft.html };
        } else {
            const template = this.startFrom === "auto" ? pickTemplate(text) : (TEMPLATES.find((t) => t.id === this.startFrom) ?? pickTemplate(text));
            this.say("note", `Starting from the ${template.label.toLowerCase()} template.`);
            const settings = defaultSettings(template);
            if (settings && (await this.trySettings(template, settings, text)) !== "code") return;
            task = { kind: "create", request: text, template };
        }
        await this.run(task);
    }

    /** Sends the preview's runtime error back to the model. */
    async fix(): Promise<void> {
        if (!this.draft || !this.draftError || this.busy) return;
        this.say("user", `Fix: ${this.draftError}`);
        await this.run({ kind: "fix", error: this.draftError, current: this.draft.html });
    }

    /**
     * One model call. A new app is then tried out (checkHtml, then the click-through
     * probe); with problems it goes back to the model with them, up to
     * MAX_ATTEMPTS calls in all, and the version with the fewest problems stays.
     */
    private async run(task: Task, gpuRetries = 0, attempt = 1, temperature = 0.2): Promise<void> {
        if (!this.engine) {
            this.busy = false;
            this.say("note", "Load a model first.", { error: true });
            return;
        }
        const depth = gpuRetries + attempt - 1;
        if (attempt === 1 && gpuRetries === 0) this.best = null;
        this.busy = true;
        const engine = this.engine;
        const entry = this.say("model", "", { lines: 0 });
        const update = (patch: Partial<ChatEntry>): void => this.patch(entry, patch);
        this.abort = new AbortController();
        try {
            const messages = buildMessages(task, this.userId);
            this.lastPromptChars = messages.reduce((n, m) => n + m.content.length, 0);
            const raw = await this.chatGuarded(engine, messages, (soFar) => update({ text: "Writing the app…", lines: soFar.split("\n").length }), {
                onRound: (i, of) => update({ text: `Reading the instructions (part ${i} of ${of})…` }),
                maxTokens: 3000,
                temperature,
            });
            const answer = stripThinking(raw);
            const html = extractHtml(answer);
            if (!html) {
                update({ text: answer || "The model returned nothing.", lines: undefined, error: true });
                if (attempt < MAX_ATTEMPTS) await this.run(task, 0, attempt + 1, 0.7);
                return;
            }
            const problems = checkHtml(html);
            // The sentence after the code block; nothing useful if the block never closed.
            const fences = answer.match(/```/g)?.length ?? 0;
            const after = fences >= 2 ? answer.slice(answer.lastIndexOf("```") + 3).trim() : "";
            const summary = after.slice(0, 300) || (fences === 1 ? "The answer stopped before the end of the file." : "Done.");
            update({ text: summary, lines: html.split("\n").length, problems });
            this.setDraft(html);
            problems.push(...(await this.tryOut(html)));
            if (!this.best || problems.length < this.best.problems.length) this.best = { html, problems };
            if (!problems.length) return;
            if (attempt < MAX_ATTEMPTS) {
                // Second try: fix with the exact findings. Third: start over with more
                // variety, which gets out of a fix that goes in circles.
                const fresh = attempt === MAX_ATTEMPTS - 1 && task.kind === "create";
                this.say("note", fresh ? "Starting over, with the problems in mind…" : "Asking the model to fix these problems…");
                const next: Task = fresh
                    ? { ...task, request: `${task.request}\nAvoid these problems an earlier version had:\n- ${problems.join("\n- ")}` }
                    : { kind: "fix", error: problems.join("\n"), current: (this.best ?? { html }).html };
                await this.run(next, 0, attempt + 1, fresh ? 0.7 : 0.2);
                return;
            }
            // Out of attempts: keep the best version, say what is still wrong.
            if (this.best && this.best.html !== html) {
                this.setDraft(this.best.html);
                this.say("note", `Kept the version with the fewest problems (${this.best.problems.length}). Describe a fix, or press "fix it".`);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const stall = /stalled/.test(msg);
            // Stop pressed: no recovery. The watchdog aborts too, but on purpose.
            const stopped = !!this.abort?.signal.aborted && !stall;
            if (isGpuLoss(msg) && gpuRetries < MAX_GPU_RETRIES && !stopped) {
                update({
                    text: stall
                        ? "The model stopped responding; reloading it and retrying in smaller parts…"
                        : "The GPU reset; reloading the model and retrying in smaller parts…",
                    lines: undefined,
                });
                await this.recoverFromGpuLoss(engine);
                if (!this.engine) {
                    update({ text: "The model could not be reloaded after a GPU reset.", error: true });
                    return;
                }
                // Stays busy through the retry: run() takes over the flag.
                return await this.run(task, gpuRetries + 1, attempt, temperature);
            }
            if (isGpuLoss(msg) && !stopped) {
                // Out of retries: the engine is gone. Say so instead of failing every later request.
                const tooBig = `${engine.modelId} keeps resetting this GPU, even in small parts. Choose a smaller model.`;
                update({ text: tooBig, lines: undefined, error: true });
                this.engine = null;
                this.engineStatus = "error";
                this.engineError = tooBig;
                void engine.unload().catch(() => undefined);
                return;
            }
            update({ text: msg, lines: undefined, error: true });
        } finally {
            if (depth === 0) {
                this.busy = false;
                this.abort = null;
            }
        }
    }

    /**
     * One model call, aborted by the Stop button or by the watchdog: a hung GPU
     * never answers and never reports an error. Throws "The model stalled" then.
     */
    private async chatGuarded(engine: Engine, messages: ChatMessage[], onText: (soFar: string) => void, opts: ChatOptions): Promise<string> {
        const abort = this.abort!;
        let lastProgress = Date.now();
        let stalled = false;
        const watchdog = setInterval(() => {
            if (Date.now() - lastProgress < STALL_MS) return;
            stalled = true;
            abort.abort();
        }, 5000);
        try {
            const raw = await Promise.race([
                engine.chat(
                    messages,
                    (soFar) => {
                        lastProgress = Date.now();
                        onText(soFar);
                    },
                    {
                        ...opts,
                        signal: abort.signal,
                        chunkChars: this.settings.chunks[engine.modelId] ?? FIRST_CHUNK,
                        onRound: (i, of) => {
                            lastProgress = Date.now();
                            opts.onRound?.(i, of);
                        },
                    },
                ),
                // The engine may not even return after the abort; do not wait for it.
                new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => stalled && reject(new Error("The model stalled")))),
            ]);
            if (stalled) throw new Error("The model stalled");
            return raw;
        } finally {
            clearInterval(watchdog);
        }
    }

    /**
     * Settings-only mode (see skills.ts): the model fills in the template's
     * settings, the code stays the template's. "code" when the request needs more
     * (or anything goes wrong): the caller then has the model write code.
     */
    private async trySettings(template: Template, current: Settings, request: string): Promise<"done" | "stopped" | "code"> {
        if (!this.engine || !this.useSettings) return "code";
        const engine = this.engine;
        this.busy = true;
        this.abort = new AbortController();
        const entry = this.say("model", `Filling in the ${template.label.toLowerCase()}'s settings…`);
        const update = (patch: Partial<ChatEntry>): void => this.patch(entry, patch);
        try {
            const messages = buildSettingsMessages(template, current, request, this.userId);
            this.lastPromptChars = messages.reduce((n, m) => n + m.content.length, 0);
            const raw = await this.chatGuarded(engine, messages, () => undefined, { maxTokens: 500, temperature: 0.2 });
            const settings = parseSettings(stripThinking(raw), template);
            if (!settings) {
                update({ text: "This needs more than the template's settings; writing code instead…" });
                return "code";
            }
            const html = applySettings(template, settings);
            const shown = Object.entries(settings)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
                .join(" · ");
            update({ text: `Set up the ${template.label.toLowerCase()} template, no code changed. ${shown}` });
            if ((await this.tryOut(html)).length) {
                this.say("note", "These settings break the app; writing code instead…");
                return "code";
            }
            this.setDraft(html);
            return "done";
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (this.abort?.signal.aborted && !/stalled/.test(msg)) {
                update({ text: msg, error: true });
                return "stopped";
            }
            // A GPU loss included: the code path recovers from it.
            update({ text: `Could not fill in the settings (${msg}); writing code instead…` });
            return "code";
        } finally {
            this.busy = false;
            this.abort = null;
        }
    }

    /** The click-through test, with a note in the chat; the problems it found. */
    private async tryOut(html: string): Promise<string[]> {
        if (!this.useProbe) return [];
        const testing = this.say("note", "Trying the app out: typing, clicking…");
        const found = judgeProbe(await this.probe(html));
        this.patch(testing, {
            text: found.length ? `Tried the app out: ${found.length === 1 ? "1 problem" : `${found.length} problems`}.` : "Tried the app out: it works.",
            problems: found,
        });
        return found;
    }

    /** Uses the app once in a hidden sandbox (see probe.ts). */
    private probe(html: string): Promise<ProbeReport> {
        return probeApp(html, this.appInfo());
    }

    /** What an app learns when it starts: who uses it, and the builder's theme and colours. */
    appInfo(): AppInfo {
        const css = getComputedStyle(document.documentElement);
        const colors: Record<string, string> = {};
        for (const k of ["--bg", "--fg", "--muted", "--accent", "--accent-fg", "--card", "--line"]) colors[k] = css.getPropertyValue(k).trim();
        return { user: { id: this.userId, name: /^@([^:]+)/.exec(this.userId)?.[1] ?? this.userId }, theme: this.theme, colors };
    }

    /** A new version of the draft. It keeps the draft's accent colour unless `accent` says otherwise. */
    private setDraft(html: string, accent: string | null | undefined = undefined): void {
        html = withAccent(html, accent !== undefined ? accent : (accentOf(html) ?? (this.draft && accentOf(this.draft.html))));
        if (this.draft) this.undoStack.push({ ...this.draft });
        const name = this.draft?.appId ? this.draft.name : titleOf(html) || this.draft?.name || "New app";
        this.draft = { html, appId: this.draft?.appId ?? null, name, baseVersion: this.draft?.baseVersion ?? null };
        this.draftError = null;
        this.resetPreviewData();
    }

    /** The app's accent colour; null goes back to the room client's. */
    setAccent(accent: string | null): void {
        if (!this.draft || this.busy || accentOf(this.draft.html) === accent) return;
        this.setDraft(this.draft.html, accent);
    }

    /** The preview's actions back to where they started: none, or the room's when editing. */
    resetPreviewData(): void {
        this.previewEvents = [...this.previewBase];
        this.previewRun++;
    }

    undo(): void {
        const prev = this.undoStack.pop();
        if (!prev) return;
        this.draft = prev;
        this.draftError = null;
        this.resetPreviewData();
        this.say("note", "Went back to the previous version.");
    }

    /** Start over: forget the draft so the next message builds a new app. */
    newApp(): void {
        this.draft = null;
        this.undoStack = [];
        this.draftError = null;
        this.previewBase = [];
        this.previewEvents = [];
        this.conflict = null;
        this.chat = [];
    }

    /**
     * The settings form: the draft's template with new settings, no model needed.
     * Checked like the model's settings; returns what is wrong, or null when applied.
     */
    changeSettings(raw: Record<string, unknown>): string | null {
        const s = this.draft && settingsOf(this.draft.html);
        if (!s || this.busy) return "These settings cannot be changed now.";
        const checked = checkSettings(raw, s.template);
        if (typeof checked === "string") return checked;
        const html = applySettings(s.template, checked);
        if (html === this.draft!.html) return null;
        this.setDraft(html);
        this.say("note", "Changed the settings by hand, no code changed.");
        return null;
    }

    /** Code edited by hand: becomes the draft, then gets the same checks as the model's code. */
    async changeCode(html: string): Promise<void> {
        if (!this.draft || this.busy || html.trim() === this.draft.html.trim()) return;
        this.busy = true;
        try {
            // The code decides the accent too: removing data-accent in it removes the colour.
            this.setDraft(html.trim(), accentOf(html));
            const problems = checkHtml(this.draft.html);
            this.say("note", problems.length ? "Changed the code by hand. It has problems:" : "Changed the code by hand.", { problems });
            const found = await this.tryOut(this.draft.html);
            if (problems.length || found.length) this.say("note", "Describe a fix, change the code again, or undo.");
        } finally {
            this.busy = false;
        }
    }

    stop(): void {
        this.abort?.abort();
    }

    /**
     * Publishes the draft as a room state event: new, or a new version of the app it
     * came from. When someone else published that app since this draft started,
     * sets `conflict` instead, until called again with `force`.
     */
    async publish(name: string, force = false): Promise<void> {
        if (!this.draft || !this.api) return;
        const problems = checkHtml(this.draft.html).filter((p) => p.includes("limit"));
        if (problems.length) {
            this.notice = problems[0];
            return;
        }
        const current = this.draft.appId ? this.apps.find((a) => a.id === this.draft!.appId) : undefined;
        if (current && this.draft.baseVersion !== null && current.version > this.draft.baseVersion && !force) {
            this.conflict = { version: current.version, author: current.author };
            return;
        }
        this.conflict = null;
        let id = this.draft.appId;
        if (!id) {
            const base = slug(name);
            id = base;
            for (let n = 2; this.apps.some((a) => a.id === id); n++) id = `${base}-${n}`;
        }
        const previous = this.apps.find((a) => a.id === id);
        const content = { name: name.trim() || id, description: "", html: this.draft.html, version: (previous?.version ?? 0) + 1, base: BASE_VERSION };
        try {
            await this.api.sendStateEvent(APP_TYPE, id, content);
        } catch (e) {
            this.notice = `Could not publish: ${e instanceof Error ? e.message : String(e)}. Publishing needs the power level for room settings.`;
            return;
        }
        // Show it now; the host's state push confirms it.
        this.onState([{ type: APP_TYPE, state_key: id, sender: this.userId, origin_server_ts: Date.now(), content, event_id: "", room_id: "", unsigned: {} } as IRoomEvent]);
        this.draft = { ...this.draft, appId: id, name: content.name, baseVersion: content.version };
        this.notice = `Published "${content.name}" (version ${content.version}).`;
        // Every published app becomes a room widget too. Its URL only names the
        // app, so a new version needs no widget change unless the name changed.
        if (this.roomWidgets[id] !== content.name) {
            const added = await this.addToRoom(id, content.name);
            if (added) this.notice += " It is in the room's widgets now.";
        }
    }

    /** The widget may add room widgets (an approved capability, plus the power level when sending). */
    get canAddWidgets(): boolean {
        return !!this.api && !this.missing.includes(`org.matrix.msc2762.send.state_event:${WIDGET_TYPE}`);
    }

    /** Adds an app to the room as its own widget, or renames it there. */
    async addToRoom(id: string, name: string): Promise<boolean> {
        if (!this.api || !this.canAddWidgets) return false;
        const content = roomWidgetContent(id, name, this.widgetUrl(id), this.userId);
        try {
            await this.api.sendStateEvent(WIDGET_TYPE, roomWidgetId(id), content);
        } catch (e) {
            this.notice = `Could not add "${name}" as a room widget: ${e instanceof Error ? e.message : String(e)}`;
            return false;
        }
        this.roomWidgets = { ...this.roomWidgets, [id]: name };
        return true;
    }

    /** Removes an app's room widget; the app itself stays published. */
    async removeFromRoom(id: string): Promise<void> {
        if (!this.api || !(id in this.roomWidgets)) return;
        try {
            await this.api.sendStateEvent(WIDGET_TYPE, roomWidgetId(id), {});
            const { [id]: _, ...rest } = this.roomWidgets;
            this.roomWidgets = rest;
        } catch (e) {
            this.notice = `Could not remove the room widget: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    async remove(id: string): Promise<void> {
        if (!this.api) return;
        try {
            await this.api.sendStateEvent(APP_TYPE, id, {});
            this.apps = this.apps.filter((a) => a.id !== id);
            await this.removeFromRoom(id);
            if (this.running === id) this.running = null;
        } catch (e) {
            this.notice = `Could not remove: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    /**
     * Loads a published app into the builder to change it. The preview starts with
     * the app's actions from the room (copies, still local), so a change shows how
     * it reads what people already did.
     */
    edit(id: string): void {
        const app = this.apps.find((a) => a.id === id);
        if (!app) return;
        this.newApp();
        this.draft = { html: app.html, appId: app.id, name: app.name, baseVersion: app.version };
        this.previewBase = (this.events[app.id] ?? []).map((e) => ({ ...e, app: "" }));
        this.resetPreviewData();
        const how = settingsOf(app.html) ? "Change its settings or code below" : "Change its code below";
        this.say("note", `Editing "${app.name}" (version ${app.version}). ${how}, or describe a change to the model. Publishing replaces it for everyone.`);
        this.view = "build";
    }

    /** The URL that shows one app on its own; the client fills in the $ placeholders. */
    widgetUrl(id: string): string {
        const base = window.location.href.split("#")[0].split("?")[0];
        return `${base}#/?app=${encodeURIComponent(id)}&matrix_user_id=$matrix_user_id&theme=$org.matrix.msc2873.client_theme`;
    }

    /** Device lost: halve the part size for this model, reload it. */
    private async recoverFromGpuLoss(lost: Engine): Promise<void> {
        const current = Math.min(this.settings.chunks[lost.modelId] ?? FIRST_CHUNK, this.lastPromptChars || FIRST_CHUNK);
        this.settings.chunks[lost.modelId] = Math.max(MIN_CHUNK, Math.floor(current / 2));
        this.saveSettings();
        this.engine = null;
        this.engineStatus = "idle";
        void lost.unload();
        await this.loadModel();
    }

    async loadModel(): Promise<void> {
        if (this.engineStatus === "loading") return;
        this.engineStatus = "loading";
        this.engineError = "";
        this.progress = 0;
        this.progressText = "Starting…";
        try {
            await this.engine?.unload();
            this.engine = null;
            this.engine = this.useEcho
                ? new EchoEngine()
                : await loadModel(
                      this.selected ?? this.models[0],
                      this.f16,
                      (p) => {
                          this.progress = p.fraction;
                          this.progressText = p.text;
                      },
                      Number(this.params.get("ctx")) || undefined,
                  );
            this.engineStatus = "ready";
            void this.refreshCache();
        } catch (e) {
            this.engineStatus = "error";
            this.engineError = e instanceof Error ? e.message : String(e);
        }
    }

    async unloadModel(): Promise<void> {
        this.stop();
        await this.engine?.unload();
        this.engine = null;
        this.engineStatus = "idle";
    }

    private async refreshCache(): Promise<void> {
        if (this.useEcho) return;
        const entries = await Promise.all(this.models.map(async (m) => [m.id, await isCached(m, this.f16)] as const));
        this.cached = Object.fromEntries(entries);
    }
}
