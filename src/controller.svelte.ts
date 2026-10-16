/*
 * The builder: a chat with the model that produces an app, a sandboxed preview,
 * publishing into room state, and running published apps with their shared
 * events. Reactive with runes; App.svelte renders it.
 */
import type { IRoomEvent, WidgetApi } from "matrix-widget-api";
import { APP_TYPE, Bucket, EVENT_TYPE, WIDGET_TYPE, appOfRoomWidget, checkHtml, roomWidgetContent, roomWidgetId, extractHtml, slug, titleOf, toApp, toAppEvent, type AppDoc, type AppEvent } from "./apps";
import { stripThinking } from "./chat";
import { DEFAULT_MODEL, EchoEngine, MODELS, availableModels, isCached, loadWebLlm, webGpuStatus, webLlmId, type Engine, type ModelInfo } from "./llm";
import { TEMPLATES, buildMessages, pickTemplate, type Task } from "./skills";
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
}

interface Settings {
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
// "Model not loaded": the engine died with an earlier device loss.
const isGpuLoss = (msg: string): boolean => /device (was )?lost|GPUBuffer|mapAsync|DEVICE_LOST|ModelNotLoaded|not loaded/i.test(msg);

function loadSettings(): Settings {
    const defaults: Settings = { modelId: DEFAULT_MODEL, chunks: {} };
    try {
        const s = { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>) };
        if (!MODELS.some((m) => m.id === s.modelId)) s.modelId = DEFAULT_MODEL;
        return s;
    } catch {
        return defaults;
    }
}

export class Controller {
    readonly params: Params = readParams();
    readonly userId: string = this.params.get("matrix_user_id") ?? this.params.get("userId") ?? LOCAL_USER;
    readonly useEcho = this.params.get("engine") === "echo";
    /** `#/?app=<id>`: show only that app, as its own widget. */
    readonly runnerOnly: string | null = this.params.get("app");

    theme = $state<"light" | "dark">(initialTheme(this.params));
    room = $state<RoomStatus>("connecting");
    missing = $state<string[]>([]);
    settings = $state<Settings>(loadSettings());

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
    /** The draft already sent back automatically for a runtime error. */
    private autoFixed: string | null = null;

    get model(): string {
        return this.engine?.modelId ?? "";
    }

    get models(): ModelInfo[] {
        return availableModels(this.f16);
    }

    get selected(): ModelInfo | undefined {
        return this.models.find((m) => m.id === this.settings.modelId);
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
        try {
            for (const ev of await this.api.readRoomEvents(EVENT_TYPE, 100)) this.onEvent(ev);
        } catch {
            /* live events only */
        }
    }

    private onState(events: IRoomEvent[]): void {
        for (const ev of events) {
            const key = (ev as IRoomEvent & { state_key?: string }).state_key;
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
            this.draftError = message;
            // A fresh draft that fails at once goes back to the model by itself, once.
            if (this.draft && !this.busy && this.autoFixed !== this.draft.html && this.engineStatus === "ready") {
                this.autoFixed = this.draft.html;
                this.say("note", "The app failed when it started; asking the model to fix it…");
                void this.fix();
            }
        } else this.notice = `${this.apps.find((a) => a.id === appId)?.name ?? appId}: ${message}`;
    }

    private say(role: ChatEntry["role"], text: string, extra: Partial<ChatEntry> = {}): ChatEntry {
        const entry: ChatEntry = { id: this.nextEntry++, role, text, ...extra };
        this.chat = [...this.chat, entry];
        return this.chat[this.chat.length - 1];
    }

