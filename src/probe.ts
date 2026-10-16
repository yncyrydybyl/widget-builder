/*
 * The click-through test: every new app is used once, like a person would,
 * before anyone sees it. It runs in a hidden sandbox with its own local room
 * (sends come straight back as events), so the visible preview stays clean.
 *
 * The probe script types a unique word into each text field and submits it,
 * clicks the buttons and draws on a canvas. The builder records what each step
 * shared and which errors happened; `judgeProbe` turns that into problems the
 * model can fix ("typing into 'New item' shares nothing").
 */
import { withBridge } from "./apps";

/** What one step did, as seen from outside the sandbox and from inside. */
export interface ProbeStep {
    /** "type into 'New item'", "click 'Pizza'", "draw on the canvas" */
    label: string;
    kind: "type" | "click" | "draw";
    /** The word typed, for "type" steps. */
    token?: string;
    sent: number;
    errors: string[];
    /** Whether the typed word appeared on the page afterwards. */
    shows?: boolean;
    /** Whether the page's text changed. */
    changed: boolean;
}

export interface ProbeReport {
    /** Errors before the first step: the app fails while starting. */
    startErrors: string[];
    steps: ProbeStep[];
    /** The probe did not finish in time (an endless loop, a frozen page). */
    timedOut: boolean;
}

/** Runs in the sandbox after the bridge, before the app's code; waits for the builder's go. */
export const PROBE = `(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (m) => parent.postMessage(Object.assign({ __miniapp: true }, m), "*");
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && !el.disabled;
  const text = () => (document.body ? document.body.innerText : "");
  const name = (el) => (el.getAttribute("aria-label") || el.placeholder || el.textContent || el.id || el.tagName.toLowerCase()).trim().replace(/\\s+/g, " ").slice(0, 40);
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function press(el, key) {
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
  // A person fills the whole form, not only the text field: a date, a number, a choice.
  function fillOthers(field) {
    const scope = field.form || field.parentElement;
    if (!scope) return;
    const soon = new Date(Date.now() + 3 * 86400000);
    const iso = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString();
    const values = { date: iso.slice(0, 10), "datetime-local": iso.slice(0, 16), time: "10:30", month: iso.slice(0, 7), week: iso.slice(0, 4) + "-W40", number: "3", range: "3", email: "probe@example.org", url: "https://example.org", tel: "123", color: "#3366cc" };
    for (const el of scope.querySelectorAll("input, select, textarea")) {
      if (el === field || !visible(el) || el.value) continue;
      if (el.tagName === "SELECT") { if (el.options.length) { el.selectedIndex = Math.min(1, el.options.length - 1); el.dispatchEvent(new Event("change", { bubbles: true })); } continue; }
      const v = values[el.type] || (el.type === "text" || el.type === "" || el.tagName === "TEXTAREA" ? "Probe" : null);
      if (v !== null) setValue(el, v);
    }
  }
  // The button that goes with a field: its form's submit button, else the next button after it.
  function buttonFor(field) {
    if (field.form) return field.form.querySelector("button:not([type=button]), input[type=submit]") || field.form.querySelector("button");
    const all = [...document.querySelectorAll("button")].filter(visible);
    return all.find((b) => field.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
  }
  let sent = 0;
  async function step(label, kind, act, token) {
    post({ kind: "probe-step", label });
    const before = text(), sentBefore = sent;
    try { await act(); } catch (err) { post({ kind: "error", message: String(err && err.message || err) }); }
    await sleep(500);
    post({ kind: "probe-end", step: { label, kind, token, sent: sent - sentBefore, shows: token ? text().includes(token) : undefined, changed: text() !== before } });
  }
  addEventListener("message", async (e) => {
    if (e.source !== parent || !e.data || e.data.kind !== "probe") return;
    const send = miniapp.send.bind(miniapp);
    miniapp.send = (data) => { sent++; return send(data); };
    await sleep(300);
    const used = new Set();
    const fields = [...document.querySelectorAll("input:not([type]), input[type=text], input[type=search], textarea")].filter(visible).slice(0, 3);
    // Some apps show their text field only after a click ("Add message").
    if (!fields.length) {
      const opener = [...document.querySelectorAll("button")].filter(visible).find((b) => /add|new|write|post|neu|hinzu/i.test(b.textContent));
      if (opener) {
        await step("click '" + name(opener) + "'", "click", () => opener.click());
        used.add(opener);
        fields.push(...[...document.querySelectorAll("input:not([type]), input[type=text], textarea")].filter(visible).slice(0, 3));
      }
    }
    let n = 0;
    for (const field of fields) {
      const token = "Kiwi" + (41 + n++);
      await step("type into '" + name(field) + "'", "type", async () => {
        const s0 = sent;
        field.focus();
        setValue(field, token);
        fillOthers(field);
        // Synthetic keys do not submit a form by themselves; a real Enter would.
        press(field, "Enter");
        if (sent === s0 && field.form && typeof field.form.requestSubmit === "function") field.form.requestSubmit();
        await sleep(300);
        // Still nothing: a person would click the button next to the field.
        const b = sent === s0 ? buttonFor(field) : null;
        if (b) { used.add(b); b.click(); }
      }, token);
    }
    const buttons = [...document.querySelectorAll("button, input[type=button]")].filter((b) => visible(b) && !used.has(b)).slice(0, 6);
    for (const b of buttons) if (b.isConnected && visible(b)) await step("click '" + name(b) + "'", "click", () => b.click());
    const canvas = [...document.querySelectorAll("canvas")].find(visible);
    if (canvas) {
      await step("draw on the canvas", "draw", async () => {
        const r = canvas.getBoundingClientRect();
        const at = (fx, fy) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, pointerId: 1, buttons: 1 });
        canvas.dispatchEvent(new PointerEvent("pointerdown", at(0.2, 0.3)));
        canvas.dispatchEvent(new MouseEvent("mousedown", at(0.2, 0.3)));
        for (let i = 1; i <= 8; i++) {
          canvas.dispatchEvent(new PointerEvent("pointermove", at(0.2 + i * 0.05, 0.3 + i * 0.03)));
          canvas.dispatchEvent(new MouseEvent("mousemove", at(0.2 + i * 0.05, 0.3 + i * 0.03)));
        }
        canvas.dispatchEvent(new PointerEvent("pointerup", at(0.6, 0.54)));
        canvas.dispatchEvent(new MouseEvent("mouseup", at(0.6, 0.54)));
      });
    }
    post({ kind: "probe-done" });
  });
})();`;

