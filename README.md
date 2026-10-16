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
| Model | WebLLM on WebGPU, in a worker, with an 8k context window. Qwen 2.5 Coder 1.5B is the default and runs on integrated GPUs. 3B and 7B and Qwen 3.5 4B write better code but need a dedicated GPU; on a Radeon 860M, 3B lost the device at any prompt size. |
| Skills | `src/skills/`: the miniapp API, the rules, and five working templates (poll, checklist, random picker, scoreboard, countdown, blank). A new app always starts from the closest template; small models adapt working code much better than they write from scratch. |
| Checks | Before an app runs, it is checked for network use, external files, browser storage, `alert` and a cut-off file. Problems go back to the model once, automatically. So does an error the preview reports when the app starts; after that, the "Ask the model to fix it" button does it. |
| Sandbox | Apps run in `sandbox.html` inside `<iframe sandbox="allow-scripts">`: an opaque origin with its own CSP (inline code only, **no network**). An app cannot reach the widget, the user's account or storage. |
| Bridge | `window.miniapp` (`ready`, `send`, `on`, `displayName`), injected in front of the app's code. The builder adds the real sender to every event, so an app cannot act as someone else. |
| Publishing | One room state event per app (`de.minagawa.widget_builder.app`, state key = app id, the HTML in the content, at most 48 KB). Everyone who joins sees it. Needs the power level for room settings, like adding a widget does. |
| Using an app | Actions are timeline events (`de.minagawa.widget_builder.event`, `{ app, data }`). Every member can send them, and they are encrypted in E2EE rooms. An app rebuilds its state by replaying them. Each app may send at most 5 in a burst, then one every 2 s. |
| Own widget | **as widget** in the Apps tab copies an `/addwidget` command for `#/?app=<id>`, which shows just that app. |

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

## Limits

- **Apps replay only recent history.** Hosts return roughly the last 50–100 app events, so an
  app's history is that window plus whatever arrives while it is open. Apps should send
  actions that make sense on their own.
- **Apps are not encrypted.** Room state never is, even in E2EE rooms, so published app code
  is readable by the homeserver. App events are encrypted.
- **Removing an app** empties its state event. Its old versions stay in the room history.

## Capabilities

| Capability | Why |
|---|---|
| `io.element.requires_client` | No session of its own |
| `org.matrix.msc2762.send.state_event:de.minagawa.widget_builder.app` | Publish, update and remove apps |
| `org.matrix.msc2762.receive.state_event:de.minagawa.widget_builder.app` | List the room's apps |
| `org.matrix.msc2762.send.event:de.minagawa.widget_builder.event` | An app's actions (votes, items) |
| `org.matrix.msc2762.receive.event:de.minagawa.widget_builder.event` | Everyone else's actions |

## Tests

```sh
pnpm test                                   # vitest: app format, extraction, checks, skills
pnpm test:e2e                               # Playwright, mock host, echo engine: build, preview,
                                            # publish, run, sandbox isolation, runner mode
HEADED=1 node test/real/build.mjs [model]   # real model on your GPU (after pnpm build)
```

## License

AGPL-3.0-or-later, see `LICENSE.md`.
