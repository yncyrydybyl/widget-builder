<script lang="ts">
    import AppFrame from "./AppFrame.svelte";
    import type { Controller } from "./controller.svelte";
    import { sizeMB } from "./llm";
    import { TEMPLATES, settingsOf } from "./skills";

    let { c }: { c: Controller } = $props();

    let draftText = $state("");
    let publishName = $state("");
    let copied = $state<string | null>(null);
    /** The settings form and the code editor, refilled from the draft whenever it changes. */
    let form = $state<Record<string, string>>({});
    let settingsError = $state<string | null>(null);
    let code = $state("");

    $effect(() => {
        document.documentElement.dataset.theme = c.theme;
    });
    // Suggest the draft's name when it changes.
    $effect(() => {
        publishName = c.draft?.name ?? "";
    });

    const current = $derived(c.draft ? settingsOf(c.draft.html) : null);
    $effect(() => {
        const s = current?.settings ?? {};
        form = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : v]));
        settingsError = null;
    });
    $effect(() => {
        code = c.draft?.html ?? "";
    });

    function saveSettings(e: SubmitEvent): void {
        e.preventDefault();
        if (!current) return;
        const raw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(current.settings)) raw[k] = Array.isArray(v) ? (form[k] ?? "").split("\n") : (form[k] ?? "");
        settingsError = c.changeSettings(raw);
    }

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
            <!-- A new version of the app replaces the running one. -->
            {#key runner.html}
                <AppFrame {c} html={runner.html} appId={runner.id} events={c.events[runner.id] ?? []} title={runner.name} />
            {/key}
        {:else if c.room === "no-permission"}
            <p class="note warn">This app needs permission to read apps in this room.</p>
        {:else}
            <p class="note muted">Waiting for the app "{c.runnerOnly}"… If it does not appear, it was removed or not published in this room.</p>
        {/if}
    </main>
{:else}
    <main data-busy={c.busy}>
        <header>
            <img class="logo" src="./icon.svg" alt="" width="28" height="28" />
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
                        <span class="small muted">actions here stay local{c.previewBase.length ? `, starting with the room's ${c.previewBase.length} ${c.previewBase.length === 1 ? "action" : "actions"}` : ""}</span>
                        <span class="grow"></span>
                        <button type="button" class="link" onclick={() => c.undo()} disabled={!c.canUndo || c.busy}>undo</button>
                        <button type="button" class="link" onclick={() => c.resetPreviewData()}>reset data</button>
                        <button type="button" class="link" onclick={() => c.newApp()} disabled={c.busy}>new app</button>
                    </div>
                    {#if c.draftError}
                        <p class="note warn">
                            The app reported an error: {c.draftError}
                            <button type="button" onclick={() => c.fix()} disabled={c.busy || c.engineStatus !== "ready"}>Ask the model to fix it</button>
                        </p>
                    {/if}
                    {#key `${c.previewRun}\u0000${c.draft.html}`}
                        <AppFrame {c} html={c.draft.html} appId={null} events={c.previewEvents} title="Preview" />
                    {/key}
                    {#if current}
                        <details class="settings" open={!!c.draft.appId}>
                            <summary>Settings ({current.template.label.toLowerCase()} template)</summary>
                            <form class="settings" onsubmit={saveSettings}>
                                {#each Object.entries(current.settings) as [key, value] (key)}
                                    <label>
                                        <span>{key}{current.template.fields?.[key] ? `: ${current.template.fields[key]}` : ""}{Array.isArray(value) ? ", one per line" : ""}</span>
                                        {#if Array.isArray(value)}
                                            <textarea aria-label={key} rows={Math.min(8, Math.max(3, (form[key] ?? "").split("\n").length))} bind:value={form[key]} disabled={c.busy}></textarea>
                                        {:else if key === "target" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(String(value))}
                                            <input type="datetime-local" aria-label={key} bind:value={form[key]} disabled={c.busy} />
                                        {:else}
                                            <input type="text" aria-label={key} bind:value={form[key]} maxlength="120" disabled={c.busy} />
                                        {/if}
                                    </label>
                                {/each}
                                <div class="edit-actions">
                                    <button type="submit" disabled={c.busy}>Apply settings</button>
                                    <span class="small muted">No model needed; the template's code stays as it is.</span>
                                </div>
                                {#if settingsError}<p class="note warn">{settingsError}</p>{/if}
                            </form>
                        </details>
                    {/if}
                    <details class="code">
                        <summary>Code ({c.draft.html.length} characters)</summary>
                        <textarea aria-label="Code" spellcheck="false" bind:value={code} disabled={c.busy}></textarea>
                        <div class="edit-actions">
                            <button type="button" onclick={() => c.changeCode(code)} disabled={c.busy || code.trim() === c.draft.html.trim()}>Apply code</button>
                            <button type="button" class="link" onclick={() => (code = c.draft?.html ?? "")} disabled={code === c.draft.html}>discard</button>
                            <span class="small muted">Checked and tried out like the model's code.</span>
                        </div>
                    </details>
                    {#if embedded}
                        <form class="publish" onsubmit={(e) => { e.preventDefault(); void c.publish(publishName); }}>
                            <input type="text" bind:value={publishName} aria-label="App name" placeholder="App name" maxlength="60" />
                            <button type="submit" disabled={c.busy || c.room !== "ready" || !publishName.trim()}>
                                {c.draft.appId ? "Publish update" : "Publish to room"}
                            </button>
                        </form>
                        {#if c.conflict}
                            <p class="note warn">
                                {name(c.conflict.author)} published version {c.conflict.version} of this app while you were editing. Publishing replaces their
                                version with yours.
                                <button type="button" onclick={() => c.publish(publishName, true)} disabled={c.busy}>Publish anyway</button>
                                <button type="button" class="link" onclick={() => (c.conflict = null)}>cancel</button>
                            </p>
                        {/if}
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
                                <span class="small muted">v{a.version} by {name(a.author)} · {(c.events[a.id] ?? []).length} actions{a.id in c.roomWidgets ? " · room widget" : ""}</span>
                            </div>
                            <button type="button" onclick={() => (c.running = c.running === a.id ? null : a.id)}>{c.running === a.id ? "Close" : "Open"}</button>
                            <button type="button" class="secondary" onclick={() => c.edit(a.id)}>Edit</button>
                            {#if a.id in c.roomWidgets}
                                <button type="button" class="link" onclick={() => c.removeFromRoom(a.id)} title="Remove this app's own widget from the room">remove widget</button>
                            {:else if c.canAddWidgets}
                                <button type="button" class="link" onclick={() => c.addToRoom(a.id, a.name)}>add as widget</button>
                            {:else}
                                <button type="button" class="link" onclick={() => copy(a.id)}>{copied === a.id ? "copied" : "copy /addwidget"}</button>
                            {/if}
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
                this room. Publishing also adds the app to the room as a widget of its own; that widget loads the app's code from its
                room event, so a new version shows up there by itself.
            </p>
        {/if}
    </main>
{/if}
