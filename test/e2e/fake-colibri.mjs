// A tiny stand-in for `coli serve`: /v1/models and a streaming
// /v1/chat/completions in OpenAI's format, with colibri's empty keepalive chunks.
// It answers like the echo engine (the template from the prompt, or the
// settings with the request as title), and by the request's words:
//   "slow"  only keepalives, never an answer (for Stop);
//   "fail"  a 500 whose message reads like a GPU loss (must not trigger GPU recovery).
// `cors: false` sends no CORS headers, as colibri does for an origin it was not given.
import { createServer } from "node:http";

export const MODEL_ID = "Fake-Coder-30B";

export function startFakeColibri({ cors = true, key = "" } = {}) {
    const requests = [];
    const closed = [];
    const server = createServer(async (req, res) => {
        const origin = req.headers.origin;
        if (cors && origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        }
        if (req.method === "OPTIONS") return res.writeHead(204).end();
        let body = "";
        for await (const chunk of req) body += chunk;
        const json = body ? JSON.parse(body) : null;
        requests.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, body: json });
        if (key && req.headers.authorization !== `Bearer ${key}`)
            return send(res, 401, { error: { message: "Invalid or missing API key.", type: "authentication_error" } });
        if (req.method === "GET" && req.url === "/v1/models") return send(res, 200, { object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "colibri" }] });
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(res, 404, { error: { message: "Not found." } });

        const all = json.messages.map((m) => m.content).join("\n");
        const request = all.split("Request from ").at(-1).split("\n")[0].split(":").slice(1).join(":").trim();
        if (/\bfail\b/.test(request)) return send(res, 500, { error: { message: "device lost (from the fake server)" } });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        const chunk = (delta) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        const keepalive = () => chunk({ reasoning_content: "" });
        keepalive();
        if (/\bslow\b/.test(request)) {
            const timer = setInterval(keepalive, 200);
            res.on("close", () => {
                clearInterval(timer);
                closed.push(request);
            });
            return;
        }
        const settings = all.match(/Its settings now:\n```json\n([\s\S]*?)\n```/)?.[1];
        let text;
        if (settings) text = /\bcode\b/.test(request) ? '{"custom": true}' : "```json\n" + JSON.stringify({ ...JSON.parse(settings), title: request.slice(0, 40) }) + "\n```";
        else {
            const current = all.match(/<current-app>\n([\s\S]*?)\n<\/current-app>/)?.[1];
            const template = all.match(/<template[^>]*>\n([\s\S]*?)\n<\/template>/)?.[1] ?? "<!doctype html><html><body>empty</body></html>";
            const html = (current ?? template).replace(/<title>[^<]*<\/title>/, `<title>${request.slice(0, 40).replace(/[<&]/g, "")}</title>`);
            text = `Here is the app.\n\n\`\`\`html\n${html}\n\`\`\`\nIt is a ${request}.`;
        }
        // In a few pieces, as a model streams.
        const step = Math.ceil(text.length / 6);
        for (let i = 0; i < text.length; i += step) {
            chunk({ content: text.slice(i, i + step) });
            await new Promise((r) => setTimeout(r, 30));
        }
        res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
    });
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () =>
            resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, closed, close: () => new Promise((r) => (server.close(r), server.closeAllConnections())) }),
        ),
    );
}

function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
