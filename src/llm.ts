/*
 * The model behind one small interface. `WebLlmEngine` runs a WebLLM model on the
 * local GPU in a worker; `TransformersEngine` runs an ONNX model through
 * Transformers.js (for models WebLLM has no build of); `EchoEngine` (fragment `engine=echo`) needs no GPU and
 * exists for the mock-host tests and for trying the room plumbing quickly.
 */
import { isAck, prefillRounds, type ChatMessage } from "./chat";

export interface ModelInfo {
    /** WebLLM model id without the quantisation suffix, or our own id for a Transformers.js model. */
    id: string;
    label: string;
    /** Approximate download/VRAM in MB per quantisation, from WebLLM's prebuilt config. */
    f16MB: number;
    /** The f32 build, for GPUs without the shader-f16 extension; absent when WebLLM has none. */
    f32MB?: number;
    /** Set for a Transformers.js model: the Hugging Face repo and the ONNX dtype per GPU kind. */
    onnx?: { repo: string; f16: string; f32: string };
}

/** A curated subset of WebLLM's prebuilt models that fit an ordinary laptop GPU. */
export const MODELS: ModelInfo[] = [
    { id: "Qwen2.5-Coder-1.5B-Instruct", label: "Qwen 2.5 Coder 1.5B (runs on integrated GPUs)", f16MB: 1630, f32MB: 1889 },
    { id: "Qwen2.5-Coder-3B-Instruct", label: "Qwen 2.5 Coder 3B (needs a dedicated GPU)", f16MB: 2505, f32MB: 2894 },
    { id: "Qwen3.5-4B", label: "Qwen 3.5 4B (needs a dedicated GPU)", f16MB: 3868, f32MB: 4680 },
    { id: "Qwen2.5-Coder-7B-Instruct", label: "Qwen 2.5 Coder 7B (best, needs a big GPU)", f16MB: 5107, f32MB: 5900 },
    /*
     * Mixture of experts: 8.3B parameters, 1.5B active per token, so it runs at
     * about the speed of a 1.5B model but must keep all weights in memory. Liquid
     * does not recommend it for programming; it is here to be measured
     * (test/real/bench.mjs). LFM Open License, not OSI.
     */
    {
        id: "LFM2-8B-A1B",
        label: "LFM2 8B-A1B, mixture of experts (experimental)",
        f16MB: 4790,
        f32MB: 5330,
        onnx: { repo: "onnx-community/LFM2-8B-A1B-ONNX", f16: "q4f16", f32: "q4" },
    },
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

/** The id the loaded engine reports: WebLLM's full id, or ours for a Transformers.js model. */
export function engineId(m: ModelInfo, f16: boolean): string {
    return m.onnx ? `${m.id}-${f16 ? m.onnx.f16 : m.onnx.f32}` : webLlmId(m, f16);
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
    /** Tokens processed, summed over all rounds; called once the answer is complete. */
    onUsage?: (u: Usage) => void;
}

export interface Usage {
    promptTokens: number;
    completionTokens: number;
}

export interface Engine {
    readonly modelId: string;
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
        return { problem: null, f16: adapter.features.has("shader-f16") };
    } catch (e) {
        return { problem: `WebGPU failed: ${String(e)}`, f16: false };
    }
}

export async function isCached(m: ModelInfo, f16: boolean): Promise<boolean> {
    try {
        if (m.onnx) {
            // Transformers.js keeps downloads in this Cache Storage bucket, one entry per file.
            const file = `${m.onnx.repo}/resolve/main/onnx/model_${f16 ? m.onnx.f16 : m.onnx.f32}.onnx_data`;
            const keys = await (await caches.open("transformers-cache")).keys();
            return keys.some((k) => k.url.includes(file));
        }
        const webllm = await import("@mlc-ai/web-llm");
        return await webllm.hasModelInCache(webLlmId(m, f16));
    } catch {
        return false;
    }
}

export function loadModel(m: ModelInfo, f16: boolean, onProgress: (p: Progress) => void, contextWindow?: number): Promise<Engine> {
    return m.onnx ? loadTransformers(m, f16, onProgress) : loadWebLlm(webLlmId(m, f16), onProgress, contextWindow);
}

