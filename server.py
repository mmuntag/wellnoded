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
    - Other project ![[../other/TODO.wellnoded]] ^m1x
    - Laptop ![[?10.1.1.12:~/git/x/TODO.wellnoded]] ^m2y

A node whose title ends in ![[target]] is a *mount*: its children live in
another file and are never written into this one.  A leading "?" in the target
makes the mount read-only.  Targets are local paths (relative to the file that
names them) or scp-style host:path, fetched over ssh.

Run:  python3 server.py [--file data.md] [--port 8722] [--host 127.0.0.1]
"""

import argparse
import json
import os
import posixpath
import random
import re
import shlex
import string
import subprocess
import sys
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

# ![[target]] at the end of a title line marks a mount point
MOUNT_RE = re.compile(r"(?:^|(?<=[ \t]))(?<!\\)!\[\[(?P<t>[^\]\n]+)\]\][ \t]*$")
ESCAPED_MOUNT_RE = re.compile(r"\\!\[\[([^\]\n]+)\]\]([ \t]*)$")
BARE_MOUNT_RE = re.compile(r"(?:^|(?<=[ \t]))!\[\[[^\]\n]+\]\][ \t]*$")

# scp-style host:path, optionally user@host.  A leading /, ./, ../ or ~ always
# means a local path, so those are excluded before this is consulted.
SSH_TARGET_RE = re.compile(
    r"^(?:(?P<user>[A-Za-z0-9._-]+)@)?"
    r"(?P<host>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\]):"
    r"(?P<path>\S.*)$")

SSH_CONNECT_TIMEOUT = 8
SSH_TIMEOUT = 25
BACKUP_KEEP = 20

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
            "mount": None, "child_style": "bullet", "children": []}
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

            done = False
            d = DONE_RE.match(txt.strip())
            if d:
                done = True
                txt = d.group(1).strip()

            mount = None
            mm = MOUNT_RE.search(txt)
            if mm:
                mount = {"raw": mm.group("t").strip()}
                txt = txt[: mm.start()].rstrip()

            txt = ESCAPED_ID_RE.sub(r"^\1\2", txt)
            txt = ESCAPED_MOUNT_RE.sub(r"![[\1]]\2", txt)

            node = {"id": node_id, "title": txt, "body": "", "done": done,
                    "mount": mount, "child_style": "bullet", "children": []}
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
        if BARE_MOUNT_RE.search(title):
            title = re.sub(r"!\[\[([^\]\n]+)\]\]([ \t]*)$", r"\\![[\1]]\2", title)
        mount = node.get("mount")
        if mount and mount.get("raw"):
            title = (title + " " if title else "") + "![[" + mount["raw"] + "]]"
        if node.get("done"):
            title = "~~%s~~" % title
        head = " " * indent + marker + " "
        out.append(head + (title + " " if title else "") + "^" + node["id"])

        col = indent + len(marker) + 1
        body = node.get("body", "")
        if body.strip():
            for bl in body.split("\n"):
                out.append((" " * col + bl) if bl.strip() else "")

        if mount:
            return          # a mount's children belong to the other file
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
            m = n.get("mount")
            if isinstance(m, str):
                m = {"raw": m}
            raw = (m or {}).get("raw")
            if isinstance(raw, str) and raw.strip():
                # the pointer is all this file stores; whatever the client sent
                # as children of a mount is dropped rather than written out
                n["mount"] = {"raw": raw.strip()}
                n["children"] = []
            else:
                n["mount"] = None
                n["children"] = n.get("children") or []
            walk(n["children"])

    doc["children"] = doc.get("children") or []
    doc["header"] = doc.get("header") or []
    doc["child_style"] = "ordered" if doc.get("child_style") == "ordered" else "bullet"
    walk(doc["children"])
    return doc


# ---------------------------------------------------------------- storage
#
# Two backends behind one interface.  LocalFile is a path on this machine;
# SshFile is a path on another one, reached with one ssh round trip per
# operation.  Both do the same thing: atomic replace, a rotated backup beside
# the file, and an mtime-based revision used for conflict detection.

class MountError(Exception):
    """A mount could not be resolved.  kind is one of:
    badpath | missing | unreachable | cycle | readonly | blocked"""

    def __init__(self, kind, message):
        Exception.__init__(self, message)
        self.kind = kind
        self.message = message


class Conflict(Exception):
    """The file changed underneath us; carries the revision now on disk."""

    def __init__(self, rev):
        Exception.__init__(self, "file changed on disk")
        self.rev = rev


def check_remote_path(raw, m):
    """host:path is remote only when the path is anchored with / or ~.

    Otherwise `notes:2024.md` - a perfectly ordinary local filename - would be
    read as a machine called "notes".  Anchor it, or write ./notes:2024.md."""
    if not m.group("path").startswith(("/", "~")):
        raise MountError(
            "badpath",
            "%s reads as host:path, but the path is not anchored - write "
            "%s:~/... or %s:/... for another machine, or ./%s for a local file "
            "with a colon in its name"
            % (raw, m.group("host"), m.group("host"), raw))


class LocalFile:
    kind = "local"

    def __init__(self, path, backups=True, keep=BACKUP_KEEP, ro=False):
        self.path = os.path.abspath(os.path.expanduser(path))
        self.backups = backups
        self.keep = keep
        self.ro = ro

    @property
    def display(self):
        return self.path

    def key(self):
        try:
            return "local:" + os.path.realpath(self.path)
        except OSError:
            return "local:" + self.path

    def describe(self):
        return {"kind": "local", "display": self.path, "ro": self.ro}

    def child(self, raw, allow_remote=True):
        if not raw.startswith(("/", "./", "../", "~")):
            m = SSH_TARGET_RE.match(raw)
            if m:
                check_remote_path(raw, m)
                if not allow_remote:
                    raise MountError("blocked", "remote mounts are off (--no-remote)")
                return SshFile(m.group("user"), m.group("host"), m.group("path"))
        return LocalFile(os.path.join(os.path.dirname(self.path),
                                      os.path.expanduser(raw)))

    def exists(self):
        return os.path.isfile(self.path)

    def rev(self):
        try:
            return str(os.stat(self.path).st_mtime_ns)
        except OSError:
            return "0"

    def read(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return f.read(), self.rev()
        except FileNotFoundError:
            raise MountError("missing", "%s does not exist" % self.path)
        except IsADirectoryError:
            raise MountError("badpath", "%s is a directory" % self.path)
        except OSError as e:
            raise MountError("unreachable", "%s: %s" % (self.path, e.strerror or e))

    def _backup(self):
        if not self.backups or not os.path.exists(self.path):
            return
        bdir = os.path.join(os.path.dirname(self.path), ".wellnoded-backups")
        os.makedirs(bdir, exist_ok=True)
        base = os.path.basename(self.path)
        dst = os.path.join(bdir, "%s.%s.bak"
                           % (base, datetime.now().strftime("%Y%m%d-%H%M%S")))
        if not os.path.exists(dst):
            with open(self.path, "rb") as a, open(dst, "wb") as b:
                b.write(a.read())
        old = sorted(x for x in os.listdir(bdir) if x.startswith(base + "."))
        for x in old[: max(0, len(old) - self.keep)]:
            try:
                os.remove(os.path.join(bdir, x))
            except OSError:
                pass

    def _atomic(self, text):
        tmp = self.path + ".tmp%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)
        return self.rev()

    def write(self, text, expect=None, force=False):
        if not force and expect is not None:
            cur = self.rev()
            if expect != cur:
                raise Conflict(cur)
        try:
            self._backup()
            return self._atomic(text)
        except OSError as e:
            raise MountError("unreachable", "%s: %s" % (self.path, e.strerror or e))

    def create(self, text):
        if os.path.exists(self.path):
            raise MountError("badpath", "%s already exists" % self.path)
        d = os.path.dirname(self.path)
        if d and not os.path.isdir(d):
            raise MountError("badpath", "no such directory: %s" % d)
        try:
            return self._atomic(text)
        except OSError as e:
            raise MountError("badpath", "%s: %s" % (self.path, e.strerror or e))


# The revision is mtime + size, at the finest resolution the remote's stat
# offers: GNU coreutils first (nanoseconds), BSD/macOS stat as the fallback.
# Seconds alone would not separate two writes of equal size in one second.
_STAT = ("stat -c '%.9Y.%s' -- \"$f\" 2>/dev/null || "
         "stat -f '%Fm.%z' -- \"$f\" 2>/dev/null")

_READ_SH = """
if [ ! -f "$f" ]; then printf '__WN_MISSING__\\n'; exit 0; fi
r=$(""" + _STAT + """) || r=0
printf '__WN_REV__%s\\n' "$r"
cat -- "$f"
"""

_WRITE_SH = """
if [ -f "$f" ]; then r=$(""" + _STAT + """) || r=0; else r=0; fi
if [ -n "$e" ] && [ "$e" != "$r" ]; then printf '__WN_CONFLICT__%s\\n' "$r"; exit 0; fi
base=$(basename -- "$f")
t="$f.wntmp$$"
cat > "$t" || { printf '__WN_ERR__cannot write a temp file next to it\\n'; exit 0; }
if [ -f "$f" ] && [ "$k" -gt 0 ]; then
  b=$(dirname -- "$f")/.wellnoded-backups
  mkdir -p "$b" 2>/dev/null
  cp -p -- "$f" "$b/$base.$(date +%Y%m%d-%H%M%S).bak" 2>/dev/null || :
  set -- "$b/$base".*.bak
  if [ -e "$1" ]; then
    n=$#
    if [ "$n" -gt "$k" ]; then
      i=0
      for x in "$@"; do
        i=$((i+1))
        if [ "$i" -le $((n-k)) ]; then rm -f -- "$x"; fi
      done
    fi
  fi
