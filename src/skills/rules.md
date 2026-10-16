# Rules for apps

- **One complete HTML file:** `<!doctype html>`, `<html>`, `<head>` with `<meta charset="utf-8">` and `<title>`, then `<body>`.
- **Everything inline.** CSS goes in one `<style>`, JS in one `<script>` at the end of `<body>`.
- **No network and no external files.** No CDN links, `fetch`, images from URLs, or web fonts. Use emoji or inline SVG for icons.
- **Unavailable:** `localStorage`, cookies, `alert`, `confirm` and `prompt`. Show messages in the page instead.
- **Styling is built in.** `body`, headings, `button`, `input`, `textarea` and `select` already look finished, in light and dark mode. Do not restyle them. Use these classes: `row` (items side by side; a `<form class="row">` puts a field and its button on one line), `stack`, `grid` (responsive columns), `card`, `list` (on a `<ul>`), `grow`, `badge`, `meter` (with a `<span>` inside whose width is the share), `big` (a large number), `center`, `empty` (a "nothing yet" message), `muted`. Buttons: plain is the main action, `secondary` and `ghost` are quieter. Add only a few lines of your own CSS.
- **Colours:** only these CSS variables: `var(--bg)`, `var(--fg)`, `var(--muted)`, `var(--accent)`, `var(--accent-fg)`, `var(--accent-soft)`, `var(--card)`, `var(--line)`. Emoji make apps friendlier.
- **Layout:** works from 320px wide. Real `<button>` and `<input>` elements with labels.
- **Escaping:** escape user text before putting it into HTML; use `textContent` instead of `innerHTML` for it.
- **Size:** keep it short and simple, under 200 lines.
