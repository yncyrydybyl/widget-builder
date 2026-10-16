/*
 * Chat plumbing shared with llm-widget: message type, reasoning removal, and
 * reading a long prompt in rounds so no single GPU prefill pass gets too big.
 */

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/** Reasoning models (Qwen3) wrap their scratchpad in <think>; it does not belong in the room. */
export function stripThinking(text: string): string {
    return text
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<think>[\s\S]*$/, "")
        .trim();
}

/** Splits text into pieces of at most `max` characters, preferring line and word breaks. */
export function splitText(text: string, max: number): string[] {
    const parts: string[] = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf("\n", max);
        if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
        if (cut < max * 0.5) cut = max;
        parts.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest) parts.push(rest);
    return parts;
}

export const ACK = "OK";

/**
 * Turns one long prompt into rounds, so that no single prefill pass exceeds
 * `chunkChars`. Every round but the last carries one part and asks for a bare
 * "OK"; the engine keeps its KV cache across rounds, so each round processes only
 * its own part. Returns the user messages in order; the caller interleaves the
 * model's acknowledgements.
 */
export function prefillRounds(messages: ChatMessage[], chunkChars: number): { head: ChatMessage[]; rounds: string[] } {
    const last = messages[messages.length - 1];
    const head = messages.slice(0, -1);
    if (!last || last.role !== "user" || last.content.length <= chunkChars) return { head, rounds: last ? [last.content] : [] };
    // The request goes last and on its own: after a run of "reply only with OK"
    // turns a small model will happily answer "OK" again if the request is buried
    // in the last part.
    const at = last.content.lastIndexOf("\n\nRequest from ");
    let material = at === -1 ? last.content : last.content.slice(0, at);
    let request = at === -1 ? "" : last.content.slice(at + 2);
    // A pasted article is the request itself; then it is material too, read in
    // parts, and the last round only points at it.
    if (request.length > chunkChars / 2) {
        material = `${material}\n\n${request}`;
        request = 'The request is at the end of the material, starting with "Request from". Carry it out now.';
    }
    // Leave room for the framing text around each part.
    const parts = splitText(material, Math.max(100, chunkChars - 120));
    const k = parts.length;
    const rounds = parts.map(
        (part, i) => `Part ${i + 1} of ${k} of the material. Do not answer yet; reply only with "${ACK}".\n\n${part}`,
    );
    rounds.push(
        `That was all ${k} parts of the material. Now stop acknowledging and answer properly, using all of it.\n\n` +
            (request || "Summarise the material."),
    );
    return { head, rounds };
}
