# wellnoded

A superlightweight outliner. One markdown file is the database, one stdlib Python
process is the server, no dependencies anywhere.

```
python3 server.py            # http://localhost:8722, editing data.md
```

## The file format

`data.md` stays readable and hand-editable. Everything the app knows lives in it.

```markdown
# My notes

- Groceries ^a7k
  A body paragraph, indented to the title's text column.
  Blank lines separate body paragraphs.
  - milk ^b2m
  - ~~bread~~ ^x9q
- Trip planning ^k4z
  1. book flights ^p8r
  2. hotel ^t3w
```

| Thing | How it is stored |
|---|---|
| Node id | `^a7k` at the end of the title line: 3 chars of `[0-9a-z]`, Obsidian block-ref syntax |
| Order | file order, always explicit |
| List style | the marker the children actually use — `-` or `1.`, chosen per parent |
| Struck through | the whole title wrapped in `~~…~~` |
| Body | lines under the title, indented to the title's text column |
| Nesting | indentation, standard markdown |

Edit `data.md` in your editor whenever you like. New items without an `^id` get one
on the next load; a title that genuinely ends in something like `^abc` is written
back escaped as `\^abc`. Collapsed/expanded state and the *hide done* switch are
per-browser (localStorage) and deliberately kept **out** of the file.

Because the file is plain markdown, `git add data.md` gives you free version history.

## Interface

Bullet click zooms into a node. The breadcrumb, **↑ up** and **⌂ root** are the ways
back out — one level, or all of them. Every node has a permalink: `⋯ → Copy link to
node` gives `http://localhost:8722/#a7k`, and opening it lands zoomed into that node.

**hide done** hides struck nodes and their subtrees. A parent stays un-struck no
matter how many of its children are done — striking is per node, never inherited.

**export** downloads a single self-contained `.html`: no editing, but zoom, collapse,
hide-done and `#id` links all still work, offline, from `file://`. Same thing on the
command line:

```
python3 server.py --export outline.html
```

### Keys

| | |
|---|---|
| `Enter` | new node (first child if the node is open and has children, else next sibling) |
| `Shift+Enter` | jump from title to body |
| `Tab` / `Shift+Tab` | indent / outdent |
| `Alt+↑` / `Alt+↓` | move node up / down |
| `Ctrl+Enter` | strike through / un-strike |
| `Backspace` at the start of an empty node | delete it |
| `↑` / `↓` at the edge of a line | previous / next node |
| `Esc` | leave the editor (from the body: back to the title) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+S` | save now |
| `h` | toggle hide-done (when not editing) |

### Formatting

`**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``,
`[text](url)`, bare URLs, and LaTeX between `$…$` (or `$$…$$` for a centred block).

The math subset is rendered by ~200 lines in `static/render.js` — no KaTeX, no CDN,
so it works offline and inside the export. It covers superscripts and subscripts,
`\frac`, `\sqrt[n]{}`, `\binom`, greek letters, the usual relations and operators,
`\sum \prod \int \lim` with limits, `\left(…\right)`, accents (`\hat \bar \vec`),
`\text{} \mathbb{} \mathcal{}`, the named functions (`\sin`, `\log`, …) and spacing
(`\,` `\quad`). Anything outside that renders as plain upright text rather than
breaking.

## Saving

Nothing to configure, but for the record:

- structural edits (add, delete, move, indent, strike, list style) save after **250 ms**
- typing saves **1.2 s** after the last keystroke
- a document left dirty is forced out at least every **10 s**
- anything pending is flushed on blur, on tab-hide, and on unload (`sendBeacon`)

Writes are atomic (`write` to a temp file, then `os.replace`), so the file is never
half-written, and the previous version is copied into `.wellnoded-backups/` first —
the last 20 are kept. The browser holds the file's mtime and sends it with every
save; if something else changed `data.md` in the meantime the server answers `409`
and you are asked whether to keep the screen or reload the file. Nothing is
overwritten silently.

## Options

```
python3 server.py --file notes.md --port 8722 --host 127.0.0.1
                  --no-backups            # skip .wellnoded-backups/
                  --export out.html       # write the read-only export and exit
```

`--host 0.0.0.0` exposes it to your LAN/VPN. There is no authentication of any kind,
so only do that on a network you trust. `WELLNODED_FILE`, `WELLNODED_PORT` and
`WELLNODED_HOST` work as environment variables too.

## Layout

```
server.py            markdown <-> json, http, atomic writes, export  (stdlib only)
data.md              your outline
static/app.js        editor
static/export.js     read-only viewer used by the export
static/render.js     inline markdown + LaTeX, shared by both
static/app.css       styling, light and dark
static/_test.html    22 DOM tests; open http://localhost:8722/static/_test.html
```
