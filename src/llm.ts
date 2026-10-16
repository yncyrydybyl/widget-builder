/*
 * The model behind one small interface. `WebLlmEngine` runs a WebLLM model on the
 * local GPU in a worker; `ColibriEngine` (colibri.ts) asks a colibri server on this
 * machine; `EchoEngine` (fragment `engine=echo`) needs no GPU and exists for the
 * mock-host tests and for trying the room plumbing quickly.
 */
import { isAck, prefillRounds, type ChatMessage } from "./chat";

export interface ModelInfo {
    /** WebLLM model id without the quantisation suffix. */
    id: string;
    label: string;
    /** Which GPU it needs, shown next to the name. */
    needs: string;
    /** Approximate download/VRAM in MB per quantisation, from WebLLM's prebuilt config. */
    f16MB: number;
    /** The f32 build, for GPUs without the shader-f16 extension; absent when WebLLM has none. */
    f32MB?: number;
}

/** A curated subset of WebLLM's prebuilt models that fit an ordinary laptop GPU. */
export const MODELS: ModelInfo[] = [
    { id: "Qwen2.5-Coder-1.5B-Instruct", label: "Qwen 2.5 Coder 1.5B", needs: "any GPU", f16MB: 1630, f32MB: 1889 },
    { id: "Qwen2.5-Coder-3B-Instruct", label: "Qwen 2.5 Coder 3B", needs: "dedicated GPU", f16MB: 2505, f32MB: 2894 },
    { id: "Qwen3.5-4B", label: "Qwen 3.5 4B", needs: "dedicated GPU", f16MB: 3868, f32MB: 4680 },
    { id: "Qwen2.5-Coder-7B-Instruct", label: "Qwen 2.5 Coder 7B", needs: "big GPU", f16MB: 5107, f32MB: 5900 },
];

// 3B and up lost the device on a Radeon 860M (integrated) at any prompt part size.
export const DEFAULT_MODEL = "Qwen2.5-Coder-1.5B-Instruct";

/*
 * A generated app plus the reference material does not fit the prebuilt 4k
 * window: the prompt is ~2k tokens, the answer up to 3k. 8k is enough; 16k made a
 * Radeon 860M (shared memory) lose the device on the first prefill. `#/?ctx=`
 * overrides it for experiments.
 */
const CONTEXT_WINDOW = 8_192;

/** Models usable on this GPU: without shader-f16 only those with an f32 build. */
export function availableModels(f16: boolean): ModelInfo[] {
    return f16 ? MODELS : MODELS.filter((m) => m.f32MB !== undefined);
}

export function webLlmId(m: ModelInfo, f16: boolean): string {
    return `${m.id}-${f16 ? "q4f16_1" : "q4f32_1"}-MLC`;
}

export function sizeMB(m: ModelInfo, f16: boolean): number {
    return f16 ? m.f16MB : (m.f32MB ?? m.f16MB);
}

export interface Progress {
    fraction: number;
    text: string;
}

export interface ChatOptions {
    signal?: AbortSignal;
    /** Largest prompt part processed in one pass; longer prompts go in rounds. */
    chunkChars?: number;
    /** Called before each round of a multi-round prompt. */
    onRound?: (round: number, of: number) => void;
    /** Longest answer in tokens (default 768). */
    maxTokens?: number;
    temperature?: number;
}

export interface Engine {
    readonly modelId: string;
    /** Runs on this browser's GPU: a lost device is recovered by reloading in smaller prompt parts. */
    readonly gpu: boolean;
    chat(messages: ChatMessage[], onText: (soFar: string) => void, opts?: ChatOptions): Promise<string>;
    unload(): Promise<void>;
}

export interface GpuStatus {
    problem: string | null;
    /** shader-f16: the smaller, faster q4f16 builds need it. */
    f16: boolean;
}

