import { afterEach, describe, expect, it, vi } from "vitest";
import { ColibriEngine, baseUrl, chatRequest, isLoopback, loadColibri, serveCommand, sseData } from "./colibri";

const ORIGIN = "https://marcade.store";

/** A response body that arrives in exactly these pieces. */
function stream(...pieces: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
        start(c) {
            for (const p of pieces) c.enqueue(enc.encode(p));
            c.close();
        },
    });
}

async function all(body: ReadableStream<Uint8Array>): Promise<string[]> {
    const out: string[] = [];
    for await (const d of sseData(body)) out.push(d);
    return out;
}

const delta = (content: string | null): string => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content } }] })}\n\n`;
const keepalive = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "" } }] })}\n\n`;

afterEach(() => vi.unstubAllGlobals());

describe("server address", () => {
    it("takes the base URL with or without /v1 and a trailing slash", () => {
        expect(baseUrl("http://127.0.0.1:8000/v1/")).toBe("http://127.0.0.1:8000");
        expect(baseUrl(" http://localhost:9000/ ")).toBe("http://localhost:9000");
        expect(baseUrl("")).toBe("http://127.0.0.1:8000");
    });

    it("knows which addresses the CSP allows", () => {
        expect(isLoopback("http://127.0.0.1:8000")).toBe(true);
        expect(isLoopback("http://localhost:1234/v1")).toBe(true);
        expect(isLoopback("http://192.168.1.5:8000")).toBe(false);
        expect(isLoopback("https://127.0.0.1:8000")).toBe(false);
        expect(isLoopback("not a url")).toBe(false);
    });

    it("names the command that lets this page in, with the port when it is not the default", () => {
        expect(serveCommand("http://127.0.0.1:8000", ORIGIN)).toBe("coli serve --model <model folder> --cors-origin https://marcade.store");
        expect(serveCommand("http://localhost:8123/v1", ORIGIN)).toBe("coli serve --model <model folder> --cors-origin https://marcade.store --port 8123");
    });
});

describe("request", () => {
    it("streams the whole prompt at once, with the caller's limits", () => {
        const messages = [
            { role: "system" as const, content: "rules" },
            { role: "user" as const, content: "x".repeat(20_000) },
        ];
        expect(chatRequest("qwen3-coder", messages, { maxTokens: 3000, temperature: 0.2, chunkChars: 300 })).toEqual({
            model: "qwen3-coder",
            messages,
            stream: true,
            temperature: 0.2,
            max_tokens: 3000,
        });
    });
});

describe("sseData", () => {
    it("yields each event's data, across chunk boundaries", async () => {
        expect(await all(stream('data: {"a"', ':1}\n', '\ndata: [DONE]\n\n'))).toEqual(['{"a":1}', "[DONE]"]);
    });

    it("handles CRLF, comments, other fields, multi-line data and a last event without a blank line", async () => {
        expect(await all(stream(": keepalive\r\n\r\nevent: x\r\ndata: one\r\ndata: two\r\n\r\n", "data:three"))).toEqual(["one\ntwo", "three"]);
    });

    it("decodes UTF-8 split between chunks", async () => {
        const bytes = new TextEncoder().encode("data: Grüße\n\n");
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(bytes.slice(0, 9));
                c.enqueue(bytes.slice(9));
                c.close();
            },
        });
        expect(await all(body)).toEqual(["Grüße"]);
    });
});

describe("ColibriEngine", () => {
    it("posts the chat with the key and streams the text, counting keepalives as progress", async () => {
        const fetch = vi.fn(async () => new Response(stream(keepalive, delta("Here "), delta(null), delta("it is."), "data: [DONE]\n\n")));
        vi.stubGlobal("fetch", fetch);
        const seen: string[] = [];
        const engine = new ColibriEngine("qwen3-coder", { url: "http://127.0.0.1:8000/v1", key: "s3cret" }, ORIGIN);
        const text = await engine.chat([{ role: "user", content: "hi" }], (t) => seen.push(t), { maxTokens: 100 });
        expect(text).toBe("Here it is.");
        expect(seen).toEqual(["", "Here ", "Here ", "Here it is."]);
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
        expect(init.headers).toMatchObject({ Authorization: "Bearer s3cret", "Content-Type": "application/json" });
        expect(JSON.parse(String(init.body))).toMatchObject({ model: "qwen3-coder", stream: true, max_tokens: 100 });
        expect(engine.gpu).toBe(false);
    });

    it("explains a refused connection or CORS with the exact command", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
        const engine = new ColibriEngine("m", { url: "http://127.0.0.1:8000" }, ORIGIN);
        await expect(engine.chat([], () => {})).rejects.toThrow("Could not reach colibri at http://127.0.0.1:8000. Start it so that this page may call it: coli serve --model <model folder> --cors-origin https://marcade.store");
    });

    it("says that only this machine is allowed", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
        await expect(new ColibriEngine("m", { url: "http://10.0.0.2:8000" }, ORIGIN).chat([], () => {})).rejects.toThrow(/only a colibri server on this machine/);
    });

    it("reports the server's own error, in the stream or as a status", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(stream(delta("a"), `data: {"error":{"message":"CONTEXT_EXCEEDED"}}\n\n`))));
        await expect(new ColibriEngine("m", { url: "" }, ORIGIN).chat([], () => {})).rejects.toThrow("colibri: CONTEXT_EXCEEDED");
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Server busy." } }, { status: 503 })));
        await expect(new ColibriEngine("m", { url: "" }, ORIGIN).chat([], () => {})).rejects.toThrow("colibri answered 503: Server busy.");
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Invalid or missing API key." } }, { status: 401 })));
        await expect(new ColibriEngine("m", { url: "" }, ORIGIN).chat([], () => {})).rejects.toThrow(/wants an API key/);
    });

    it("stops when aborted, with no half answer", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_: string, init: RequestInit) => {
                const enc = new TextEncoder();
                // Like a real fetch: the body errors once the signal aborts.
                return new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(enc.encode(delta("<html>")));
                            init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
                        },
                    }),
                );
            }),
        );
        const abort = new AbortController();
        const done = new ColibriEngine("m", { url: "" }, ORIGIN).chat([], () => abort.abort(), { signal: abort.signal });
        await expect(done).rejects.toThrow("Stopped.");
    });
});

describe("loadColibri", () => {
    it("takes the model id from /v1/models", async () => {
        const fetch = vi.fn(async () => Response.json({ object: "list", data: [{ id: "Qwen3-Coder-30B-A3B", object: "model" }] }));
        vi.stubGlobal("fetch", fetch);
        const engine = await loadColibri({ url: "http://localhost:8000/v1/" }, () => {}, ORIGIN);
        expect(engine.modelId).toBe("Qwen3-Coder-30B-A3B");
        expect(fetch.mock.calls[0]).toEqual(["http://localhost:8000/v1/models", { headers: {} }]);
    });

    it("explains an unreachable server", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
        await expect(loadColibri({ url: "http://127.0.0.1:8000" }, () => {}, ORIGIN)).rejects.toThrow(/--cors-origin https:\/\/marcade.store/);
    });
});
