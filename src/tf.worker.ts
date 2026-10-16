/*
 * Runs a Transformers.js text-generation model (ONNX on WebGPU) off the main
 * thread, for models WebLLM has no build of, such as LFM2-8B-A1B. The protocol
 * is small on purpose: load once, then chat requests that stream text back.
 */
import { InterruptableStoppingCriteria, TextStreamer, env, pipeline, type TextGenerationPipeline } from "@huggingface/transformers";

export type TfRequest =
    | { op: "load"; repo: string; dtype: string; vendor: string }
    | { op: "chat"; messages: { role: string; content: string }[]; maxTokens: number }
    | { op: "stop" };

export type TfResponse =
    | { op: "progress"; loaded: number; total: number }
    | { op: "ready" }
    | { op: "text"; text: string }
    | { op: "done"; promptTokens: number; completionTokens: number }
    | { op: "error"; message: string };

const post = (m: TfResponse): void => postMessage(m);

// ONNX Runtime creates its own WebGPU device; report how it was lost, so the
// builder can recover the same way it does for WebLLM.
const requestDevice = GPUAdapter.prototype.requestDevice;
GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, desc?: GPUDeviceDescriptor) {
    const device = await requestDevice.call(this, desc);
    void device.lost.then((info) => {
        if (info.reason !== "destroyed") post({ op: "error", message: `WebGPU device lost (${info.reason}): ${info.message}` });
    });
    return device;
};

let generator: TextGenerationPipeline | null = null;
const stopping = new InterruptableStoppingCriteria();

async function load(req: Extract<TfRequest, { op: "load" }>): Promise<void> {
    // Served by the widget itself (scripts/vendor.mjs), never from a CDN. No wasm
    // cache: it loads the runtime through a blob: URL, which the CSP forbids.
    env.useWasmCache = false;
    env.allowLocalModels = false;
    env.backends.onnx.wasm!.wasmPaths = {
        mjs: `${req.vendor}ort/ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: `${req.vendor}ort/ort-wasm-simd-threaded.asyncify.wasm`,
    };
    generator = (await pipeline("text-generation", req.repo, {
        dtype: req.dtype as "q4f16",
        device: "webgpu",
        progress_callback: (p: { status?: string; loaded?: number; total?: number }) => {
            if (p.status === "progress_total") post({ op: "progress", loaded: p.loaded ?? 0, total: p.total ?? 0 });
        },
    })) as TextGenerationPipeline;
    post({ op: "ready" });
}

async function chat(req: Extract<TfRequest, { op: "chat" }>): Promise<void> {
    if (!generator) throw new Error("Model not loaded");
    stopping.reset();
    let completionTokens = 0;
    const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => text && post({ op: "text", text }),
        token_callback_function: () => void completionTokens++,
    });
    const prompt = generator.tokenizer.apply_chat_template(req.messages, { add_generation_prompt: true, tokenize: true, return_tensor: false, return_dict: false }) as unknown as number[];
    // Greedy, as Liquid's own WebGPU demo does: steadier code than sampling.
    await generator(req.messages, { max_new_tokens: req.maxTokens, do_sample: false, streamer, stopping_criteria: stopping });
    post({ op: "done", promptTokens: prompt.length, completionTokens });
}

self.onmessage = async (e: MessageEvent<TfRequest>) => {
    const req = e.data;
    if (req.op === "stop") return stopping.interrupt();
    try {
        await (req.op === "load" ? load(req) : chat(req));
    } catch (err) {
        post({ op: "error", message: err instanceof Error ? err.message : String(err) });
    }
};