fi
mv -- "$t" "$f" || { rm -f -- "$t"; printf '__WN_ERR__cannot replace the file\\n'; exit 0; }
r=$(""" + _STAT + """) || r=0
printf '__WN_REV__%s\\n' "$r"
"""

_CREATE_SH = """
if [ -e "$f" ]; then printf '__WN_ERR__it already exists\\n'; exit 0; fi
d=$(dirname -- "$f")
if [ ! -d "$d" ]; then printf '__WN_ERR__no such directory: %s\\n' "$d"; exit 0; fi
cat > "$f" || { printf '__WN_ERR__cannot create it\\n'; exit 0; }
r=$(""" + _STAT + """) || r=0
printf '__WN_REV__%s\\n' "$r"
"""


class SshFile:
    kind = "ssh"

    def __init__(self, user, host, path, backups=True, keep=BACKUP_KEEP, ro=False):
        self.user = user or None
        self.host = host
        self.path = path
        self.backups = backups
        self.keep = keep
        self.ro = ro

    @property
    def target(self):
        return ("%s@%s" % (self.user, self.host)) if self.user else self.host

    @property
    def display(self):
        return "%s:%s" % (self.target, self.path)

    def key(self):
        return "ssh:%s:%s" % (self.target, posixpath.normpath(self.path))

    def describe(self):
        return {"kind": "ssh", "display": self.display, "host": self.target,
                "path": self.path, "ro": self.ro}

    def child(self, raw, allow_remote=True):
        if not allow_remote:
            raise MountError("blocked", "remote mounts are off (--no-remote)")
        if not raw.startswith(("/", "./", "../", "~")):
            m = SSH_TARGET_RE.match(raw)
            if m:
                check_remote_path(raw, m)
                return SshFile(m.group("user"), m.group("host"), m.group("path"))
        if raw.startswith(("/", "~")):
            return SshFile(self.user, self.host, raw)
        return SshFile(self.user, self.host,
                       posixpath.normpath(
                           posixpath.join(posixpath.dirname(self.path), raw)))

    # -- transport
    def _run(self, script, data=None):
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
               "-o", "ConnectTimeout=%d" % SSH_CONNECT_TIMEOUT,
               self.target, script]
        try:
            p = subprocess.run(cmd, input=(data or "").encode("utf-8"),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=SSH_TIMEOUT)
        except FileNotFoundError:
            raise MountError("unreachable", "ssh is not installed here")
        except subprocess.TimeoutExpired:
            raise MountError("unreachable", "%s did not answer within %ds"
                             % (self.target, SSH_TIMEOUT))
        if p.returncode != 0:
            err = p.stderr.decode("utf-8", "replace").strip().split("\n")
            raise MountError("unreachable",
                             (err[-1] if err and err[-1] else
                              "ssh to %s exited %d" % (self.target, p.returncode)))
        return p.stdout.decode("utf-8", "replace")

    def _script(self, body, **vars):
        head = "".join("%s=%s\n" % (k, shlex.quote(str(v)))
                       for k, v in [("f", self.path)] + sorted(vars.items()))
        return head + body

    def _answer(self, out):
        for ln in out.split("\n"):
            if ln.startswith("__WN_CONFLICT__"):
                raise Conflict(ln[len("__WN_CONFLICT__"):].strip())
            if ln.startswith("__WN_ERR__"):
                raise MountError("badpath", "%s: %s"
                                 % (self.display, ln[len("__WN_ERR__"):].strip()))
            if ln.startswith("__WN_REV__"):
                return ln[len("__WN_REV__"):].strip()
        raise MountError("unreachable", "unexpected answer from %s" % self.target)

    def exists(self):
        try:
            self.read()
            return True
        except MountError as e:
            if e.kind == "missing":
                return False
            raise

    def rev(self):
        try:
            return self.read()[1]
        except MountError:
            return "0"

    def read(self):
        out = self._run(self._script(_READ_SH))
        first, _, rest = out.partition("\n")
        first = first.strip()
        if first == "__WN_MISSING__":
            raise MountError("missing", "%s does not exist" % self.display)
        if first.startswith("__WN_REV__"):
            return rest, first[len("__WN_REV__"):].strip()
        raise MountError("unreachable", "unexpected answer from %s" % self.target)

    def write(self, text, expect=None, force=False):
        out = self._run(self._script(_WRITE_SH,
                                     e=("" if (force or expect is None) else expect),
                                     k=(self.keep if self.backups else 0)),
                        text)
        return self._answer(out)

    def create(self, text):
        return self._answer(self._run(self._script(_CREATE_SH), text))


class Doc:
    """parse/serialize on top of a file reference."""

    def __init__(self, ref):
        self.ref = ref

    @property
    def path(self):
        return self.ref.display

    def rev(self):
        return self.ref.rev()

    def load(self):
        text, rev = self.ref.read()
        return normalize(parse(text)), rev

    def save(self, doc, expect=None, force=False):
        if self.ref.ro:
            raise MountError("readonly", "%s is mounted read-only" % self.ref.display)
        return self.ref.write(serialize(normalize(doc)), expect, force)


def make_ref(raw, parent_ref, allow_remote=True):
    """'?host:~/x.md' seen inside parent_ref -> a file reference."""
    raw = (raw or "").strip()
    ro = raw.startswith("?")
    if ro:
        raw = raw[1:].strip()
    if not raw:
        raise MountError("badpath", "empty mount target")
    ref = parent_ref.child(raw, allow_remote)
    ref.ro = ro
    ref.backups = getattr(parent_ref, "backups", True)
    return ref


def resolve_ref(root_ref, path, allow_remote=True, cache=None):
    """A dotted mount path ('a7k.b2m') -> the file it names.

    Walks the chain, reading each intermediate file to find the next pointer.
    Read-only is inherited downwards, and a target already open further up the
    chain is refused rather than followed."""
    segs = [s for s in (path or "").split(".") if s]
    if not segs:
        return root_ref
    ref = root_ref
    ro = bool(getattr(root_ref, "ro", False))
    chain = [ref.key()]
    cache = {} if cache is None else cache
    for seg in segs:
        k = ref.key()
        if k not in cache:
            cache[k] = normalize(parse(ref.read()[0]))
        node = find_node(cache[k], seg)
        if node is None:
            raise MountError("badpath", "no node ^%s in %s" % (seg, ref.display))
        if not node.get("mount"):
            raise MountError("badpath", "^%s is not a mount" % seg)
        ref = make_ref(node["mount"]["raw"], ref, allow_remote)
        if ref.key() in chain:
            raise MountError("cycle", "%s is already open higher up this chain"
                             % ref.display)
        chain.append(ref.key())
        ro = ro or ref.ro
    ref.ro = ro
    return ref


def annotate(doc, ref, allow_remote=True):
    """Fill in each mount node's resolved target, without touching the network."""
    def walk(nodes):
        for n in nodes:
            m = n.get("mount")
            if m:
                try:
                    info = make_ref(m["raw"], ref, allow_remote).describe()
                except MountError as e:
                    info = {"kind": "bad", "display": m["raw"], "ro": True,
                            "error": e.message, "errkind": e.kind,
                            "host": None, "path": None}
                info["raw"] = m["raw"]
                n["mount"] = info
            else:
                walk(n.get("children") or [])
    walk(doc.get("children") or [])
    return doc