export async function webGpuStatus(): Promise<GpuStatus> {
    if (!("gpu" in navigator) || !navigator.gpu)
        return { problem: "This browser has no WebGPU (try a current Chrome, Edge or Firefox).", f16: false };
    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            const linux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
            return {
                problem:
                    "WebGPU is present but no GPU adapter is available." +
                    (linux
                        ? " On Linux, Chrome needs --enable-unsafe-webgpu --enable-features=Vulkan (check chrome://gpu)."
                        : " Check that hardware acceleration is on (chrome://gpu)."),
                f16: false,
            };
        }
        // A software adapter (SwiftShader) loads a model in minutes and then never
        // finishes an answer; seen in headless Chrome on a Radeon 860M.
        const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
        if (info.isFallbackAdapter || /swiftshader/i.test(`${info.vendor} ${info.architecture} ${info.description}`))
            return {
                problem: "WebGPU runs in software (SwiftShader) here, not on the GPU, so a model would never finish an answer. Turn on hardware acceleration (check chrome://gpu).",
                f16: false,
            };
        return { problem: null, f16: adapter.features.has("shader-f16") };
    } catch (e) {
        return { problem: `WebGPU failed: ${String(e)}`, f16: false };
    }
}

export async function isCached(m: ModelInfo, f16: boolean): Promise<boolean> {
    try {
        const webllm = await import("@mlc-ai/web-llm");
        return await webllm.hasModelInCache(webLlmId(m, f16));
    } catch {
        return false;
    }
}

/*
 * LFM2-8B-A1B ran through Transformers.js until 0.3.0 and left ~5 GB in Cache
 * Storage that nothing uses now. Only its own entries go, never a whole bucket:
 * every widget on marcade.store shares this origin, and Room LLM keeps its
 * Transformers.js models in the same `transformers-cache`.
 */
const REMOVED_MODELS = ["onnx-community/LFM2-8B-A1B-ONNX"];
const REMOVED_KEY = "widget-builder.removed-models-deleted";

export const isRemovedModelFile = (url: string): boolean => REMOVED_MODELS.some((m) => url.includes(`/${m}/`));

export interface Freed {
    files: number;
    /** From Content-Length; 0 when the cached responses do not say. */
    bytes: number;
}

/** Deletes the removed models' files from every bucket, once per browser. */
export async function deleteRemovedModels(): Promise<Freed> {
    const freed: Freed = { files: 0, bytes: 0 };
    try {
        if (localStorage.getItem(REMOVED_KEY)) return freed;
    } catch {
        /* no storage: look on each start, it only lists keys */
    }
    if (typeof caches === "undefined") return freed; // not a secure context
    try {
        for (const name of await caches.keys()) {
            const cache = await caches.open(name);
            for (const req of await cache.keys()) {
                if (!isRemovedModelFile(req.url)) continue;
                freed.bytes += Number((await cache.match(req))?.headers.get("content-length")) || 0;
                if (await cache.delete(req)) freed.files++;
            }
        }
    } catch {
        return freed; // look again on the next start
    }
    try {
        localStorage.setItem(REMOVED_KEY, "1");
    } catch {
        /* private window */
    }
    return freed;
}

export function loadModel(m: ModelInfo, f16: boolean, onProgress: (p: Progress) => void, contextWindow = CONTEXT_WINDOW): Promise<Engine> {
    return loadWebLlm(webLlmId(m, f16), onProgress, contextWindow);
}

class WebLlmEngine implements Engine {
    readonly gpu = true;

    constructor(
        readonly modelId: string,
        private engine: import("@mlc-ai/web-llm").WebWorkerMLCEngine,
        private worker: Worker,
    ) {}

