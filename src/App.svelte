<script lang="ts">
    import AppFrame from "./AppFrame.svelte";
    import type { Controller } from "./controller.svelte";
    import { sizeMB } from "./llm";
    import { TEMPLATES } from "./skills";

    let { c }: { c: Controller } = $props();

    let draftText = $state("");
    let publishName = $state("");
    let copied = $state<string | null>(null);

    $effect(() => {
        document.documentElement.dataset.theme = c.theme;
    });
    // Suggest the draft's name when it changes.
    $effect(() => {
        publishName = c.draft?.name ?? "";
    });

    const gb = (mb: number): string => (mb / 1000).toFixed(1);
    const embedded = $derived(c.room !== "standalone");
    const runner = $derived(c.runnerOnly ? c.apps.find((a) => a.id === c.runnerOnly) : undefined);
    const running = $derived(c.running ? c.apps.find((a) => a.id === c.running) : undefined);
    const name = (id: string): string => /^@([^:]+)/.exec(id)?.[1] ?? id;

    const EXAMPLES = [
        "A poll: which day works for the team event? Mon to Fri",
        "A shared packing list for the camping trip",
        "Pick a random person to bring cake next week",
        "A scoreboard for our table football tournament",
    ];

    function submit(e: SubmitEvent): void {
        e.preventDefault();
        const text = draftText;
        draftText = "";
        void c.ask(text);
    }

    async function copy(id: string): Promise<void> {
        const cmd = `/addwidget ${c.widgetUrl(id)}`;
        try {
            await navigator.clipboard.writeText(cmd);
            copied = id;
        } catch {
            copied = null;
            window.prompt?.("Copy this into the room:", cmd);
        }
    }
</script>

