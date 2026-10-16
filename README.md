# Widget Builder

A Matrix widget with an LLM that runs **in your browser** and builds small apps
("mini-apps") for the room: polls, shared lists, pickers, scoreboards, and whatever else you
describe. You try the app in a sandboxed preview, then publish it, and everyone in the room can
use it, without a server.

```
"A poll: which day works for the team event? Monday to Friday"
→ the model writes the app → preview → "Publish to room" → everyone opens it in Apps
```

## Try it

```sh
pnpm install
pnpm dev                 # http://localhost:5173 (pnpm dev:https for a self-signed cert)
```

In Element:

```
/addwidget http://localhost:5173/#/?matrix_user_id=$matrix_user_id&theme=$org.matrix.msc2873.client_theme
```

Pick a model, press **Load model**, and describe an app. Each message after that describes a
change to it. **undo** goes back a version, and **new app** starts over.

## How it works

| Part | What it is |
|---|---|
| Model | WebLLM on WebGPU, in a worker, with an 8k context window. Qwen 2.5 Coder 1.5B is the default and runs on integrated GPUs; 3B, Qwen 3.5 4B and 7B are offered for dedicated GPUs. |
| Skills | `src/skills/`: the miniapp API, the rules, and eight working templates (poll, checklist, kanban board, random picker, scoreboard, countdown, drawing, blank). A new app always starts from the closest template; small models adapt working code much better than they write from scratch. |
| Checks | Before an app runs, it is checked for network use, external files, browser storage, `alert` and a cut-off file. Problems go back to the model once, automatically. So does an error the preview reports when the app starts; after that, the "Ask the model to fix it" button does it. |
| Sandbox | Apps run in `sandbox.html` inside `<iframe sandbox="allow-scripts">`: an opaque origin with its own CSP (inline code only, **no network**). An app cannot reach the widget, the user's account or storage. |
| Bridge | `window.miniapp` (`ready`, `send`, `on`, `displayName`, `avatar`, `color`), injected in front of the app's code with the base styles (see "How apps look"). The builder adds the real sender to every event, so an app cannot act as someone else. |
| Publishing | One room state event per app (`de.datanauten.widget_builder.app`, state key = app id, the HTML in the content, at most 48 KB). Everyone who joins sees it. Needs the power level for room settings, like adding a widget does. |
| Using an app | Actions are timeline events (`de.datanauten.widget_builder.event`, `{ app, data }`). Every member can send them, and they are encrypted in E2EE rooms. An app rebuilds its state by replaying them. Each app may send at most 5 in a burst, then one every 2 s. |
| Own widget | Publishing also adds the app to the room as a widget of its own (`im.vector.modular.widgets`, state key `widget_builder_<app id>`). Its URL is this builder with `#/?app=<id>` and holds no code: the widget reads the app's HTML from the app's state event, so a new version shows up in the open widget by itself. That widget asks only to read **that one** state event (`receive.state_event:de.datanauten.widget_builder.app#<id>`) and the app's actions. The Apps tab can remove the widget or add it again; without the permission it copies an `/addwidget` command instead. |

## How apps look

Every app gets a small stylesheet in front of its own CSS (`BASE_CSS` in `src/apps.ts`): plain
headings, buttons, fields and lists already look finished, in the room client's colours, light
or dark. A few classes cover what apps keep needing: `row`, `stack`, `grid`, `card`, `list`,
`badge`, `meter`, `big`, `empty`, and quieter `secondary` and `ghost` buttons.
`miniapp.avatar(userId)` gives a person's initial in their own colour. The templates are built
on this, so apps need little CSS of their own: shorter for the model to write, and alike in the
room.

Under the preview, **Colour** gives an app its own accent colour (`<html data-accent>`), or
leaves it with the client's. The frame grows with the app's page.

## Editing an app

**Edit** in the Apps tab loads a published app back into the builder. Three ways to change it:

- **Settings.** An app that is still a template with its own settings (most are) shows them as a
  form: the poll's question and options, the board's columns, the countdown's date. Applying
  them needs no model, so fixing a typo or adding an option works without the download or a GPU.
  The values are checked by the same rules as the model's.
- **Code.** The code view is editable. Applied code goes through the same checks and the same
  click-through test as the model's.
- **The model**, as for a new app: describe the change.

While editing, the preview starts with the app's actions from the room (copies; nothing is sent),
so you see whether the new version still reads what people already voted or added. **reset data**
goes back to those. **undo** works for every kind of change. **Publish update** writes the next
version to the same state event; when someone else published a newer version since you started
editing, it says so and asks before replacing theirs.

The app's own room widget has no edit button: it would need permission to write room state for
everyone who opens the app.

## Does it need external calls?

No, apart from downloading the model once. The model runs on your GPU, the apps are stored
in the room, and running them needs nothing outside the browser. The production CSP allows
network access only to Hugging Face (weights) and `raw.githubusercontent.com` (WebLLM's
compiled model libraries). Apps themselves have no network at all.

The cost of staying local is model quality. Tested on a Radeon 860M with Coder 1.5B:

- **Template-shaped requests work well:** "a poll: which day works, Monday to Friday", then
  "add Saturday and Sunday" (about a minute each).
- **Anything further from a template often breaks:** a countdown and a German wheel of
  fortune came out with syntax errors, cut-off files or missing logic. The automatic fix
  rounds catch some of it, not all.
Adding a hosted model as an optional engine would raise the quality a lot, but it would send
prompts to that provider and needs a key in the browser.