class WebLlmEngine implements Engine {
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
        const usage: Usage = { promptTokens: 0, completionTokens: 0 };
        const count = (u?: { prompt_tokens?: number; completion_tokens?: number } | null): void => {
            usage.promptTokens += u?.prompt_tokens ?? 0;
            usage.completionTokens += u?.completion_tokens ?? 0;
        };
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
                count(r.usage);
                if (opts.signal?.aborted) return "";
                history.push({ role: "assistant", content: r.choices[0]?.message.content ?? "" });
            }
            if (rounds.length > 1) opts.onRound?.(rounds.length, rounds.length);
            const answer = async (): Promise<string> => {
                const stream = await this.engine.chat.completions.create({
                    messages: history,
                    stream: true,
                    stream_options: { include_usage: true },
                    temperature: opts.temperature ?? 0.6,
                    max_tokens: opts.maxTokens ?? 768,
                    extra_body,
                });
                let text = "";
                for await (const chunk of stream) {
                    text += chunk.choices[0]?.delta?.content ?? "";
                    if (chunk.usage) count(chunk.usage);
                    else onText(text);
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
            opts.onUsage?.(usage);
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

export async function loadWebLlm(modelId: string, onProgress: (p: Progress) => void, contextWindow = CONTEXT_WINDOW): Promise<Engine> {
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

import type { TfRequest, TfResponse } from "./tf.worker";

/**
 * A Transformers.js model in its own worker. No prompt rounds: ONNX Runtime has
 * no kept KV cache between calls here, so the prompt is processed in one pass
 * (on an integrated GPU that needs a raised driver timeout, see README).
 */
class TransformersEngine implements Engine {
    private lost: string | null = null;
    private listener: ((m: TfResponse) => void) | null = null;

    constructor(
        readonly modelId: string,
        private worker: Worker,
    ) {
        worker.onmessage = (e: MessageEvent<TfResponse>) => {
            if (e.data.op === "error" && /device lost/i.test(e.data.message)) this.lost = e.data.message;
            this.listener?.(e.data);
        };
    }

    private send(req: TfRequest): void {
        this.worker.postMessage(req);
    }

    async chat(messages: ChatMessage[], onText: (soFar: string) => void, opts: ChatOptions = {}): Promise<string> {
        if (this.lost) throw new Error(this.lost);
        const abort = (): void => this.send({ op: "stop" });
        opts.signal?.addEventListener("abort", abort);
        try {
            return await new Promise<string>((resolve, reject) => {
                let text = "";
                this.listener = (m) => {
                    if (m.op === "text") onText((text += m.text));
                    else if (m.op === "done") {
                        opts.onUsage?.({ promptTokens: m.promptTokens, completionTokens: m.completionTokens });
                        resolve(text);
                    } else if (m.op === "error") reject(new Error(m.message));
                };
                this.send({ op: "chat", messages, maxTokens: opts.maxTokens ?? 768 });
            });
        } finally {
            this.listener = null;
            opts.signal?.removeEventListener("abort", abort);
        }
    }

    async unload(): Promise<void> {
        this.worker.terminate();
    }
}

async function loadTransformers(m: ModelInfo, f16: boolean, onProgress: (p: Progress) => void): Promise<Engine> {
    const worker = new Worker(new URL("./tf.worker.ts", import.meta.url), { type: "module" });
    try {
        await new Promise<void>((resolve, reject) => {
            worker.onmessage = (e: MessageEvent<TfResponse>) => {
                const r = e.data;
                if (r.op === "progress" && r.total > 0)
                    onProgress({ fraction: r.loaded / r.total, text: `${(r.loaded / 1e9).toFixed(2)} of ${(r.total / 1e9).toFixed(2)} GB` });
                else if (r.op === "ready") resolve();
                else if (r.op === "error") reject(new Error(r.message));
            };
            const vendor = new URL("vendor/", window.location.href).href;
            worker.postMessage({ op: "load", repo: m.onnx!.repo, dtype: f16 ? m.onnx!.f16 : m.onnx!.f32, vendor } satisfies TfRequest);
        });
    } catch (e) {
        worker.terminate();
        throw e;
    }
    // Takes over the worker's messages from here on.
    return new TransformersEngine(engineId(m, f16), worker);
}

/** Answers with the template from the prompt, renamed. Deterministic, instant, no GPU. */
export class EchoEngine implements Engine {
    readonly modelId = "echo";

    async chat(messages: ChatMessage[], onText: (soFar: string) => void, opts: ChatOptions = {}): Promise<string> {
        const all = messages.map((m) => m.content).join("\n");
        const current = all.match(/<current-app>\n([\s\S]*?)\n<\/current-app>/)?.[1];
        const template = all.match(/<template[^>]*>\n([\s\S]*?)\n<\/template>/)?.[1] ?? "<!doctype html><html><body>empty</body></html>";
        const request = messages.at(-1)?.content.split("Request from ").at(-1)?.split(":").slice(1).join(":").trim() ?? "";
        const html = (current ?? template).replace(/<title>[^<]*<\/title>/, `<title>${request.slice(0, 40).replace(/[<&]/g, "")}</title>`);
        const text = `Here is the app.\n\n\`\`\`html\n${html}\n\`\`\``;
        onText(text);
        opts.onUsage?.({ promptTokens: all.length >> 2, completionTokens: text.length >> 2 });
        return text;
    }

    async unload(): Promise<void> {}
}