/** The problems a probe found, worded for the model; empty when the app works. */
export function judgeProbe(r: ProbeReport): string[] {
    const problems: string[] = [];
    if (r.startErrors.length) problems.push(`The app fails when it starts: ${r.startErrors[0]}`);
    for (const s of r.steps) {
        if (s.errors.length) problems.push(`When a person tries to ${s.label}, the app fails: ${s.errors[0]}`);
        else if (s.kind === "type" && s.sent === 0)
            problems.push(`Typing into the field and pressing Enter or its button (${s.label}) shares nothing: miniapp.send is never called.`);
        else if (s.kind === "type" && !s.shows)
            problems.push(`After typing "${s.token}" (${s.label}) and sending it, "${s.token}" never appears on the page. Render it from the state you update inside miniapp.on.`);
        else if (s.kind === "draw" && s.sent === 0) problems.push("Drawing on the canvas shares nothing: send each finished stroke with miniapp.send.");
    }
    if (r.steps.length && !r.steps.some((s) => s.sent > 0) && !problems.some((p) => p.includes("miniapp.send")))
        problems.push("Nothing in the app calls miniapp.send, so nobody else in the room sees what a person does. Share every action with miniapp.send and update the page inside miniapp.on.");
    if (r.timedOut) problems.push("The app stops responding while it is used (an endless loop?).");
    return [...new Set(problems)].slice(0, 4);
}

/**
 * Loads the app into a hidden sandbox with a local room and runs the probe.
 * Sends come back as events from `userId` right away, as they would from a room.
 */
export function probeApp(html: string, userId: string, colors: Record<string, string>, theme: string, timeoutMs = 20_000): Promise<ProbeReport> {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    // Laid out (offscreen, not display:none) so the app's layout and visibility checks are real.
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:420px;height:640px;border:0;opacity:0;pointer-events:none";
    frame.src = new URL("sandbox.html", window.location.href).href;
    const report: ProbeReport = { startErrors: [], steps: [], timedOut: false };
    let current: string[] | null = null;
    let started = false;
    let next = 1;
    const post = (m: unknown): void => frame.contentWindow?.postMessage(m, "*");

    return new Promise<ProbeReport>((resolve) => {
        const finish = (): void => {
            clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            frame.remove();
            resolve(report);
        };
        const timer = setTimeout(() => {
            report.timedOut = true;
            finish();
        }, timeoutMs);
        function onMessage(e: MessageEvent): void {
            if (e.source !== frame.contentWindow || !e.data?.__miniapp) return;
            const m = e.data as { kind: string; data?: unknown; message?: string; label?: string; step?: ProbeStep };
            if (m.kind === "sandbox-ready") post({ __miniappLoad: withBridge(html, PROBE) });
            else if (m.kind === "hello") {
                const name = /^@([^:]+)/.exec(userId)?.[1] ?? userId;
                post({ __miniapp: true, kind: "init", info: { user: { id: userId, name }, theme, colors } });
                // Let the app render and fail at start, if it does, before using it.
                setTimeout(() => {
                    started = true;
                    post({ __miniapp: true, kind: "probe" });
                }, 400);
            } else if (m.kind === "send") {
                post({ __miniapp: true, kind: "events", events: [{ id: `probe-${next++}`, sender: userId, ts: Date.now(), data: m.data }] });
            } else if (m.kind === "error" && m.message) {
                (current ?? (started ? [] : report.startErrors)).push(m.message);
            } else if (m.kind === "probe-step") current = [];
            else if (m.kind === "probe-end" && m.step) {
                report.steps.push({ ...m.step, errors: current ?? [] });
                current = null;
            } else if (m.kind === "probe-done") finish();
        }
        window.addEventListener("message", onMessage);
        document.body.append(frame);
    });
}
