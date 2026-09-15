# wellnoded

> ### ⚠️ This app is vibe coded
>
> Every line of it — server, editor, parser, math renderer, tests, and this
> README — was written by an LLM from prompts, not by a human typing code.
> It was steered by feel and by whether the thing worked on screen, not by
> design docs or line-by-line review. Read [What "vibe coded" means
> here](#what-vibe-coded-means-here) before you trust it with anything you
> care about.

A superlightweight outliner. One markdown file is the database, one stdlib Python
process is the server, no dependencies anywhere. Written entirely by an LLM — see
the note above.

```
python3 server.py            # http://localhost:8722, editing ./TODO.wellnoded or ./data.md
```

## What it is

An **outliner** — the Workflowy / Roam / Logseq shape of program. Not a notes app
with folders and not a task manager with projects and due dates: one endlessly
nestable bulleted tree that you write into, where every bullet is both a line of
text and a container for more lines.

Three things fall out of that shape, and they are most of the app:

- **Everything is one document.** There is no *new note* button, no filing step.
  Ideas get typed in wherever you are and moved into shape later with `Tab` and
  `Alt+↑`. Structure is whatever the indentation currently says it is.
- **Any bullet can become the screen.** Click a bullet and it becomes the root:
  its subtree is now the whole outline, with a breadcrumb to climb back out. A
  project, a chapter, a shopping list and a year of meeting notes are the same
  kind of object at different depths, and you work in whichever one you zoomed
  into.
- **Done is a strikethrough, not a checkbox column.** Anything that can be a task
  is a task; `Ctrl+Enter` strikes it, *hide done* makes it disappear, and nothing
  else about the item has to change.

A bullet carries a title and, optionally, body text under it — so the same tree
holds one-line todos and several paragraphs of prose without you deciding up front
which kind of thing you are writing. Inline formatting and LaTeX render in place.

What makes it different from the apps it imitates is what it runs on: **the
outline is a markdown file on your disk**, not a database, an account or a sync
service. `data.md` is the document, in the format shown below; the server is a
single dependency-free `server.py` that reads it, serves an editor, and writes it
back. You can edit that file in vim at the same time, `git commit` it, `grep` it,
or delete the program entirely and still have everything you wrote in a text file
that reads fine without it.

That property is what `![[…]]` mounts (below) extend: since a document is just a
file, one outline can pull in outlines living in other repos — or on other
machines over `ssh` — and show the lot as one tree. A `TODO.wellnoded` per
project, plus a hub file that lists them, gives you one screen over work scattered
across a disk.

**It is a single-user local tool.** No accounts, no authentication, no
collaboration, no mobile app; it serves `localhost` and expects one person. See
[Only do this on a network you trust](#only-do-this-on-a-network-you-trust) before
binding it anywhere else.

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
| Linked file | `![[target]]` at the end of the title — see below |

Edit `data.md` in your editor whenever you like. New items without an `^id` get one
on the next load; a title that genuinely ends in something like `^abc` is written
back escaped as `\^abc`. Collapsed/expanded state and the *hide done* switch are
per-browser (localStorage) and deliberately kept **out** of the file.

Because the file is plain markdown, `git add data.md` gives you free version history.

## Linking other files

Drop a `TODO.wellnoded` into each of your projects — it is a `data.md` under
another name — and pull them all into one outline from a file that just holds
the pointers:

```markdown
# Everything

- Project A ![[../project-a/TODO.wellnoded]] ^m1x
- The server box ![[10.1.1.12:~/git/infra/TODO.wellnoded]] ^m2y
- Someone else's plan ![[?10.1.1.12:~/shared/plan.md]] ^m3z
```

A node whose title ends in `![[…]]` is a **mount**. Its children are not stored
in this file — they live in the file it names, and are read and written there.
The host file holds only the pointer, the label and the position, so the two
files never disagree about who owns what. A title that genuinely ends in
`![[something]]` is written back escaped as `\![[something]]`, the same trick
the `^id` suffix already uses.

| Target | Means |
|---|---|
| `../other/TODO.wellnoded` | relative to the file that names it |
| `~/notes/plan.md`, `/srv/x.md` | an absolute path on this machine |
| `10.1.1.12:~/git/x/TODO.wellnoded` | another machine, over `ssh` |
| `user@host:/srv/x.md` | same, as a particular user |
| `?` in front of any of those | **read-only** — shown, never written |

Remote targets are scp-style and the path has to be anchored with `~` or `/`,
so `notes:2024.md` stays an ordinary local filename (write `./notes:2024.md`
if it is one). A relative target inside a remote file resolves on that same
machine, so a hub on one box can fan out across a whole tree there.

There is no daemon on the other end: wellnoded runs one `ssh` per read and one
per write, using your existing keys and `BatchMode` (so it never prompts). The
remote write is the same as the local one — temp file, `mv` into place, a
rotated backup in `.wellnoded-backups/` beside the file — and the revision
check happens on the remote inside the same connection, so two people editing
the same remote file still get the conflict prompt rather than a silent
overwrite.

**In the browser** a mount is a node with a ring for a bullet and the file's
path beside it. It starts closed and is fetched when you open it, so a hub
listing twenty projects loads instantly and a machine that is switched off
costs you nothing until you go looking. Once open it behaves like any other
subtree: edit, strike, reorder, zoom in, link to it. Each file saves on its own
schedule with its own revision, and the status light counts the files with
unsaved changes rather than just one.

Three things it deliberately will not do:

- **Move a node across a file boundary.** `Tab` and `Shift+Tab` stop at the
  edge of a mount and say so. Use *Add a node in that file* from the mount's
  `⋯` menu to create one on the other side.
- **Write a mount's children into the host file.** The serializer stops at a
  mount, whatever the browser sends.
- **Write a file it could not read.** A mount that failed to load renders as a
  red *could not load* line with *retry* and, for a path that does not exist,
  *create it*. A missing file is never created behind your back — a typo stays
  a typo. The server also refuses any write to a mounted file that does not
  carry the revision it was loaded at, so an empty screen can never be saved
  over a file that was simply unreachable.

A mount whose target is already open higher up the same chain is refused rather
than followed, so a loop between two files is a dead end, not a hang.

Permalinks grow a path: a node inside a mount is `#m1x.a7k`, and one two files
deep is `#m1x.b2m.a7k`. Those work in the export too.

### Only do this on a network you trust

Mounts turn wellnoded into something that reads and writes files on other
machines on your behalf. Combined with `--host 0.0.0.0`, which has no
authentication of any kind, anyone who can reach the port can reach everything
your ssh keys can. `--no-remote` refuses `host:path` mounts entirely and is
worth setting if you ever bind to anything but localhost.

## Interface

Bullet click zooms into a node. The breadcrumb, **↑ up** and **⌂ root** are the ways
back out — one level, or all of them. Every node has a permalink: `⋯ → Copy link to
node` gives `http://localhost:8722/#a7k`, and opening it lands zoomed into that node.

**hide done** hides struck nodes and their subtrees. A parent stays un-struck no
matter how many of its children are done — striking is per node, never inherited.

**export** downloads a single self-contained `.html`: no editing, but zoom, collapse,
hide-done and `#id` links all still work, offline, from `file://`. Mounts are
followed and baked in, so the export is the whole federation in one file; a
mount that cannot be read at that moment becomes a visible *not included* note
rather than a silent hole or a failed export. It exports what you
are looking at — zoomed into a node, you get that node and its descendants, with the
node itself as the export's title; at the root you get the whole outline. Same thing on
the command line:

```
python3 server.py --export outline.html
python3 server.py --export chapter.html --export-root fm1   # just that subtree
```

### Keys

| | |
|---|---|
| `Enter` | new node (first child if the node is open and has children, else next sibling) |
| `Shift+Enter` | jump from title to body |
| `Tab` / `Shift+Tab` | indent / outdent (stops at a mount boundary) |
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
                  --no-remote             # refuse host:path mounts, local files only
                  --export out.html       # write the read-only export and exit
                  --export-root fm1       # with --export: only that node's subtree
                  --export-root m1x.a7k   #   ... including one inside a mount
```

With no `--file`, wellnoded looks for `TODO.wellnoded` and then `data.md` in the
current directory, so running it inside a project picks up that project's file.

`--host 0.0.0.0` exposes it to your LAN/VPN. There is no authentication of any kind,
so only do that on a network you trust. `WELLNODED_FILE`, `WELLNODED_PORT` and
`WELLNODED_HOST` work as environment variables too.

## What "vibe coded" means here

This project was built by prompting an LLM and keeping whatever looked and felt
right in the browser. That is the whole methodology. Concretely:

- **No human wrote the code.** A person decided what the app should do and
  judged the result; the model produced `server.py`, everything in `static/`,
  and this README.
- **It was not line-by-line reviewed.** Correctness was judged by using the app
  and by the DOM tests in `static/_test.html` passing — not by anyone reading
  every branch of the markdown parser, the mount logic, or the ssh code.
- **It has not been security-audited.** There is no authentication anywhere, and
  mounts run `ssh` on your behalf. The warnings about `--host 0.0.0.0` and
  `--no-remote` in this README are the real limits, not boilerplate.
- **Design decisions came from vibes.** Save timings, the file format, the key
  bindings — chosen because they felt right in use, not because they were
  measured against alternatives.

What that buys you: the file format is plain markdown you can read and fix in
any editor, writes are atomic, and the last 20 versions live in
`.wellnoded-backups/`. So even when the code is wrong, your notes are a text
file you still own. Keep `data.md` in git and you have a full undo the app
cannot take away from you.

Use it, fork it, rewrite it. Just don't assume anyone vetted it.

## Layout

```
server.py            markdown <-> json, http, atomic writes, mounts, export  (stdlib only)
data.md              your outline
static/app.js        editor
static/export.js     read-only viewer used by the export
static/render.js     inline markdown + LaTeX, shared by both
static/app.css       styling, light and dark
static/_test.html    42 DOM tests; open http://localhost:8722/static/_test.html
```
