# Rules for apps

- **One complete HTML file:** `<!doctype html>`, `<html>`, `<head>` with `<meta charset="utf-8">` and `<title>`, then `<body>`.
- **Everything inline.** CSS goes in one `<style>`, JS in one `<script>` at the end of `<body>`.
- **No network and no external files.** No CDN links, `fetch`, images from URLs, or web fonts. Use emoji or inline SVG for icons.
- **Unavailable:** `localStorage`, cookies, `alert`, `confirm` and `prompt`. Show messages in the page instead.
- **Colours:** use these CSS variables, which are set for light and dark mode: `var(--bg)`, `var(--fg)`, `var(--muted)`, `var(--accent)`, `var(--accent-fg)`, `var(--card)` and `var(--line)`. Set `body { background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; margin: 0; padding: 12px; }`.
- **Layout:** works from 320px wide. Buttons at least 36px tall. Real `<button>` and `<input>` elements with labels.
- **Escaping:** escape user text before putting it into HTML; use `textContent` instead of `innerHTML` for it.
- **Size:** keep it short and simple, under 200 lines.
