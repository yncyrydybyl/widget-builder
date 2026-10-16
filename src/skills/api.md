# The miniapp API

Every app gets `window.miniapp` before its own code runs:

- `miniapp.ready(fn)` calls `fn(info)` once the app is connected. `info.user` is `{ id, name }` for the person using the app.
- `miniapp.send(data)` shares an action with everyone in the room. `data` is small JSON (under 4,000 characters) that describes *what happened*, for example `{ "vote": "pizza" }` or `{ "add": "Buy milk" }`. Never send the whole state.
- `miniapp.on(fn)` calls `fn(event)` for every action, past ones first, then live ones, including your own. `event` is `{ id, sender, ts, data, mine }`; `sender` is the Matrix user id, and `mine` is true for the current user's actions.
- `miniapp.displayName(userId)` turns `@anna:example.org` into `anna`.
- `miniapp.user` and `miniapp.theme` ("light" or "dark") are also available after ready.

## State is a replay of actions

Keep all shared state in plain variables. Change them **only** inside `miniapp.on`, then re-render. A button click calls `miniapp.send(...)` and does not change the state itself: the action comes back through `miniapp.on` like everyone else's. That way every member sees the same thing.

```js
const votes = {};                 // user id -> option
miniapp.on((ev) => {
  if (ev.data && ev.data.vote) votes[ev.sender] = ev.data.vote;
  render();
});
button.onclick = () => miniapp.send({ vote: "pizza" });
```

Only about the last 50 actions in the room are replayed when the app opens, so actions must be meaningful on their own.
