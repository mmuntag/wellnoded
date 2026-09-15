#!/usr/bin/env python3
"""wellnoded - a superlightweight outliner backed by a human-readable markdown file.

The markdown file is the source of truth.  Format:

    - Title text ^a7k
      Optional body, indented to the title's text column.
      - child node ^b2m
      - ~~done node~~ ^x9q
    1. Ordered children ^k4z
       1. first ^p8r
       2. second ^t3w

Run:  python3 server.py [--file data.md] [--port 8722] [--host 127.0.0.1]
"""

import argparse
import json
import os
import random
import re
import string
import sys
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

ALPHABET = string.digits + string.ascii_lowercase
ID_PAT = r"[0-9a-z]{3}"

ITEM_RE = re.compile(r"^(?P<ind>[ \t]*)(?P<marker>[-*+]|\d+[.)])(?P<sp>[ \t]+)(?P<text>.*)$")
TRAIL_ID_RE = re.compile(r"(?:^|(?<=[ \t]))(?<!\\)\^(" + ID_PAT + r")[ \t]*$")
ESCAPED_ID_RE = re.compile(r"\\\^(" + ID_PAT + r")([ \t]*)$")
BARE_ID_RE = re.compile(r"(?:^|(?<=[ \t]))\^" + ID_PAT + r"[ \t]*$")
DONE_RE = re.compile(r"^~~(.*)~~$", re.S)

SAMPLE = """# wellnoded

- Welcome to wellnoded ^wn1
  Click any line to edit it. Press **Enter** for a new line, **Tab** to indent.
  The whole document lives in `data.md` - open it in any editor, it stays readable.
  - Click the bullet of a node to zoom into it ^wn2
  - The breadcrumb above then offers *up one level* and *all the way up* ^wn3
  - Press Ctrl+Enter to strike a node through, like this: ^wn4
  - ~~a finished thing~~ ^wn5
    A struck node fades out.  A parent can stay open even when every child is done.
- Formatting ^fm1
  - **bold**, *italic*, __underline__, ~~strike~~, `code` ^fm2
  - A link: [wellnoded](https://example.com) or just https://example.com ^fm3
  - Math: $e^{i\\pi} + 1 = 0$ and $\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$ ^fm4
- Ordered children ^or1
  1. This parent is set to numbered ^or2
  2. Use the node menu to switch between - and 1. ^or3
"""


# ---------------------------------------------------------------- parsing

def new_id(used):
    while True:
        i = "".join(random.choice(ALPHABET) for _ in range(3))
        if i not in used:
            used.add(i)
            return i


def parse(text):
    """markdown -> {'header': [str], 'children': [node]}"""
    root = {"id": None, "title": "", "body": "", "done": False,
            "child_style": "bullet", "children": []}
    header = []
    stack = []            # [(content_indent, node)]
    pending_blank = []
    used = set()
    fixups = []           # nodes needing a generated id
    started = False

    for raw in text.split("\n"):
        line = raw.expandtabs(4)
        m = ITEM_RE.match(line)

        if m:
            started = True
            pending_blank = []
            ind = len(m.group("ind"))
            marker = m.group("marker")
            body_col = ind + len(marker) + len(m.group("sp"))
            txt = m.group("text")

            while stack and ind < stack[-1][0]:
                stack.pop()
            parent = stack[-1][1] if stack else root

            node_id = None
            mid = TRAIL_ID_RE.search(txt)
            if mid:
                node_id = mid.group(1)
                txt = txt[: mid.start()].rstrip()
            txt = ESCAPED_ID_RE.sub(r"^\1\2", txt)

            done = False
            d = DONE_RE.match(txt.strip())
            if d:
                done = True
                txt = d.group(1).strip()

            node = {"id": node_id, "title": txt, "body": "", "done": done,
                    "child_style": "bullet", "children": []}
            if node_id and node_id not in used:
                used.add(node_id)
            else:
                node["id"] = None
                fixups.append(node)

            style = "ordered" if marker[0].isdigit() else "bullet"
            if not parent["children"]:
                parent["child_style"] = style
            parent["children"].append(node)
            stack.append((body_col, node))
            continue

        if not line.strip():
            pending_blank.append("")
            continue

        indent = len(line) - len(line.lstrip(" "))
        if stack and indent >= stack[-1][0]:
            col, node = stack[-1]
            chunk = line[col:] if len(line) >= col else line.lstrip(" ")
            parts = ([node["body"]] if node["body"] else []) + pending_blank + [chunk]
            node["body"] = "\n".join(parts) if node["body"] or pending_blank else chunk
            pending_blank = []
        elif not started:
            header.append(raw)
            for _ in pending_blank:
                header.append("")
            pending_blank = []
        elif stack:
            col, node = stack[-1]
            chunk = line.lstrip(" ")
            node["body"] = (node["body"] + "\n" + chunk) if node["body"] else chunk
            pending_blank = []
        else:
            header.append(raw)
            pending_blank = []

    for node in fixups:
        node["id"] = new_id(used)

    while header and not header[-1].strip():
        header.pop()
    return {"header": header, "children": root["children"],
            "child_style": root["child_style"]}


