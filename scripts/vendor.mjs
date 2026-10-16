/*
 * Copies the ONNX runtime (WebAssembly) that Transformers.js needs into
 * public/vendor/, so the widget serves it itself. The library would otherwise
 * fetch it from a public CDN, which the production CSP blocks and which would
 * tell that CDN who uses the widget. Runs before dev and build.
 */
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "public", "vendor");
// pnpm keeps transitive packages out of the top level; they sit next to their dependent.
const transformers = realpathSync(join(root, "node_modules", "@huggingface", "transformers"));
const ort = join(transformers, "..", "..", "onnxruntime-web", "dist");
if (!existsSync(ort)) throw new Error("onnxruntime-web not found next to @huggingface/transformers");

rmSync(out, { recursive: true, force: true });
// The asyncify build is the one the WebGPU backend runs on.
const files = ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];
for (const f of files) {
    mkdirSync(join(out, "ort"), { recursive: true });
    cpSync(join(ort, f), join(out, "ort", f));
}
console.log(`vendor: ${files.length} files → public/vendor`);