    /** A message in the build chat: a new app, or a change to the current draft. */
    async ask(request: string): Promise<void> {
        const text = request.trim();
        if (!text || this.busy) return;
        this.say("user", text);
        let task: Task;
        if (this.draft) task = { kind: "change", request: text, current: this.draft.html };
        else {
            const template = this.startFrom === "auto" ? pickTemplate(text) : (TEMPLATES.find((t) => t.id === this.startFrom) ?? pickTemplate(text));
            this.say("note", `Starting from the ${template.label.toLowerCase()} template.`);
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

    private async run(task: Task, gpuRetries = 0, repaired = false): Promise<void> {
        if (!this.engine) {
            this.busy = false;
            this.say("note", "Load a model first.", { error: true });
            return;
        }
        const depth = gpuRetries + (repaired ? 1 : 0);
        this.busy = true;
        const engine = this.engine;
        const entry = this.say("model", "", { lines: 0 });
        const update = (patch: Partial<ChatEntry>): void => {
            const i = this.chat.findIndex((e) => e.id === entry.id);
            if (i !== -1) this.chat[i] = { ...this.chat[i], ...patch };
        };
        this.abort = new AbortController();
        try {
            const messages = buildMessages(task, this.userId);
            this.lastPromptChars = messages.reduce((n, m) => n + m.content.length, 0);
            const raw = await engine.chat(messages, (soFar) => update({ text: "Writing the app…", lines: soFar.split("\n").length }), {
                signal: this.abort.signal,
                chunkChars: this.settings.chunks[engine.modelId] ?? FIRST_CHUNK,
                onRound: (i, of) => update({ text: `Reading the instructions (part ${i} of ${of})…` }),
                maxTokens: 3000,
                temperature: 0.2,
            });
            const answer = stripThinking(raw);
            const html = extractHtml(answer);
            if (!html) {
                update({ text: answer || "The model returned nothing.", lines: undefined, error: true });
                return;
            }
            const problems = checkHtml(html);
            // The sentence after the code block; nothing useful if the block never closed.
            const fences = answer.match(/```/g)?.length ?? 0;
            const after = fences >= 2 ? answer.slice(answer.lastIndexOf("```") + 3).trim() : "";
            const summary = after.slice(0, 300) || (fences === 1 ? "The answer stopped before the end of the file." : "Done.");
            update({ text: summary, lines: html.split("\n").length, problems });
            this.setDraft(html);
            // One automatic repair round for problems we can detect without running it.
            if (problems.length && !repaired) {
                this.say("note", "Asking the model to fix these problems…");
                await this.run({ kind: "fix", error: problems.join("\n"), current: html }, 0, true);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (isGpuLoss(msg) && gpuRetries < MAX_GPU_RETRIES && !this.abort?.signal.aborted) {
                update({ text: "The GPU reset; reloading the model and retrying in smaller parts…", lines: undefined });
                await this.recoverFromGpuLoss(engine);
                if (!this.engine) {
                    update({ text: "The model could not be reloaded after a GPU reset.", error: true });
                    return;
                }
                // Stays busy through the retry: run() takes over the flag.
                return await this.run(task, gpuRetries + 1, repaired);
            }
            if (isGpuLoss(msg) && !this.abort?.signal.aborted) {
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

    private setDraft(html: string): void {
        if (this.draft) this.undoStack.push({ ...this.draft });
        const name = this.draft?.appId ? this.draft.name : titleOf(html) || this.draft?.name || "New app";
        this.draft = { html, appId: this.draft?.appId ?? null, name };
        this.draftError = null;
        this.previewEvents = [];
    }

    undo(): void {
        const prev = this.undoStack.pop();
        if (!prev) return;
        this.draft = prev;
        this.draftError = null;
        this.previewEvents = [];
        this.say("note", "Went back to the previous version.");
    }

    /** Start over: forget the draft so the next message builds a new app. */
    newApp(): void {
        this.draft = null;
        this.undoStack = [];
        this.draftError = null;
        this.previewEvents = [];
        this.chat = [];
    }

    stop(): void {
        this.abort?.abort();
    }

    /** Publishes the draft as a room state event: new, or a new version of the app it came from. */
    async publish(name: string): Promise<void> {
        if (!this.draft || !this.api) return;
        const problems = checkHtml(this.draft.html).filter((p) => p.includes("limit"));
        if (problems.length) {
            this.notice = problems[0];
            return;
        }
        let id = this.draft.appId;
        if (!id) {
            const base = slug(name);
            id = base;
            for (let n = 2; this.apps.some((a) => a.id === id); n++) id = `${base}-${n}`;
        }
        const previous = this.apps.find((a) => a.id === id);
        const content = { name: name.trim() || id, description: "", html: this.draft.html, version: (previous?.version ?? 0) + 1 };
        try {
            await this.api.sendStateEvent(APP_TYPE, id, content);
        } catch (e) {
            this.notice = `Could not publish: ${e instanceof Error ? e.message : String(e)}. Publishing needs the power level for room settings.`;
            return;
        }
        // Show it now; the host's state push confirms it.
        this.onState([{ type: APP_TYPE, state_key: id, sender: this.userId, origin_server_ts: Date.now(), content, event_id: "", room_id: "", unsigned: {} } as IRoomEvent]);
        this.draft = { ...this.draft, appId: id, name: content.name };
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

    /** Loads a published app into the builder to change it. */
    edit(id: string): void {
        const app = this.apps.find((a) => a.id === id);
        if (!app) return;
        this.newApp();
        this.draft = { html: app.html, appId: app.id, name: app.name };
        this.say("note", `Editing "${app.name}" (version ${app.version}). Describe a change; publishing replaces it for everyone.`);
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
                : await loadWebLlm(
                      webLlmId(this.selected ?? this.models[0], this.f16),
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
        const entries = await Promise.all(this.models.map(async (m) => [m.id, await isCached(webLlmId(m, this.f16))] as const));
        this.cached = Object.fromEntries(entries);
    }
}