## Which model on which machine

`node test/real/bench.mjs` answers it for the machine it runs on. On a Radeon 860M (integrated,
RDNA 3.5, shared memory), October 2026:

| Model | Apps that work (of 4) | Time for all 4 |
|---|---|---|
| Qwen 2.5 Coder 1.5B | 3 | 3 min |
| Qwen 2.5 Coder 3B | 3 | 7 min |
| Qwen 3.5 4B | 3 | 12 min |
| Qwen 2.5 Coder 7B | 0 | 32 min (one app timed out) |

- **Integrated AMD GPUs on Linux reset during long prompts** (`VK_ERROR_DEVICE_LOST`) with the
  driver's default job timeout: everything above 1.5B failed that way. Raising it
  (`amdgpu.lockup_timeout=30000` as a kernel parameter) removed every reset. Without it the
  widget reads prompts in parts and learns a safe part size per model.
- **Bigger was not better here:** 3B and 4B built no more working apps, only slower.
- **LFM2-8B-A1B** (mixture of experts, through Transformers.js) was as fast as the 1.5B but built
  2 of 4 apps, and its ONNX runtime made the widget 26 MB bigger; it was removed in 0.3.0.

## Trying apps out before showing them

Every new app is used once in a hidden sandbox before anyone sees it (`src/probe.ts`): the probe
types a word into each field (and fills the rest of the form), submits, clicks the buttons and
draws on a canvas, with sends echoed back as from a room. Problems ("typing into 'New card'
shares nothing", "Kiwi41 never appears on the page") go back to the model: up to three model
calls per request, and the version with the fewest problems stays. `#/?probe=0` turns it off.

Benchmark, Qwen 2.5 Coder 1.5B on a Radeon 860M, 12 tasks × 2 runs:

| | Apps that work | Time for 24 apps |
|---|---|---|
| Without the probe | 19/24 (79%) | 39 min (one run hung for 17 min) |
| With the probe | 23/24 (96%) | 32 min |

Typical catch: asked to rename the kanban board, the model also dropped the `render()` call in
`miniapp.on`, so cards were added but never shown. Apps that pass need about 50 s as before;
apps that need fixes take 2.5–4 min. The benchmark's checks are separate code from the probe,
but both type and click, so they are not fully independent.

## Settings only, when a template fits

Every template starts with one `const SETTINGS = {…};` line (a poll's question and options, a
board's columns, a countdown's date). When a request matches a template, the model first gets a
short prompt: what the app does, its settings, the request. It answers with the settings as JSON,
or `{"custom": true}` when the request needs more than they allow; then, and when the JSON is
unusable or the click-through test fails, it writes code as before. A change to an app that is
still the template with other settings tries settings first too. `#/?settings=0` turns it off.

Benchmark, same machine and tasks as above:

| | Apps that work | Time for 24 apps |
|---|---|---|
| Code, with the probe | 23/24 (96%) | 32 min |
| Settings first, with the probe | 24/24 (100%) | 11 min |

18 of 24 apps were settings only, at 8–10 s each instead of about 50 s. The scoreboard and the
sketch pad went to code both times; the guestbook has no template. The benchmark does not check
every feature a request names: neither idea board has upvotes (one settings only, a plain kanban
board; one code), and both pass because adding ideas works.

## Limits

- **Apps replay only recent history.** Hosts return roughly the last 50–100 app events, so an
  app's history is that window plus whatever arrives while it is open. Apps should send
  actions that make sense on their own.
- **Apps are not encrypted.** Room state never is, even in E2EE rooms, so published app code
  is readable by the homeserver. App events are encrypted.
- **Removing an app** empties its state event and removes its room widget. Its old versions stay in the room history.

## Capabilities

| Capability | Why |
|---|---|
| `io.element.requires_client` | No session of its own |
| `org.matrix.msc2762.send.state_event:de.datanauten.widget_builder.app` | Publish, update and remove apps |
| `org.matrix.msc2762.receive.state_event:de.datanauten.widget_builder.app` | List the room's apps |
| `org.matrix.msc2762.send.event:de.datanauten.widget_builder.event` | An app's actions (votes, items) |
| `org.matrix.msc2762.receive.event:de.datanauten.widget_builder.event` | Everyone else's actions |
| `org.matrix.msc2762.send.state_event:im.vector.modular.widgets` | Add each published app to the room as its own widget, remove it again |
| `org.matrix.msc2762.receive.state_event:im.vector.modular.widgets` | Know which apps already are room widgets |

A room widget for one app (`#/?app=<id>`) asks for less: `requires_client`,
`receive.state_event:de.datanauten.widget_builder.app#<id>` and the two event capabilities.

## Tests

```sh
pnpm test                                   # vitest: app format, extraction, checks, skills
pnpm test:e2e                               # Playwright, mock host, echo engine: build, preview,
                                            # publish, run, sandbox isolation, runner mode
HEADED=1 node test/real/build.mjs [model]   # real model on your GPU (after pnpm build)
node test/real/bench.mjs                    # which model is best on this machine: builds four apps
                                            # per model, clicks and types in them, ranks the models
```

## Icon

`public/icon.svg` (favicon, header) and `public/icon-512.png` (store listing): three finished
app tiles and one being made. Regenerate the PNG with
`magick -background none -density 192 public/icon.svg -resize 512x512 public/icon-512.png`.

## License

AGPL-3.0-or-later, see `LICENSE.md`.
