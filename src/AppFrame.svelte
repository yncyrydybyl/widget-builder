<script lang="ts">
    /*
     * Runs one app: an iframe on sandbox.html (sandbox="allow-scripts allow-forms",
     * so an opaque origin with no network), which receives the app's HTML with the
     * bridge in front. allow-forms only lets the submit event fire: without it the
     * browser drops a submit before any handler sees it, and apps that add items
     * through a <form> do nothing. sandbox.html's CSP (form-action 'none') still
     * blocks a form from navigating anywhere. Relays the app's actions to the controller and the
     * room's actions back in. Remount (with {#key}) to load different HTML.
     */
    import { onDestroy } from "svelte";
    import { withBridge, type AppEvent } from "./apps";
    import type { Controller } from "./controller.svelte";

    let {
        c,
        html,
        appId,
        events,
        title,
        fit = true,
    }: { c: Controller; html: string; appId: string | null; events: AppEvent[]; title: string; /** Grow with the app's page. */ fit?: boolean } =
        $props();

    let frame = $state<HTMLIFrameElement>();
    /** The app's page height, as its bridge reports it; capped so a runaway layout cannot grow forever. */
    let height = $state(0);
    let connected = $state(false);
    /** Event ids already in the app; events can be sorted into the middle of the list. */
    let delivered = new Set<string>();
    const src = new URL("sandbox.html", window.location.href).href;

    const post = (m: unknown): void => frame?.contentWindow?.postMessage(m, "*");

    function deliver(list: AppEvent[]): void {
        if (!connected) return;
        const fresh = list
            .filter((e) => !delivered.has(e.id))
            // Snapshots: $state proxies cannot be cloned by postMessage.
            .map((e) => ({ id: e.id, sender: e.sender, ts: e.ts, data: $state.snapshot(e.data) }));
        if (!fresh.length) return;
        for (const e of fresh) delivered.add(e.id);
        post({ __miniapp: true, kind: "events", events: fresh });
    }

    function onMessage(e: MessageEvent): void {
        if (!frame || e.source !== frame.contentWindow || !e.data?.__miniapp) return;
        const m = e.data as { kind: string; data?: unknown; message?: string; height?: number };
        if (m.kind === "sandbox-ready") post({ __miniappLoad: withBridge(html) });
        else if (m.kind === "hello") {
            post({ __miniapp: true, kind: "init", info: c.appInfo() });
            connected = true;
            delivered = new Set();
            deliver(events);
        } else if (m.kind === "send") void c.sendAppEvent(appId, m.data);
        else if (m.kind === "error" && m.message) c.reportAppError(appId, m.message);
        else if (m.kind === "size" && typeof m.height === "number") height = Math.min(Math.max(m.height, 120), 1600);
    }

    $effect(() => {
        deliver(events);
    });

    window.addEventListener("message", onMessage);
    onDestroy(() => window.removeEventListener("message", onMessage));
</script>

<iframe
    bind:this={frame}
    class="app-frame"
    {src}
    sandbox="allow-scripts allow-forms"
    {title}
    style:height={fit && height ? `${height + 2}px` : undefined}
></iframe>