def serialize(doc):
    out = list(doc.get("header") or [])
    if out:
        out.append("")

    def emit(node, indent, index, style):
        marker = ("%d." % index) if style == "ordered" else "-"
        title = " ".join(node.get("title", "").split("\n")).strip()
        if BARE_ID_RE.search(title):
            title = re.sub(r"\^(" + ID_PAT + r")([ \t]*)$", r"\\^\1\2", title)
        if node.get("done"):
            title = "~~%s~~" % title
        head = " " * indent + marker + " "
        out.append(head + (title + " " if title else "") + "^" + node["id"])

        col = indent + len(marker) + 1
        body = node.get("body", "")
        if body.strip():
            for bl in body.split("\n"):
                out.append((" " * col + bl) if bl.strip() else "")

        cstyle = node.get("child_style") or "bullet"
        for i, ch in enumerate(node.get("children") or []):
            emit(ch, col, i + 1, cstyle)

    rstyle = doc.get("child_style") or "bullet"
    for i, ch in enumerate(doc.get("children") or []):
        emit(ch, 0, i + 1, rstyle)
    return "\n".join(out).rstrip() + "\n"


def normalize(doc):
    """Guarantee every node has a unique id and well-formed fields."""
    used = set()

    def walk(nodes):
        for n in nodes:
            nid = n.get("id")
            if not isinstance(nid, str) or not re.fullmatch(ID_PAT, nid) or nid in used:
                nid = new_id(used)
                n["id"] = nid
            used.add(nid)
            n["title"] = str(n.get("title") or "")
            n["body"] = str(n.get("body") or "")
            n["done"] = bool(n.get("done"))
            n["child_style"] = "ordered" if n.get("child_style") == "ordered" else "bullet"
            n["children"] = n.get("children") or []
            walk(n["children"])

    doc["children"] = doc.get("children") or []
    doc["header"] = doc.get("header") or []
    doc["child_style"] = "ordered" if doc.get("child_style") == "ordered" else "bullet"
    walk(doc["children"])
    return doc


# ---------------------------------------------------------------- storage

