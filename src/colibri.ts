/*
 * colibri (github.com/JustVugg/colibri) as an optional engine. `coli serve` runs
 * large mixture-of-experts models on this machine's CPU, streaming experts from
 * disk, and offers an OpenAI-compatible API; the widget streams
 * /v1/chat/completions from it. Prompts go to that server and nowhere else: the
 * production CSP allows loopback only, so a server elsewhere is blocked.
 */
import type { ChatMessage } from "./chat";
import type { ChatOptions, Engine, Progress } from "./llm";

/** The entry in the model list, and in the stored preferences. */
export const COLIBRI = "colibri";
export const DEFAULT_COLIBRI_URL = "http://127.0.0.1:8000";

export interface ColibriServer {
    url: string;
    /** The server's COLI_API_KEY, if it has one. Kept in this browser only. */
    key?: string;
}

/** The server's base URL: people paste it with or without `/v1` and a trailing slash. */
export function baseUrl(url: string): string {
    return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "") || DEFAULT_COLIBRI_URL;
}

/** http://127.0.0.1 or http://localhost: the only servers the production CSP lets the widget reach. */
export function isLoopback(url: string): boolean {
    try {
        const u = new URL(baseUrl(url));
        return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    } catch {
        return false;
    }
}

/** The command that starts colibri so that this page may call it. */
export function serveCommand(url: string, origin: string): string {
    let port = "";
    try {
        port = new URL(baseUrl(url)).port;
    } catch {
        /* the message about the address says enough */
    }
    return `coli serve --model <model folder> --cors-origin ${origin}${port && port !== "8000" ? ` --port ${port}` : ""}`;
}

/**
 * Why a request never got an answer. A browser reports a refused connection, a
 * CORS refusal and a blocked local-network request all as the same TypeError, so
 * the message covers all three.
 */
export function unreachable(url: string, origin: string): Error {
    const at = baseUrl(url);
    if (!isLoopback(at))
        return new Error(`The widget reaches only a colibri server on this machine (http://127.0.0.1 or http://localhost); ${at} is blocked by its security policy.`);
    return new Error(
        `Could not reach colibri at ${at}. Start it so that this page may call it: ${serveCommand(at, origin)} ` +
            "If it is running with that origin, allow this page to use the local network when the browser asks.",
    );
}

/** A non-2xx answer, in words. colibri's errors are OpenAI's `{ error: { message } }`. */
export async function httpError(res: Response): Promise<Error> {
    if (res.status === 401) return new Error("colibri wants an API key (its COLI_API_KEY): enter it next to the server address.");
    let detail = "";
    try {
        const body = (await res.json()) as { error?: { message?: string } | string };
        detail = typeof body.error === "string" ? body.error : (body.error?.message ?? "");
    } catch {
        /* not JSON */
    }
    return new Error(`colibri answered ${res.status}${detail ? `: ${detail}` : ` ${res.statusText}`}`.trim());
}

function headers(server: ColibriServer, json: boolean): Record<string, string> {
    const h: Record<string, string> = json ? { "Content-Type": "application/json" } : {};
    if (server.key?.trim()) h.Authorization = `Bearer ${server.key.trim()}`;
    return h;
}

/**
 * The request body. No prompt rounds: a server has no GPU prefill limit, so the
 * whole prompt goes at once.
 */
export function chatRequest(model: string, messages: ChatMessage[], opts: ChatOptions = {}): Record<string, unknown> {
    return { model, messages, stream: true, temperature: opts.temperature ?? 0.6, max_tokens: opts.maxTokens ?? 768 };
}

/** The `data:` payloads of a server-sent event stream, one per event; comments and other fields are skipped. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let rest = "";
    let data: string[] = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const lines = (rest + decoder.decode(value, { stream: true })).split(/\r?\n/);
            rest = lines.pop() ?? "";
            for (const line of lines) {
                if (line === "") {
                    if (data.length) yield data.join("\n");
                    data = [];
                } else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
            }
        }
        if (rest.startsWith("data:")) data.push(rest.slice(rest.startsWith("data: ") ? 6 : 5));
        if (data.length) yield data.join("\n");
    } finally {
        reader.releaseLock();
    }
}

interface Chunk {
    choices?: { delta?: { content?: string | null } }[];
    error?: { message?: string } | string;
}

export class ColibriEngine implements Engine {
    readonly gpu = false;

    constructor(
        readonly modelId: string,
        private readonly server: ColibriServer,
        private readonly origin: string = location.origin,
    ) {}

    async chat(messages: ChatMessage[], onText: (soFar: string) => void, opts: ChatOptions = {}): Promise<string> {
        // Stop ends the build: no half answer goes on to the checks and fix rounds.
        const stopped = (): Error => new Error("Stopped.");
        let res: Response;
        try {
            res = await fetch(`${baseUrl(this.server.url)}/v1/chat/completions`, {
                method: "POST",
                headers: headers(this.server, true),
                body: JSON.stringify(chatRequest(this.modelId, messages, opts)),
                signal: opts.signal,
            });
        } catch {
            if (opts.signal?.aborted) throw stopped();
            throw unreachable(this.server.url, this.origin);
        }
        if (!res.ok || !res.body) throw await httpError(res);
        let text = "";
        try {
            for await (const data of sseData(res.body)) {
                if (data === "[DONE]") break;
                const chunk = JSON.parse(data) as Chunk;
                if (chunk.error) throw new Error(`colibri: ${typeof chunk.error === "string" ? chunk.error : chunk.error.message}`);
                text += chunk.choices?.[0]?.delta?.content ?? "";
                // Also for colibri's empty keepalives during a long prefill: the
                // stall watchdog counts every call as progress.
                onText(text);
            }
        } catch (e) {
            if (opts.signal?.aborted) throw stopped();
            if (e instanceof SyntaxError) throw new Error(`colibri sent something that is not JSON: ${e.message}`);
            if (e instanceof TypeError) throw new Error(`The connection to colibri broke off: ${e.message}`);
            throw e;
        }
        return text;
    }

    async unload(): Promise<void> {}
}

/** Asks the server which model it serves; that is the engine. */
export async function loadColibri(server: ColibriServer, onProgress: (p: Progress) => void, origin: string = location.origin): Promise<Engine> {
    const url = baseUrl(server.url);
    onProgress({ fraction: 0, text: `Asking colibri at ${url} for its model…` });
    let res: Response;
    try {
        res = await fetch(`${url}/v1/models`, { headers: headers(server, false) });
    } catch {
        throw unreachable(url, origin);
    }
    if (!res.ok) throw await httpError(res);
    const id = ((await res.json()) as { data?: { id?: string }[] }).data?.[0]?.id;
    if (!id) throw new Error(`colibri at ${url} serves no model.`);
    onProgress({ fraction: 1, text: id });
    return new ColibriEngine(id, { ...server, url }, origin);
}