    async chat(messages: ChatMessage[], onText: (soFar: string) => void, opts: ChatOptions = {}): Promise<string> {
        // Qwen3 would otherwise think at length before every answer, acknowledgements included.
        const extra_body = /^Qwen3/.test(this.modelId) ? { enable_thinking: false } : undefined;
        const { head, rounds } = prefillRounds(messages, opts.chunkChars ?? Infinity);
        const history: ChatMessage[] = [...head];
        const abort = (): void => this.engine.interruptGenerate();
        opts.signal?.addEventListener("abort", abort);
        try {
            // Every round but the last only fills the KV cache. The acknowledgement
            // must end on its own (finish_reason "stop"): a reply cut by max_tokens
            // makes WebLLM discard the cache and prefill everything again.
            for (let i = 0; i < rounds.length - 1; i++) {
                opts.onRound?.(i + 1, rounds.length);
                history.push({ role: "user", content: rounds[i] });
                const r = await this.engine.chat.completions.create({
                    messages: history,
                    temperature: 0,
                    max_tokens: 16,
                    extra_body,
                });
                if (opts.signal?.aborted) return "";
                history.push({ role: "assistant", content: r.choices[0]?.message.content ?? "" });
            }
            if (rounds.length > 1) opts.onRound?.(rounds.length, rounds.length);
            const answer = async (): Promise<string> => {
                const stream = await this.engine.chat.completions.create({
                    messages: history,
                    stream: true,
                    temperature: opts.temperature ?? 0.6,
                    max_tokens: opts.maxTokens ?? 768,
                    extra_body,
                });
                let text = "";
                for await (const chunk of stream) {
                    text += chunk.choices[0]?.delta?.content ?? "";
                    onText(text);
                }
                return text;
            };
            history.push({ role: "user", content: rounds[rounds.length - 1] ?? "" });
            let text = await answer();
            // After many "reply only with OK" rounds a small model may say OK once
            // more instead of answering. Ask once more, plainly.
            if (rounds.length > 1 && isAck(text) && !opts.signal?.aborted) {
                history.push({ role: "assistant", content: text });
                history.push({ role: "user", content: "Do not reply OK. The material is complete. Write your full answer to the request now." });
                text = await answer();
            }
            return text;
        } finally {
            opts.signal?.removeEventListener("abort", abort);
        }
    }

    async unload(): Promise<void> {
        // After a lost device the engine may never answer; do not wait for it forever.
        await Promise.race([this.engine.unload().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
        this.worker.terminate();
    }
}

async function loadWebLlm(modelId: string, onProgress: (p: Progress) => void, contextWindow: number): Promise<Engine> {
    const webllm = await import("@mlc-ai/web-llm");
    const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
    try {
        const engine = await webllm.CreateWebWorkerMLCEngine(
            worker,
            modelId,
            { initProgressCallback: (r) => onProgress({ fraction: r.progress, text: r.text }) },
            { context_window_size: contextWindow },
        );
        return new WebLlmEngine(modelId, engine, worker);
    } catch (e) {
        worker.terminate();
        throw e;
    }
}

/** Answers with the template from the prompt, renamed. Deterministic, instant, no GPU. */
export class EchoEngine implements Engine {
    readonly modelId = "echo";
    readonly gpu = false;

    async chat(messages: ChatMessage[], onText: (soFar: string) => void): Promise<string> {
        const all = messages.map((m) => m.content).join("\n");
        // Settings-only mode: the request becomes the title; "code" in it asks for code instead.
        const settings = all.match(/Its settings now:\n```json\n([\s\S]*?)\n```/)?.[1];
        if (settings) {
            const asked = all.split("Request from ").at(-1)!.split("\n")[0].split(":").slice(1).join(":").trim();
            const text = /\bcode\b/i.test(asked) ? '{"custom": true}' : "```json\n" + JSON.stringify({ ...JSON.parse(settings), title: asked.slice(0, 40) }) + "\n```";
            onText(text);
            return text;
        }
        const current = all.match(/<current-app>\n([\s\S]*?)\n<\/current-app>/)?.[1];
        const template = all.match(/<template[^>]*>\n([\s\S]*?)\n<\/template>/)?.[1] ?? "<!doctype html><html><body>empty</body></html>";
        const request = messages.at(-1)?.content.split("Request from ").at(-1)?.split(":").slice(1).join(":").trim() ?? "";
        const html = (current ?? template).replace(/<title>[^<]*<\/title>/, `<title>${request.slice(0, 40).replace(/[<&]/g, "")}</title>`);
        const text = `Here is the app.\n\n\`\`\`html\n${html}\n\`\`\``;
        onText(text);
        return text;
    }

    async unload(): Promise<void> {}
}