{#if c.runnerOnly}
    <main class="runner">
        {#if runner}
            <AppFrame {c} html={runner.html} appId={runner.id} events={c.events[runner.id] ?? []} title={runner.name} />
        {:else if c.room === "no-permission"}
            <p class="note warn">This app needs permission to read apps in this room.</p>
        {:else}
            <p class="note muted">Waiting for the app "{c.runnerOnly}"… If it does not appear, it was removed or not published in this room.</p>
        {/if}
    </main>
{:else}
    <main>
        <header>
            <h1>Widget Builder</h1>
            <span class="pill {c.room}">
                {#if c.room === "standalone"}standalone{:else if c.room === "connecting"}connecting…{:else if c.room === "ready"}in room{:else}no permission{/if}
            </span>
            <nav class="tabs" aria-label="View">
                <button type="button" class:active={c.view === "build"} onclick={() => (c.view = "build")}>Build</button>
                <button type="button" class:active={c.view === "apps"} onclick={() => (c.view = "apps")}>Apps ({c.apps.length})</button>
            </nav>
        </header>

        {#if c.notice}
            <p class="note">{c.notice} <button type="button" class="link" onclick={() => (c.notice = "")}>dismiss</button></p>
        {/if}
        {#if c.room === "no-permission"}
            <p class="note warn">The widget may not read or publish apps in this room. Approve the permissions, or reset them in your client.</p>
        {/if}
        {#if c.gpuProblem}
            <p class="note warn">{c.gpuProblem} The model runs on your GPU, in this browser.</p>
        {/if}

        {#if c.view === "build"}
            <section class="model">
                <label class="grow">
                    <span>Model</span>
                    <select bind:value={c.settings.modelId} onchange={() => c.saveSettings()} disabled={c.engineStatus === "loading" || c.useEcho}>
                        {#each c.models as m (m.id)}
                            <option value={m.id}>{m.label} · {gb(sizeMB(m, c.f16))} GB{c.cached[m.id] ? " · cached" : ""}</option>
                        {/each}
                    </select>
                </label>
                {#if c.engineStatus === "ready"}
                    <button type="button" class="secondary" onclick={() => c.unloadModel()}>Unload</button>
                {:else}
                    <button type="button" onclick={() => c.loadModel()} disabled={c.engineStatus === "loading" || (!!c.gpuProblem && !c.useEcho)}>
                        {c.engineStatus === "loading" ? "Loading…" : "Load model"}
                    </button>
                {/if}
            </section>
            {#if c.engineStatus === "loading"}
                <progress max="100" value={Math.round(c.progress * 100)}></progress>
                <p class="small muted">{c.progressText}</p>
            {:else if c.engineStatus === "ready"}
                <p class="small ok">Ready: {c.model}. Runs locally; your requests never leave this browser.</p>
            {:else if c.engineStatus === "error"}
                <p class="note warn">{c.engineError}</p>
            {/if}

            {#if !c.draft && c.chat.length === 0}
                <div class="intro">
                    <p>Describe a small app for this room. The model writes it, you try it here, then publish it for everyone.</p>
                    <div class="chips" role="group" aria-label="Start from">
                        <span class="small muted">Start from:</span>
                        <button type="button" class="chip" class:active={c.startFrom === "auto"} onclick={() => (c.startFrom = "auto")}>Auto</button>
                        {#each TEMPLATES as t (t.id)}
                            <button type="button" class="chip" class:active={c.startFrom === t.id} onclick={() => (c.startFrom = t.id)}>{t.label}</button>
                        {/each}
                    </div>
                    <ul class="examples">
                        {#each EXAMPLES as ex (ex)}
                            <li><button type="button" class="link" onclick={() => (draftText = ex)}>{ex}</button></li>
                        {/each}
                    </ul>
                </div>
            {/if}

            {#if c.chat.length}
                <ol class="chat" aria-live="polite">
                    {#each c.chat as e (e.id)}
                        <li class="{e.role}" class:error={e.error}>
                            {#if e.role === "model" && e.lines !== undefined && c.busy && !e.problems}
                                {e.text} <span class="muted">({e.lines} lines)</span>
                            {:else}
                                {e.text}
                                {#if e.role === "model" && e.lines}<span class="muted small"> · {e.lines} lines</span>{/if}
                            {/if}
                            {#if e.problems?.length}
                                <ul class="problems">{#each e.problems as p (p)}<li>{p}</li>{/each}</ul>
                            {/if}
                        </li>
                    {/each}
                </ol>
            {/if}

            <form onsubmit={submit}>
                <input
                    type="text"
                    bind:value={draftText}
                    placeholder={c.draft ? "Describe a change…" : "Describe an app…"}
                    aria-label={c.draft ? "Change" : "App description"}
                    disabled={c.busy}
                />
                {#if c.busy}
                    <button type="button" class="secondary" onclick={() => c.stop()}>Stop</button>
                {:else}
                    <button type="submit" disabled={!draftText.trim() || c.engineStatus !== "ready"}>{c.draft ? "Change app" : "Build app"}</button>
                {/if}
            </form>

            {#if c.draft}
                <section class="preview">
                    <div class="bar">
                        <b>Preview</b>
                        <span class="small muted">actions here stay local</span>
                        <span class="grow"></span>
                        <button type="button" class="link" onclick={() => c.undo()} disabled={!c.canUndo || c.busy}>undo</button>
                        <button type="button" class="link" onclick={() => (c.previewEvents = [])}>reset data</button>
                        <button type="button" class="link" onclick={() => c.newApp()} disabled={c.busy}>new app</button>
                    </div>
                    {#if c.draftError}
                        <p class="note warn">
                            The app reported an error: {c.draftError}
                            <button type="button" onclick={() => c.fix()} disabled={c.busy || c.engineStatus !== "ready"}>Ask the model to fix it</button>
                        </p>
                    {/if}
                    {#key c.draft.html}
                        <AppFrame {c} html={c.draft.html} appId={null} events={c.previewEvents} title="Preview" />
                    {/key}
                    <details class="code">
                        <summary>Code ({c.draft.html.length} characters)</summary>
                        <pre>{c.draft.html}</pre>
                    </details>
                    {#if embedded}
                        <form class="publish" onsubmit={(e) => { e.preventDefault(); void c.publish(publishName); }}>
                            <input type="text" bind:value={publishName} aria-label="App name" placeholder="App name" maxlength="60" />
                            <button type="submit" disabled={c.busy || c.room !== "ready" || !publishName.trim()}>
                                {c.draft.appId ? "Publish update" : "Publish to room"}
                            </button>
                        </form>
                    {/if}
                </section>
            {/if}
        {:else}
            {#if c.apps.length === 0}
                <p class="muted">No apps in this room yet. Build one and publish it.</p>
            {:else}
                <ul class="apps">
                    {#each c.apps as a (a.id)}
                        <li class:open={c.running === a.id}>
                            <div class="grow">
                                <b>{a.name}</b>
                                <span class="small muted">v{a.version} by {name(a.author)} · {(c.events[a.id] ?? []).length} actions</span>
                            </div>
                            <button type="button" onclick={() => (c.running = c.running === a.id ? null : a.id)}>{c.running === a.id ? "Close" : "Open"}</button>
                            <button type="button" class="secondary" onclick={() => c.edit(a.id)}>Edit</button>
                            <button type="button" class="link" onclick={() => copy(a.id)}>{copied === a.id ? "copied" : "as widget"}</button>
                            <button type="button" class="link danger" onclick={() => c.remove(a.id)}>remove</button>
                        </li>
                    {/each}
                </ul>
            {/if}
            {#if running}
                <section class="preview">
                    <div class="bar"><b>{running.name}</b><span class="small muted">shared with the room</span></div>
                    {#key running.html}
                        <AppFrame {c} html={running.html} appId={running.id} events={c.events[running.id] ?? []} title={running.name} />
                    {/key}
                </section>
            {/if}
            <p class="small muted">
                Apps run sandboxed: no network, no access to your account, and they can only send and read their own actions in
                this room. "as widget" copies an <code>/addwidget</code> command that shows one app on its own.
            </p>
        {/if}
    </main>
{/if}