def open_root(path, backups=True):
    ref = LocalFile(path, backups=backups)
    if not ref.exists():
        ref.create(SAMPLE)
        sys.stderr.write("created %s with sample content\n" % ref.path)
    return Doc(ref)


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


def flatten(doc, ref, allow_remote=True, chain=None, prefix=""):
    """Resolve every mount into one tree, the way an export wants it.

    Ids become the same dotted paths the editor uses for permalinks, so a link
    copied from the editor still works inside the exported html.  A mount that
    cannot be read stays as a childless node carrying `mount_error` - one dead
    machine costs you that subtree, not the whole export."""
    chain = chain or [ref.key()]

    def walk(nodes, ref, chain, prefix):
        out = []
        for n in nodes:
            m = dict(n)
            m["id"] = prefix + n["id"]
            mount = n.get("mount")
            if not mount:
                m["children"] = walk(n.get("children") or [], ref, chain, prefix)
                out.append(m)
                continue
            m["children"] = []
            try:
                sub = make_ref(mount.get("raw"), ref, allow_remote)
                if sub.key() in chain:
                    raise MountError("cycle", "%s is already open higher up"
                                     % sub.display)
                m["mount"] = sub.describe()
                m["mount"]["raw"] = mount.get("raw")
                sdoc, _ = Doc(sub).load()
                m["child_style"] = sdoc.get("child_style") or "bullet"
                m["children"] = walk(sdoc.get("children") or [], sub,
                                     chain + [sub.key()], m["id"] + ".")
                if not (m.get("title") or "").strip():
                    m["title"] = doc_title(sdoc, sub.display)
            except MountError as e:
                m["mount"] = dict(mount)
                m["mount_error"] = e.message
                if not (m.get("title") or "").strip():
                    m["title"] = mount.get("raw") or "?"
                sys.stderr.write("export: skipping %s (%s)\n"
                                 % (mount.get("raw"), e.message))
            out.append(m)
        return out

    return {"header": doc.get("header") or [],
            "child_style": doc.get("child_style") or "bullet",
            "children": walk(doc.get("children") or [], ref, chain, prefix)}


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
    store = None              # the root Doc; every mount hangs off its ref
    allow_remote = True

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

    def _q(self, name, default=None):
        return parse_qs(urlparse(self.path).query).get(name, [default])[0]

    def _resolve(self, path):
        return resolve_ref(self.store.ref, path, self.allow_remote)

    def _mounterr(self, e):
        code = {"missing": 404, "badpath": 404, "cycle": 508,
                "readonly": 403, "blocked": 403}.get(e.kind, 502)
        return self._json(code, {"error": e.message, "kind": e.kind})

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
            want = self._q("path", "") or ""
            try:
                ref = self._resolve(want)
                doc, rev = Doc(ref).load()
            except MountError as e:
                return self._mounterr(e)
            annotate(doc, ref, self.allow_remote)
            return self._json(200, {"rev": rev, "doc": doc, "path": want,
                                    "file": ref.display, "ro": bool(ref.ro),
                                    "title": doc_title(doc, ref.display)})
        if p == "/api/export":
            doc, _ = self.store.load()
            doc = flatten(doc, self.store.ref, self.allow_remote)
            title, root = doc_title(doc, self.store.path), None
            want = self._q("root")
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

    def _payload(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    def do_PUT(self):
        p = urlparse(self.path).path
        if p == "/api/create":
            return self.do_create()
        if p != "/api/doc":
            return self._send(404, "not found", "text/plain; charset=utf-8")
        try:
            payload = self._payload()
        except Exception as e:
            return self._json(400, {"error": "bad payload: %s" % e})

        want = self._q("path", "") or ""
        try:
            ref = self._resolve(want)
        except MountError as e:
            return self._mounterr(e)
        if ref.ro:
            return self._json(403, {"error": "%s is mounted read-only" % ref.display,
                                    "kind": "readonly"})
        # A mounted file is only ever written with the revision it was loaded
        # at.  Without that rule a mount that failed to load could be "saved"
        # as the empty tree the browser is showing, wiping the other file.
        if want and payload.get("rev") in (None, "") and not payload.get("force"):
            return self._json(400, {"error": "refusing to write %s without the "
                                             "revision it was loaded at" % ref.display,
                                    "kind": "norev"})
        try:
            rev = Doc(ref).save(payload.get("doc") or {},
                                payload.get("rev"), bool(payload.get("force")))
        except Conflict:
            try:
                doc, rev = Doc(ref).load()
            except MountError as e:
                return self._mounterr(e)
            annotate(doc, ref, self.allow_remote)
            return self._json(409, {"error": "file changed on disk", "rev": rev,
                                    "doc": doc, "file": ref.display, "path": want})
        except MountError as e:
            return self._mounterr(e)
        except Exception as e:
            return self._json(500, {"error": str(e)})
        return self._json(200, {"rev": rev, "path": want})

    def do_create(self):
        """Create the file a mount points at.  Never implicit: a mistyped path
        stays a mistyped path until you ask for this."""
        want = self._q("path", "") or ""
        if not want:
            return self._json(400, {"error": "no mount path given"})
        try:
            ref = self._resolve(want)
            if ref.ro:
                return self._json(403, {"error": "%s is mounted read-only"
                                        % ref.display, "kind": "readonly"})
            base = os.path.basename(ref.path).rsplit(".", 1)[0]
            rev = ref.create("# %s\n" % (base or "notes"))
        except MountError as e:
            return self._mounterr(e)
        sys.stderr.write("created %s\n" % ref.display)
        return self._json(200, {"rev": rev, "file": ref.display})

    def do_POST(self):
        self.do_PUT()


def doc_title(doc, path):
    for line in doc.get("header") or []:
        m = re.match(r"^#\s+(.*\S)", line)
        if m:
            return m.group(1)
    return os.path.splitext(os.path.basename(path))[0]


def default_file():
    """Running wellnoded inside a project should just find that project's file."""
    for c in ("TODO.wellnoded", "data.md"):
        if os.path.isfile(c):
            return c
    return "data.md"


def main():
    ap = argparse.ArgumentParser(description="wellnoded outliner server")
    ap.add_argument("--file", "-f",
                    default=os.environ.get("WELLNODED_FILE") or default_file())
    ap.add_argument("--port", "-p", type=int,
                    default=int(os.environ.get("WELLNODED_PORT", 8722)))
    ap.add_argument("--host", default=os.environ.get("WELLNODED_HOST", "127.0.0.1"),
                    help="use 0.0.0.0 to reach it over a VPN/LAN")
    ap.add_argument("--no-backups", action="store_true")
    ap.add_argument("--no-remote", action="store_true",
                    help="refuse host:path mounts; local files only")
    ap.add_argument("--export", metavar="OUT",
                    help="write a read-only html export and exit")
    ap.add_argument("--export-root", metavar="ID",
                    help="with --export, export only the subtree under node ID "
                         "(a dotted path like a7k.b2m for a node inside a mount)")
    args = ap.parse_args()

    store = open_root(args.file, backups=not args.no_backups)
    Handler.allow_remote = not args.no_remote

    if args.export:
        doc, _ = store.load()
        doc = flatten(doc, store.ref, not args.no_remote)
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
    if args.no_remote:
        print("           remote mounts: off")
    print("           open: http://%s:%d/" %
          ("localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host, args.port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    sys.exit(main())
