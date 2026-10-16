import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteRemovedModels, isRemovedModelFile } from "./llm";

const LFM2 = "https://huggingface.co/onnx-community/LFM2-8B-A1B-ONNX/resolve/main/onnx/model_q4f16.onnx_data";
const WHISPER = "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_q4.onnx";

describe("isRemovedModelFile", () => {
    it("matches LFM2-8B-A1B's files, wherever they were fetched from", () => {
        expect(isRemovedModelFile(LFM2)).toBe(true);
        expect(isRemovedModelFile("https://huggingface.co/onnx-community/LFM2-8B-A1B-ONNX/resolve/main/config.json")).toBe(true);
        expect(isRemovedModelFile("https://cas-bridge.xethub.hf.co/x/onnx-community/LFM2-8B-A1B-ONNX/resolve/main/tokenizer.json")).toBe(true);
    });

    it("leaves other models alone, Room LLM's and similar names included", () => {
        expect(isRemovedModelFile(WHISPER)).toBe(false);
        expect(isRemovedModelFile("https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_quantized.onnx")).toBe(false);
        expect(isRemovedModelFile("https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/vision_encoder_fp16.onnx")).toBe(false);
        expect(isRemovedModelFile("https://huggingface.co/onnx-community/LFM2-1.2B-ONNX/resolve/main/onnx/model_q4.onnx")).toBe(false);
        expect(isRemovedModelFile("https://huggingface.co/onnx-community/LFM2-8B-A1B-ONNX-v2/resolve/main/onnx/model_q4.onnx")).toBe(false);
        expect(isRemovedModelFile("https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC/resolve/main/params_shard_0.bin")).toBe(false);
    });
});

/** A Cache Storage stand-in: bucket name → URL → Content-Length. */
function fakeCaches(buckets: Record<string, Record<string, number>>) {
    return {
        keys: async () => Object.keys(buckets),
        open: async (name: string) => ({
            keys: async () => Object.keys(buckets[name]).map((url) => ({ url })),
            match: async (req: { url: string }) => new Response(null, { headers: { "content-length": String(buckets[name][req.url]) } }),
            delete: async (req: { url: string }) => delete buckets[name][req.url],
        }),
    };
}

function fakeStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("deleteRemovedModels", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("deletes only LFM2's entries, in every bucket, once", async () => {
        const buckets = { "transformers-cache": { [LFM2]: 4_800_000_000, [WHISPER]: 80_000_000 }, "webllm/model": {} };
        vi.stubGlobal("caches", fakeCaches(buckets));
        vi.stubGlobal("localStorage", fakeStorage());
        expect(await deleteRemovedModels()).toEqual({ files: 1, bytes: 4_800_000_000 });
        expect(Object.keys(buckets["transformers-cache"])).toEqual([WHISPER]);
        // The second start does not even look.
        vi.stubGlobal("caches", undefined);
        expect(await deleteRemovedModels()).toEqual({ files: 0, bytes: 0 });
    });

    it("does not fail without Cache Storage or localStorage", async () => {
        vi.stubGlobal("caches", undefined);
        vi.stubGlobal("localStorage", {
            getItem: () => {
                throw new Error("denied");
            },
        });
        expect(await deleteRemovedModels()).toEqual({ files: 0, bytes: 0 });
        vi.stubGlobal("caches", { keys: () => Promise.reject(new Error("SecurityError")) });
        expect(await deleteRemovedModels()).toEqual({ files: 0, bytes: 0 });
    });
});