class Store:
    def __init__(self, path, backups=True, keep=20):
        self.path = os.path.abspath(path)
        self.backups = backups
        self.keep = keep
        self.bdir = os.path.join(os.path.dirname(self.path), ".wellnoded-backups")
        if not os.path.exists(self.path):
            with open(self.path, "w", encoding="utf-8") as f:
                f.write(SAMPLE)
            sys.stderr.write("created %s with sample content\n" % self.path)

    def rev(self):
        try:
            return str(os.stat(self.path).st_mtime_ns)
        except FileNotFoundError:
            return "0"

    def load(self):
        with open(self.path, encoding="utf-8") as f:
            text = f.read()
        return normalize(parse(text)), self.rev()

    def save(self, doc):
        text = serialize(normalize(doc))
        if self.backups and os.path.exists(self.path):
            os.makedirs(self.bdir, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            base = os.path.basename(self.path)
            dst = os.path.join(self.bdir, "%s.%s.bak" % (base, stamp))
            if not os.path.exists(dst):
                with open(self.path, "rb") as a, open(dst, "wb") as b:
                    b.write(a.read())
            old = sorted(x for x in os.listdir(self.bdir) if x.startswith(base + "."))
            for x in old[: max(0, len(old) - self.keep)]:
                try:
                    os.remove(os.path.join(self.bdir, x))
                except OSError:
                    pass
        tmp = self.path + ".tmp%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)
        return self.rev()


# ---------------------------------------------------------------- export

def find_node(doc, node_id):
    stack = list(doc.get("children") or [])
    while stack:
        n = stack.pop()
        if n.get("id") == node_id:
            return n
        stack.extend(n.get("children") or [])
    return None


def subtree(doc, node):
    """The slice of doc rooted at node, as (doc, title, root)."""
    sub = {"header": [], "children": node.get("children") or [],
           "child_style": node.get("child_style") or "bullet"}
    root = {"title": node.get("title") or "", "body": node.get("body") or "",
            "done": bool(node.get("done"))}
    return sub, plain_text(root["title"]) or "untitled", root


MD_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def plain_text(s):
    """Rough markdown -> text, good enough for a filename or a tab title."""
    return " ".join(re.sub(r"[*_`~$]", "", MD_LINK_RE.sub(r"\1", s)).split())


def build_export(doc, title, root=None):
    def read(name):
        with open(os.path.join(STATIC, name), encoding="utf-8") as f:
            return f.read()
    data = json.dumps({"doc": doc, "title": title, "root": root},
                      ensure_ascii=False)
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s</title>
<style>
%s
%s
</style></head><body>
<div id="app"></div>
<script>window.WN_EXPORT = %s;</script>
<script>
%s
</script>
<script>
%s
</script>
</body></html>
""" % (esc(title), read("app.css"), read("export.css"), data,
       read("render.js"), read("export.js"))


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


# ---------------------------------------------------------------- server

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
        ".ico": "image/x-icon", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "wellnoded"
    store = None

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    # -- helpers
    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _static(self, name):
        path = os.path.normpath(os.path.join(STATIC, name.lstrip("/")))
        if not path.startswith(STATIC) or not os.path.isfile(path):
            return self._send(404, "not found", "text/plain; charset=utf-8")
        ext = os.path.splitext(path)[1]
        with open(path, "rb") as f:
            self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))

    # -- routes
    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/" or p == "/index.html":
            return self._static("index.html")
        if p == "/api/doc":
            doc, rev = self.store.load()
            return self._json(200, {"rev": rev, "doc": doc,
                                    "file": self.store.path})
        if p == "/api/export":
            doc, _ = self.store.load()
            title, root = doc_title(doc, self.store.path), None
            want = parse_qs(urlparse(self.path).query).get("root", [None])[0]
            if want:
                node = find_node(doc, want)
                if not node:
                    return self._send(404, "no such node",
                                      "text/plain; charset=utf-8")
                doc, title, root = subtree(doc, node)
            fname = re.sub(r"[^\w.-]+", "-", title).strip("-") or "wellnoded"
            html = build_export(doc, title, root)
            return self._send(200, html, "text/html; charset=utf-8",
                              {"Content-Disposition":
                               'attachment; filename="%s.html"' % fname})
        if p.startswith("/static/"):
            return self._static(p[len("/static/"):])
        return self._send(404, "not found", "text/plain; charset=utf-8")

    def do_HEAD(self):
        self.do_GET()

    def do_PUT(self):
        p = urlparse(self.path).path
        if p != "/api/doc":
            return self._send(404, "not found", "text/plain; charset=utf-8")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as e:
            return self._json(400, {"error": "bad payload: %s" % e})

        cur = self.store.rev()
        if not payload.get("force") and payload.get("rev") not in (None, cur):
            doc, rev = self.store.load()
            return self._json(409, {"error": "file changed on disk",
                                    "rev": rev, "doc": doc})
        try:
            rev = self.store.save(payload.get("doc") or {})
        except Exception as e:
            return self._json(500, {"error": str(e)})
        return self._json(200, {"rev": rev})

    def do_POST(self):
        self.do_PUT()


def doc_title(doc, path):
    for line in doc.get("header") or []:
        m = re.match(r"^#\s+(.*\S)", line)
        if m:
            return m.group(1)
    return os.path.splitext(os.path.basename(path))[0]


def main():
    ap = argparse.ArgumentParser(description="wellnoded outliner server")
    ap.add_argument("--file", "-f", default=os.environ.get("WELLNODED_FILE", "data.md"))
    ap.add_argument("--port", "-p", type=int,
                    default=int(os.environ.get("WELLNODED_PORT", 8722)))
    ap.add_argument("--host", default=os.environ.get("WELLNODED_HOST", "127.0.0.1"),
                    help="use 0.0.0.0 to reach it over a VPN/LAN")
    ap.add_argument("--no-backups", action="store_true")
    ap.add_argument("--export", metavar="OUT",
                    help="write a read-only html export and exit")
    ap.add_argument("--export-root", metavar="ID",
                    help="with --export, export only the subtree under node ID")
    args = ap.parse_args()

    store = Store(args.file, backups=not args.no_backups)

    if args.export:
        doc, _ = store.load()
        title, root = doc_title(doc, store.path), None
        if args.export_root:
            node = find_node(doc, args.export_root)
            if not node:
                sys.stderr.write("no such node: %s\n" % args.export_root)
                return 1
            doc, title, root = subtree(doc, node)
        with open(args.export, "w", encoding="utf-8") as f:
            f.write(build_export(doc, title, root))
        print("wrote %s" % args.export)
        return

    Handler.store = store
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("wellnoded  file: %s" % store.path)
    print("           open: http://%s:%d/" %
          ("localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host, args.port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    sys.exit(main())
