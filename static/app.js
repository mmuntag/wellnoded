/* wellnoded - editor front end

   One browser page shows one *tree*, but that tree can span several files.
   The file you opened is document ""; every mount underneath it is another
   document, keyed by the dotted path of mount ids that leads to it ("m01",
   "m01.a03", ...).  A node is addressed the same way: uid = docKey + "." + id,
   so uids are unique across files and double as permalinks.                 */
(function () {
  "use strict";
  var R = window.WNRender;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    docs: {},                   // docKey -> entry (see loadDoc); "" is the root
    zoom: null,                 // uid we are zoomed into
    editing: null,              // {uid, field}
    collapsed: load("wn.collapsed", []),
    hideDone: load("wn.hideDone", false),
    saving: 0, lastErr: null,
    undo: [], redo: []
  };
  var collapsed = new Set(state.collapsed);

  function load(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ------------------------------------------------------------ address */
  function docKeyOf(uid) { var i = uid.lastIndexOf("."); return i < 0 ? "" : uid.slice(0, i); }
  function localId(uid) { var i = uid.lastIndexOf("."); return i < 0 ? uid : uid.slice(i + 1); }
  function uidOf(key, id) { return key ? key + "." + id : id; }
  function docOf(key) { return state.docs[key]; }
  function isOpen(key) { var e = state.docs[key]; return !!(e && e.loaded); }
  function fileOf(key) {
    var e = state.docs[key];
    return (e && e.file) || (key ? key : "this file");
  }

  /* -------------------------------------------------------------- model */
  function find(uid) {
    if (!uid) return null;
    var key = docKeyOf(uid), id = localId(uid), e = state.docs[key];
    if (!e || !e.doc) return null;
    var hit = null;
    (function rec(nodes, parent) {
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].id === id) {
          hit = { node: nodes[i], parent: parent, index: i, key: key, uid: uid };
          return true;
        }
        if (!nodes[i].mount && rec(nodes[i].children, nodes[i])) return true;
      }
      return false;
    })(e.doc.children, null);
    return hit;
  }
  function siblingsOf(hit) {
    return hit.parent ? hit.parent.children : state.docs[hit.key].doc.children;
  }

  /* Children of the thing at `uid`.  For a mount node they come from the file
     it points at, which is a different document with its own key == uid. */
  function childList(node, uid) {
    if (node && node.mount) {
      var e = state.docs[uid];
      return (e && e.loaded && e.doc) ? e.doc.children : [];
    }
    if (node) return node.children;
    var r = state.docs[""];
    return r && r.doc ? r.doc.children : [];
  }
  function childStyle(node, uid) {
    if (node && node.mount) {
      var e = state.docs[uid];
      return (e && e.loaded && e.doc && e.doc.child_style) || "bullet";
    }
    if (node) return node.child_style;
    var r = state.docs[""];
    return (r && r.doc && r.doc.child_style) || "bullet";
  }
  /* The document a node's *children* are written to.  At the root of the
     whole tree (no node, no uid) that is the file you opened, "". */
  function childKey(node, uid) {
    return node && node.mount ? uid : docKeyOf(uid || "");
  }

  function visibleChildren(node, uid) {
    var k = childList(node, uid);
    return state.hideDone ? k.filter(function (n) { return !n.done; }) : k;
  }

  function pathTo(uid) {
    /* [{node, uid}] from the root of the whole tree down to uid, crossing
       mount boundaries. */
    var out = [], segs = uid.split("."), key = "";
    for (var i = 0; i < segs.length; i++) {
      var here = key ? key + "." + segs[i] : segs[i];
      var e = state.docs[key];
      if (!e || !e.doc) return out;
      var chain = [];
      (function rec(nodes, acc) {
        for (var j = 0; j < nodes.length; j++) {
          var nx = acc.concat([nodes[j]]);
          if (nodes[j].id === segs[i]) { chain = nx; return true; }
          if (!nodes[j].mount && rec(nodes[j].children, nx)) return true;
        }
        return false;
      })(e.doc.children, []);
      if (!chain.length) return out;
      chain.forEach(function (n) { out.push({ node: n, uid: uidOf(key, n.id) }); });
      key = here;
    }
    return out;
  }

  function newId(key) {
    var e = state.docs[key], used = {};
    if (e && e.doc) (function rec(ns) {
      ns.forEach(function (n) { used[n.id] = 1; if (!n.mount) rec(n.children); });
    })(e.doc.children);
    var a = "0123456789abcdefghijklmnopqrstuvwxyz", id;
    do {
      id = a[(Math.random() * 36) | 0] + a[(Math.random() * 36) | 0] +
           a[(Math.random() * 36) | 0];
    } while (used[id]);
    return id;
  }
  function blank(key) {
    return { id: newId(key), title: "", body: "", done: false,
             mount: null, child_style: "bullet", children: [] };
  }

  function mountLabel(n, uid) {
    if (n.title && n.title.trim()) return null;
    var e = state.docs[uid];
    if (e && e.title) return e.title;
    var d = (n.mount && (n.mount.display || n.mount.raw)) || "";
    return d.replace(/^\?/, "").split("/").pop() || d;
  }

  /* ------------------------------------------------------- loading docs */
  /* Forget a document and everything mounted underneath it. */
  function dropDocs(prefix) {
    Object.keys(state.docs).forEach(function (k) {
      if (k === prefix || k.indexOf(prefix + ".") === 0) delete state.docs[k];
    });
  }
  /* After a file is (re)loaded, some of the mounts it used to declare may be
     gone.  Their documents would otherwise linger and be saved to a path the
     server can no longer resolve. */
  function pruneDocs() {
    Object.keys(state.docs).forEach(function (k) {
      if (!k) return;
      var parent = state.docs[docKeyOf(k)];
      if (!parent || !parent.loaded) return;
      var hit = find(k);
      if (!hit || !hit.node.mount) dropDocs(k);
    });
  }

  function newEntry(key) {
    return { path: key, doc: null, rev: null, file: null, title: "",
             ro: false, loaded: false, loading: null, error: null,
             errkind: null, dirty: false, clean: null };
  }

  function loadDoc(key, force) {
    var e = state.docs[key] || (state.docs[key] = newEntry(key));
    if (e.loading) return e.loading;
    if (e.loaded && !force) return Promise.resolve(e);
    e.loading = fetch("/api/doc?path=" + encodeURIComponent(key))
      .then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      })
      .then(function (res) {
        e.loading = null;
        if (!res.ok) {
          e.loaded = false; e.doc = null;
          e.error = res.j.error || "could not be loaded";
          e.errkind = res.j.kind || "error";
        } else {
          e.doc = res.j.doc; e.rev = res.j.rev; e.file = res.j.file;
          e.ro = !!res.j.ro; e.title = res.j.title || "";
          e.clean = JSON.stringify(res.j.doc);
          e.loaded = true; e.dirty = false; e.error = null; e.errkind = null;
          pruneDocs();
        }
        render(); setStatus();
        return e;
      })
      .catch(function (err) {
        e.loading = null; e.loaded = false;
        e.error = err.message; e.errkind = "error";
        render(); return e;
      });
    render();
    return e.loading;
  }

  /* Every document on the way down to uid, in order. */
  function ensureChain(uid) {
    var segs = (uid || "").split(".").filter(Boolean);
    var p = Promise.resolve(), acc = "";
    for (var i = 0; i < segs.length - 1; i++) {
      acc = acc ? acc + "." + segs[i] : segs[i];
      p = p.then((function (k) { return function () { return loadDoc(k); }; })(acc));
    }
    return p;
  }

  function createMountFile(uid) {
    var hit = find(uid); if (!hit) return;
    var e = state.docs[uid];
    var where = (e && e.error) || (hit.node.mount && hit.node.mount.display) || uid;
    if (!confirm("Create this file?\n\n" + (hit.node.mount.display || hit.node.mount.raw)))
      return;
    fetch("/api/create?path=" + encodeURIComponent(uid), { method: "POST" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) return toast(res.j.error || "could not create it");
        toast("created " + res.j.file);
        loadDoc(uid, true);
      });
  }

  /* -------------------------------------------------------- undo stack
     One entry covers every open document, so an edit that touched more than
     one file still undoes in a single step.                              */
  function snapshot() {
    var snap = {};
    Object.keys(state.docs).forEach(function (k) {
      var e = state.docs[k];
      if (e.loaded && !e.ro) snap[k] = JSON.stringify(e.doc);
    });
    state.undo.push(snap);
    if (state.undo.length > 120) state.undo.shift();
    state.redo.length = 0;
  }
  function capture(shape) {
    var cur = {};
    Object.keys(shape).forEach(function (k) {
      var e = state.docs[k];
      if (e && e.loaded) cur[k] = JSON.stringify(e.doc);
    });
    return cur;
  }
  function apply(snap) {
    Object.keys(snap).forEach(function (k) {
      var e = state.docs[k];
      if (e && e.loaded && !e.ro) { e.doc = JSON.parse(snap[k]); e.dirty = true; }
    });
  }
  function undo() {
    if (!state.undo.length) return toast("nothing to undo");
    var snap = state.undo.pop();
    state.redo.push(capture(snap));
    apply(snap);
    state.editing = null; render(); save(true);
  }
  function redo() {
    if (!state.redo.length) return toast("nothing to redo");
    var snap = state.redo.pop();
    state.undo.push(capture(snap));
    apply(snap);
    state.editing = null; render(); save(true);
  }

  /* -------------------------------------------------------- persistence
     Same cadence as before - structural edits flush at 250 ms, typing at
     1.2 s, anything dirty is forced out every 10 s - but now each file is
     its own unit, with its own revision and its own conflict.            */
  var TYPE_DEBOUNCE = 1200, STRUCT_DEBOUNCE = 250, MAX_WAIT = 10000;
  var timer = null, firstDirty = 0, inflight = null;

  function markDirty(structural, key) {
    if (key == null) {
      Object.keys(state.docs).forEach(function (k) {
        if (state.docs[k].loaded && !state.docs[k].ro) state.docs[k].dirty = true;
      });
    } else if (state.docs[key] && state.docs[key].loaded) {
      state.docs[key].dirty = true;
    }
    if (!firstDirty) firstDirty = Date.now();
    setStatus();
    var wait = structural ? STRUCT_DEBOUNCE : TYPE_DEBOUNCE;
    if (Date.now() - firstDirty > MAX_WAIT) wait = 0;
    clearTimeout(timer);
    timer = setTimeout(function () { save(); }, wait);
  }

  /* Documents that are dirty *and* genuinely differ from what was loaded.
     Comparing against `clean` means an undo back to the saved state, or a
     sloppy markDirty, never rewrites a file for nothing. */
  function pending() {
    return Object.keys(state.docs).filter(function (k) {
      var e = state.docs[k];
      if (!e.loaded || !e.dirty) return false;
      if (e.ro) { e.dirty = false; return false; }
      if (JSON.stringify(e.doc) === e.clean) { e.dirty = false; return false; }
      return true;
    });
  }

  function save(force) {
    clearTimeout(timer);
    if (inflight) {
      return inflight.then(function () { return save(force); },
                           function () { return save(force); });
    }
    var keys = pending();
    if (!keys.length) { firstDirty = 0; setStatus(); return Promise.resolve(); }
    state.saving = keys.length; setStatus();
    inflight = Promise.all(keys.map(saveOne)).then(function () {
      inflight = null; state.saving = 0;
      if (!pending().length) { firstDirty = 0; state.lastErr = null; }
      setStatus();
    }, function (err) {
      inflight = null; state.saving = 0;
      state.lastErr = err.message; setStatus();
      timer = setTimeout(function () { save(); }, 4000);
    });
    return inflight;
  }

  function saveOne(key) {
    var e = state.docs[key];
    var snap = JSON.stringify(e.doc);
    return fetch("/api/doc?path=" + encodeURIComponent(key), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev: e.rev, doc: e.doc })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, code: r.status, j: j }; });
    }).then(function (res) {
      if (res.code === 409) return conflict(e, res.j, snap);
      if (!res.ok) throw new Error(short(fileOf(key)) + ": " +
                                   (res.j.error || ("HTTP " + res.code)));
      settle(e, res.j.rev, snap);
    });
  }

  function settle(e, rev, snap) {
    e.rev = rev; e.clean = snap;
    e.dirty = JSON.stringify(e.doc) !== snap;   // more typing while it flew
  }

  function conflict(e, j, snap) {
    state.lastErr = "conflict"; setStatus();
    if (confirm(short(e.file || j.file) + " was changed on disk by something else.\n\n" +
                "OK  = discard those changes and keep what is on screen\n" +
                "Cancel = reload that file (your unsaved edits to it are lost)")) {
      return fetch("/api/doc?path=" + encodeURIComponent(e.path), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: j.rev, doc: e.doc, force: true })
      }).then(function (r) { return r.json(); }).then(function (k) {
        settle(e, k.rev, snap);
        state.lastErr = null; setStatus();
      });
    }
    e.doc = j.doc; e.rev = j.rev; e.clean = JSON.stringify(j.doc);
    e.dirty = false; state.lastErr = null;
    state.editing = null;
    pruneDocs();
    render(); setStatus();
  }

  function short(p) {
    if (!p) return "the file";
    var parts = String(p).split("/");
    return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : String(p);
  }

  function setStatus() {
    var el = $("status"), n = pending().length;
    el.className = "status";
    if (state.lastErr) {
      el.className += " err"; el.textContent = "unsaved!"; el.title = state.lastErr; return;
    }
    if (state.saving) {
      el.textContent = state.saving > 1 ? "saving " + state.saving : "saving"; return;
    }
    if (n) {
      el.className += " dirty";
      el.textContent = n > 1 ? "● " + n : "●";
      el.title = "unsaved changes in " + Object.keys(state.docs)
        .filter(function (k) { return state.docs[k].dirty; })
        .map(function (k) { return fileOf(k); }).join(", ");
      return;
    }
    el.textContent = "saved";
    el.title = Object.keys(state.docs).filter(isOpen)
      .map(function (k) { return fileOf(k); }).join("\n");
  }

  window.addEventListener("beforeunload", function (e) {
    commitEdit(true);
    var keys = pending();
    keys.forEach(function (k) {
      var d = state.docs[k];
      try {
        navigator.sendBeacon("/api/doc?path=" + encodeURIComponent(k), new Blob(
          [JSON.stringify({ rev: d.rev, doc: d.doc })], { type: "application/json" }));
      } catch (err) {}
    });
    if (keys.length && state.lastErr) { e.preventDefault(); e.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { commitEdit(true); save(); }
  });

  /* ------------------------------------------------------------ render */
  function render() {
    var rootEntry = state.docs[""];
    if (!rootEntry || !rootEntry.doc) return;

    var rootHit = state.zoom ? find(state.zoom) : null;
    if (state.zoom && !rootHit && !(state.docs[docKeyOf(state.zoom)] || {}).loading) {
      state.zoom = null; syncHash();
    }
    var root = rootHit ? rootHit.node : null;
    var rootUid = rootHit ? state.zoom : null;

    renderCrumbs(rootUid);

    var dt = $("doctitle"), zn = $("zoomnote");
    if (root) {
      var lbl = mountLabel(root, rootUid);
      dt.innerHTML = R.renderInline(root.title) ||
        (lbl ? "<span style='color:var(--dim)'>" + R.esc(lbl) + "</span>"
             : "<span style='color:var(--faint)'>untitled</span>");
      dt.className = "doctitle" + (root.done ? " struck" : "");
      dt.style.textDecoration = root.done ? "line-through" : "";
      dt.onclick = function () { startEdit(rootUid, "title"); };
      dt.style.cursor = "text";
      dt.style.display = "";
      zn.innerHTML = "";
      if (root.body.trim()) { zn.innerHTML = R.renderBody(root.body); zn.style.color = "var(--dim)"; }
      if (root.mount) zn.appendChild(mountNote(root, rootUid));
      document.title = (R.plain(root.title) || lbl || "untitled") + " - wellnoded";
    } else {
      var h = (rootEntry.doc.header || []).join("\n");
      var m = /^#\s+(.*)$/m.exec(h);
      dt.innerHTML = m ? R.renderInline(m[1]) : "";
      dt.onclick = null; dt.style.cursor = "";
      dt.style.display = m ? "" : "none";
      zn.innerHTML = "";
      document.title = (m ? R.plain(m[1]) + " - " : "") + "wellnoded";
    }

    var host = $("tree");
    host.innerHTML = "";
    var kids = visibleChildren(root, rootUid);
    var ckey = childKey(root, rootUid);
    if (!kids.length) {
      host.appendChild(emptyEl(root, rootUid, ckey));
    } else {
      var style = childStyle(root, rootUid);
      kids.forEach(function (n, i) {
        host.appendChild(nodeEl(n, uidOf(ckey, n.id), i + 1, style));
      });
    }
    $("export").title = state.zoom
      ? "Download a read-only html copy of this subtree"
      : "Download a read-only html copy";
    $("hide").className = "btn" + (state.hideDone ? " on" : "");
    $("up").disabled = !state.zoom;
    $("home").disabled = !state.zoom;
    restoreEditor();
  }

  function emptyEl(root, rootUid, ckey) {
    var e = document.createElement("div");
    e.className = "empty";
    var entry = state.docs[ckey];
    if (root && root.mount && entry && entry.loading) {
      e.textContent = "loading " + (root.mount.display || root.mount.raw) + "…";
      return e;
    }
    var err = root && root.mount ? mountErr(root, rootUid) : null;
    if (err) {
      e.className = "empty err";
      e.textContent = err.msg;
      return e;
    }
    if (entry && entry.ro) { e.textContent = "empty (read-only)"; return e; }
    var all = childList(root, rootUid);
    e.textContent = state.hideDone && all.length
      ? "everything here is done (hide done is on)"
      : "empty - click here to start";
    e.onclick = function () { addChild(rootUid); };
    return e;
  }

  function renderCrumbs(rootUid) {
    var c = $("crumbs");
    c.innerHTML = "";
    function add(label, uid, isLast) {
      if (c.children.length) {
        var s = document.createElement("span");
        s.className = "sep"; s.textContent = "›"; c.appendChild(s);
      }
      var a = document.createElement("a");
      a.textContent = label;
      if (isLast) { a.style.color = "var(--ink)"; a.style.cursor = "default"; }
      else a.onclick = function () { zoomTo(uid); };
      c.appendChild(a);
    }
    var hm = /^#\s+(.*)$/m.exec(((state.docs[""].doc.header) || []).join("\n"));
    add(hm ? R.plain(hm[1]) : "home", null, !rootUid);
    if (rootUid) {
      var path = pathTo(rootUid);
      path.forEach(function (p, i) {
        add(R.plain(p.node.title) || mountLabel(p.node, p.uid) || "untitled",
            p.uid, i === path.length - 1);
      });
    }
  }

  function mountErr(n, uid) {
    var e = state.docs[uid];
    if (e && e.error) return { msg: e.error, kind: e.errkind };
    if (n.mount && n.mount.error) return { msg: n.mount.error, kind: n.mount.errkind };
    return null;
  }

  function mountNote(n, uid) {
    /* the little "→ path" chip that says where a mount's children come from */
    var e = state.docs[uid], err = mountErr(n, uid);
    var s = document.createElement("span");
    s.className = "mpath" + (err ? " err" : "");
    var where = (e && e.file) || (n.mount.display || n.mount.raw);
    s.textContent = (n.mount.ro ? "○ " : "→ ") + short(where);
    s.title = where + (n.mount.ro ? "  (read-only)" : "") +
              (err ? "\n" + err.msg : "");
    return s;
  }

  function nodeEl(n, uid, index, style) {
    var el = document.createElement("div");
    var entry = n.mount ? state.docs[uid] : null;
    var err = n.mount ? mountErr(n, uid) : null;
    var open = n.mount ? !!(entry && entry.loaded && !collapsed.has(uid))
                       : !collapsed.has(uid);
    el.className = "node" + (n.done ? " done" : "") + (open ? "" : " collapsed") +
                   (n.mount ? " mount" : "") +
                   (n.mount && n.mount.ro ? " ro" : "") +
                   (err ? " broken" : "") +
                   (entry && entry.loading ? " loading" : "");
    el.dataset.id = uid;

    var row = document.createElement("div");
    row.className = "row";

    var kids = open ? visibleChildren(n, uid) : [];
    var tw = document.createElement("span");
    var hasTwist = n.mount || childList(n, uid).length;
    tw.className = "twist" + (hasTwist ? "" : " none");
    tw.textContent = hasTwist ? "▼" : "";
    if (hasTwist) tw.onclick = function (e) { e.stopPropagation(); toggleCollapse(n, uid); };
    row.appendChild(tw);

    var b;
    if (style === "ordered") {
      b = document.createElement("span");
      b.className = "num"; b.textContent = index + ".";
    } else {
      b = document.createElement("span");
      b.className = "bullet"; b.innerHTML = "<i></i>";
    }
    b.title = n.mount ? "zoom into this file" : "zoom in";
    b.onclick = function (e) { e.stopPropagation(); zoomTo(uid); };
    row.appendChild(b);

    var content = document.createElement("div");
    content.className = "content";
    var t = document.createElement("div");
    t.className = "title";
    var lbl = n.mount ? mountLabel(n, uid) : null;
    t.innerHTML = R.renderInline(n.title) ||
                  (lbl ? "<span class='fallback'>" + R.esc(lbl) + "</span>" : "");
    if (n.mount) t.appendChild(mountNote(n, uid));
    if (!open && childList(n, uid).length) {
      var cc = document.createElement("span");
      cc.className = "childcount"; cc.textContent = childList(n, uid).length;
      t.appendChild(cc);
    }
    t.onclick = function (e) {
      if (e.target.tagName === "A") return;
      startEdit(uid, "title", caretFromClick(e));
    };
    content.appendChild(t);
    if (n.body.trim()) {
      var bd = document.createElement("div");
      bd.className = "body";
      bd.innerHTML = R.renderBody(n.body);
      bd.onclick = function (e) {
        if (e.target.tagName === "A") return;
        startEdit(uid, "body");
      };
      content.appendChild(bd);
    }
    if (err) content.appendChild(brokenEl(uid, err));
    row.appendChild(content);

    var dots = document.createElement("button");
    dots.className = "dots"; dots.innerHTML = "⋯"; dots.title = "node menu";
    dots.onclick = function (e) { e.stopPropagation(); openMenu(n, uid, dots); };
    row.appendChild(dots);

    el.appendChild(row);

    var kidHost = document.createElement("div");
    kidHost.className = "kids";
    var ckey = childKey(n, uid), cstyle = childStyle(n, uid);
    kids.forEach(function (c, i) {
      kidHost.appendChild(nodeEl(c, uidOf(ckey, c.id), i + 1, cstyle));
    });
    el.appendChild(kidHost);
    return el;
  }

  function brokenEl(uid, err) {
    var d = document.createElement("div");
    d.className = "mounterr";
    d.appendChild(document.createTextNode(err.msg + " "));
    if (err.kind === "missing") {
      var a = document.createElement("a");
      a.textContent = "create it";
      a.onclick = function (e) { e.stopPropagation(); createMountFile(uid); };
      d.appendChild(a);
      d.appendChild(document.createTextNode("  "));
    }
    var r = document.createElement("a");
    r.textContent = "retry";
    r.onclick = function (e) { e.stopPropagation(); loadDoc(uid, true); };
    d.appendChild(r);
    return d;
  }

  function caretFromClick() { return null; }

  /* ------------------------------------------------------------ guards */
  function writable(key, quiet) {
    var e = state.docs[key];
    if (!e || !e.loaded) {
      if (!quiet) toast("that file is not open");
      return false;
    }
    if (e.ro) {
      if (!quiet) toast("read-only mount: " + short(e.file));
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------ editor */
  function startEdit(uid, field, caret) {
    if (state.editing && state.editing.uid === uid && state.editing.field === field) return;
    if (!writable(docKeyOf(uid))) return;
    commitEdit();
    state.editing = { uid: uid, field: field, caret: caret };
    if (state.zoom === uid) { renderZoomEditor(); return; }
    var el = document.querySelector('.node[data-id="' + uid + '"]');
    if (!el) { state.editing = null; return; }
    mountEditor(el, uid, field);
  }

  function renderZoomEditor() {
    var hit = find(state.editing.uid); if (!hit) return;
    var n = hit.node, dt = $("doctitle"), zn = $("zoomnote");
    dt.innerHTML = "";
    var box = document.createElement("div");
    box.className = "edit";
    var ta = mkTa("ta-title", n.title, "title");
    ta.style.font = "600 27px/1.25 var(--serif)";
    box.appendChild(ta);
    var tb = mkTa("ta-body", n.body, "body");
    tb.placeholder = "notes…";
    box.appendChild(tb);
    dt.appendChild(box);
    zn.innerHTML = "";
    wire(box, hit, ta, tb);
    (state.editing.field === "body" ? tb : ta).focus();
    autosize(ta); autosize(tb);
  }

  function mkTa(cls, val, name) {
    var ta = document.createElement("textarea");
    ta.className = cls; ta.value = val || ""; ta.rows = 1;
    ta.dataset.field = name; ta.spellcheck = true;
    return ta;
  }

  function mountEditor(el, uid, field) {
    var hit = find(uid); if (!hit) return;
    var n = hit.node;
    var row = el.querySelector(":scope > .row");
    row.classList.add("editing");
    var content = row.querySelector(".content");
    content.innerHTML = "";
    var box = document.createElement("div");
    box.className = "edit";
    var ta = mkTa("ta-title", n.title, "title");
    var tb = mkTa("ta-body", n.body, "body");
    tb.placeholder = "notes…";
    box.appendChild(ta); box.appendChild(tb);
    content.appendChild(box);
    if (n.mount) box.appendChild(mountNote(n, uid));
    wire(box, hit, ta, tb);
    var target = field === "body" ? tb : ta;
    target.focus();
    var c = state.editing && state.editing.caret;
    if (c === "end" || c == null) target.setSelectionRange(target.value.length, target.value.length);
    else target.setSelectionRange(c, c);
    autosize(ta); autosize(tb);
  }

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = (ta.scrollHeight) + "px";
  }

  function wire(box, hit, ta, tb) {
    var n = hit.node, uid = hit.uid;
    [ta, tb].forEach(function (x) {
      x.addEventListener("input", function () {
        autosize(x);
        n[x.dataset.field] = x.value;
        markDirty(false, hit.key);
      });
      x.addEventListener("focus", function () {
        if (state.editing) state.editing.field = x.dataset.field;
      });
    });
    ta.addEventListener("keydown", function (e) { titleKeys(e, n, uid, ta, tb); });
    tb.addEventListener("keydown", function (e) { bodyKeys(e, n, uid, ta, tb); });
    box.addEventListener("focusout", function () {
      setTimeout(function () {
        if (box.contains(document.activeElement)) return;
        if (state.editing && state.editing.uid === uid) commitEdit();
      }, 0);
    });
  }

  function commitEdit(quiet) {
    if (!state.editing) return;
    var uid = state.editing.uid;
    var el = document.querySelector('.node[data-id="' + uid + '"] .edit') ||
             document.querySelector("#doctitle .edit");
    if (el) {
      var hit = find(uid);
      if (hit) {
        var t = el.querySelector(".ta-title"), b = el.querySelector(".ta-body");
        if (t) hit.node.title = t.value;
        if (b) hit.node.body = b.value;
      }
    }
    state.editing = null;
    if (!quiet) render();
  }

  function restoreEditor() {
    if (!state.editing) return;
    var uid = state.editing.uid;
    if (state.zoom === uid) { renderZoomEditor(); return; }
    var el = document.querySelector('.node[data-id="' + uid + '"]');
    if (el) mountEditor(el, uid, state.editing.field);
    else state.editing = null;
  }

  /* ------------------------------------------------- structural actions */
  function flatVisible() {
    /* uids of everything on screen, in view order, crossing mounts */
    var out = [];
    var rootHit = state.zoom ? find(state.zoom) : null;
    var root = rootHit ? rootHit.node : null;
    (function rec(node, uid) {
      var ckey = childKey(node, uid);
      visibleChildren(node, uid).forEach(function (n) {
        var cu = uidOf(ckey, n.id);
        out.push(cu);
        var open = n.mount ? isOpen(cu) && !collapsed.has(cu) : !collapsed.has(cu);
        if (open) rec(n, cu);
      });
    })(root, state.zoom);
    return out;
  }

  function addSibling(uid, where) {
    var hit = find(uid); if (!hit || !writable(hit.key)) return;
    var n = hit.node;
    /* Enter on an open mount makes the first child inside the other file */
    if (n.mount && where !== "before" && isOpen(uid) && !collapsed.has(uid)) {
      return addChild(uid, true);
    }
    snapshot();
    var fresh = blank(hit.key);
    var sibs = siblingsOf(hit);
    if (!n.mount && !collapsed.has(uid) && n.children.length && where !== "before") {
      n.children.unshift(fresh);
    } else {
      sibs.splice(hit.index + (where === "before" ? 0 : 1), 0, fresh);
    }
    state.editing = { uid: uidOf(hit.key, fresh.id), field: "title" };
    markDirty(true, hit.key); render();
  }

  function addChild(parentUid, first) {
    var key, list;
    if (parentUid == null) {
      key = ""; list = state.docs[""].doc.children;
    } else {
      var hit = find(parentUid); if (!hit) return;
      if (hit.node.mount) {
        if (!isOpen(parentUid)) {
          return loadDoc(parentUid).then(function () { addChild(parentUid, first); });
        }
        key = parentUid; list = state.docs[parentUid].doc.children;
      } else {
        key = hit.key; list = hit.node.children;
      }
    }
    if (!writable(key)) return;
    snapshot();
    var fresh = blank(key);
    if (first) list.unshift(fresh); else list.push(fresh);
    if (parentUid) { collapsed.delete(parentUid); persistCollapsed(); }
    state.editing = { uid: uidOf(key, fresh.id), field: "title" };
    markDirty(true, key); render();
  }

  function removeNode(uid, silent) {
    var hit = find(uid); if (!hit || !writable(hit.key)) return;
    var n = hit.node;
    if (n.mount) {
      if (!silent && !confirm("Remove the link to " +
            (n.mount.display || n.mount.raw) + "?\n\n" +
            "Only the pointer goes; the file itself is left alone."))
        return;
    } else if (!silent && (n.children.length || n.title.trim().length > 40) &&
        !confirm("Delete “" + (R.plain(n.title) || "untitled") + "”" +
                 (n.children.length ? " and its " + n.children.length + " child node(s)" : "") + "?")) {
      return;
    }
    snapshot();
    siblingsOf(hit).splice(hit.index, 1);
    dropDocs(uid);
    if (state.zoom === uid) {
      var p = pathTo(uid);
      state.zoom = p.length > 1 ? p[p.length - 2].uid : null;
      syncHash();
    }
    state.editing = null;
    markDirty(true, hit.key); render();
  }

  function indent(uid) {
    var hit = find(uid); if (!hit || hit.index === 0 || !writable(hit.key)) return;
    var prev = siblingsOf(hit)[hit.index - 1];
    if (prev.mount) {
      return toast("that would move it into " +
                   short(prev.mount.display || prev.mount.raw) +
                   " - use its menu to add a node there instead");
    }
    snapshot();
    siblingsOf(hit).splice(hit.index, 1);
    prev.children.push(hit.node);
    collapsed.delete(uidOf(hit.key, prev.id)); persistCollapsed();
    markDirty(true, hit.key); render();
  }

  function outdent(uid) {
    var hit = find(uid); if (!hit || !writable(hit.key)) return;
    if (!hit.parent) {
      if (hit.key) toast("this is already the top of " + short(fileOf(hit.key)));
      return;
    }
    var gp = find(uidOf(hit.key, hit.parent.id));
    snapshot();
    hit.parent.children.splice(hit.index, 1);
    var target = gp && gp.parent ? gp.parent.children : state.docs[hit.key].doc.children;
    var at = gp ? gp.index + 1 : target.length;
    target.splice(at, 0, hit.node);
    markDirty(true, hit.key); render();
  }

  function move(uid, dir) {
    var hit = find(uid); if (!hit || !writable(hit.key)) return;
    var sibs = siblingsOf(hit);
    var j = hit.index + dir;
    if (j < 0 || j >= sibs.length) return;
    snapshot();
    sibs.splice(hit.index, 1);
    sibs.splice(j, 0, hit.node);
    markDirty(true, hit.key); render();
  }

  function toggleDone(uid) {
    var hit = find(uid); if (!hit || !writable(hit.key)) return;
    snapshot(); hit.node.done = !hit.node.done;
    markDirty(true, hit.key); render();
  }

  function toggleStyle(uid) {
    if (uid == null) {
      if (!writable("")) return;
      snapshot();
      var d = state.docs[""].doc;
      d.child_style = d.child_style === "ordered" ? "bullet" : "ordered";
      markDirty(true, ""); render(); return;
    }
    var hit = find(uid); if (!hit) return;
    /* a mount's child style belongs to the other file */
    var key = childKey(hit.node, uid);
    if (!writable(key)) return;
    snapshot();
    var t = hit.node.mount ? state.docs[uid].doc : hit.node;
    t.child_style = t.child_style === "ordered" ? "bullet" : "ordered";
    markDirty(true, key); render();
  }

  function toggleCollapse(n, uid) {
    if (n.mount && !isOpen(uid)) { loadDoc(uid); return; }   // lazy: fetch on expand
    if (collapsed.has(uid)) collapsed.delete(uid); else collapsed.add(uid);
    persistCollapsed(); render();
  }
  function persistCollapsed() { store("wn.collapsed", Array.from(collapsed)); }

  function relink(uid) {
    var hit = find(uid); if (!hit || !writable(hit.key)) return;
    var n = hit.node;
    var cur = n.mount ? n.mount.raw : "";
    var t = prompt(
      "Link another wellnoded file in at this node.\n\n" +
      "  ../other/TODO.wellnoded        a file on this machine\n" +
      "  10.1.1.12:~/p/TODO.wellnoded   another machine, over ssh\n" +
      "  ?host:~/p/TODO.wellnoded       a leading ? makes it read-only\n\n" +
      "Leave it empty to unlink.", cur);
    if (t === null) return;
    t = t.trim();
    if (!t && !n.mount) return;
    if (t && !n.mount && n.children.length) {
      return toast("this node has children of its own - a mount cannot have both");
    }
    snapshot();
    if (t) {
      n.mount = { raw: t, display: t.replace(/^\?/, ""), kind: "?",
                  ro: t.charAt(0) === "?" };
      n.children = [];
    } else {
      n.mount = null;
    }
    dropDocs(uid);
    markDirty(true, hit.key);
    save(true).then(function () { return loadDoc(hit.key, true); });
  }

  function zoomTo(uid) {
    commitEdit(true);
    state.zoom = uid || null;
    syncHash();
    render();
    window.scrollTo(0, 0);
    if (uid) {
      var hit = find(uid);
      if (hit && hit.node.mount && !isOpen(uid)) loadDoc(uid);
    }
  }
  function syncHash() {
    var want = state.zoom ? "#" + state.zoom : "";
    if (location.hash !== want) history.pushState(null, "", location.pathname + want);
  }
  function upOne() {
    if (!state.zoom) return;
    var p = pathTo(state.zoom);
    zoomTo(p.length > 1 ? p[p.length - 2].uid : null);
  }

  /* --------------------------------------------------------- keyboard  */
  function titleKeys(e, n, uid, ta, tb) {
    var atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    var atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;

    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      n.title = ta.value; n.body = tb.value;
      if (state.zoom === uid) { addChild(uid); return; }
      addSibling(uid, atStart && ta.value ? "before" : "after");
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault(); tb.focus();
      tb.setSelectionRange(tb.value.length, tb.value.length); return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); n.title = ta.value; n.body = tb.value;
      state.editing = null; toggleDone(uid); return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      n.title = ta.value; n.body = tb.value;
      state.editing = { uid: uid, field: "title", caret: ta.selectionStart };
      if (e.shiftKey) outdent(uid); else indent(uid);
      return;
    }
    if (e.key === "Backspace" && atStart && !ta.value &&
        !n.children.length && !n.mount) {
      e.preventDefault();
      var list = flatVisible(), i = list.indexOf(uid);
      var prev = i > 0 ? list[i - 1] : null;
      removeNode(uid, true);
      if (prev) startEdit(prev, "title", "end");
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (e.altKey || e.metaKey)) {
      e.preventDefault();
      n.title = ta.value; n.body = tb.value;
      state.editing = { uid: uid, field: "title", caret: ta.selectionStart };
      move(uid, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (e.key === "ArrowUp" && atStart) {
      var l = flatVisible(), ix = l.indexOf(uid);
      if (ix > 0) {
        e.preventDefault(); n.title = ta.value; n.body = tb.value;
        startEdit(l[ix - 1], "title", "end");
      }
      return;
    }
    if (e.key === "ArrowDown" && atEnd) {
      var l2 = flatVisible(), ix2 = l2.indexOf(uid);
      if (ix2 >= 0 && ix2 < l2.length - 1) {
        e.preventDefault(); n.title = ta.value; n.body = tb.value;
        startEdit(l2[ix2 + 1], "title", 0);
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); ta.blur(); commitEdit(); save(); }
  }

  function bodyKeys(e, n, uid, ta, tb) {
    if (e.key === "Escape") {
      e.preventDefault(); ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length); return;
    }
    if (e.key === "Backspace" && tb.selectionStart === 0 && tb.selectionEnd === 0 && !tb.value) {
      e.preventDefault(); ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length); return;
    }
    if (e.key === "Tab") { e.preventDefault(); ta.focus(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); n.title = ta.value; n.body = tb.value;
      state.editing = null; toggleDone(uid);
    }
  }

  document.addEventListener("keydown", function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); commitEdit(true); undo(); return; }
    if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      e.preventDefault(); commitEdit(true); redo(); return;
    }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); commitEdit(); save(true); toast("saved"); return; }
    if (e.target.tagName === "TEXTAREA") return;
    if (e.key === "Escape") { closeMenu(); return; }
    if (mod && e.altKey && e.key === "ArrowUp") { e.preventDefault(); upOne(); return; }
    if (e.key === "h" && !mod) { e.preventDefault(); $("hide").click(); }
  });

  /* -------------------------------------------------------------- menu */
  var openMenuEl = null;
  function closeMenu() {
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
    document.querySelectorAll(".dots.open").forEach(function (d) { d.classList.remove("open"); });
  }
  function openMenu(n, uid, anchor) {
    if (openMenuEl && openMenuEl.dataset.for === uid) return closeMenu();
    closeMenu();
    anchor.classList.add("open");
    var m = document.createElement("div");
    m.className = "menu"; m.dataset.for = uid;
    function item(label, key, fn, cls) {
      var b = document.createElement("button");
      if (cls) b.className = cls;
      b.innerHTML = "<span>" + label + "</span>" + (key ? "<span class='k'>" + key + "</span>" : "");
      b.onclick = function () { closeMenu(); fn(); };
      m.appendChild(b);
    }
    var entry = n.mount ? state.docs[uid] : null;
    item(n.done ? "Un-strike" : "Strike through", "Ctrl+↵", function () { toggleDone(uid); });
    item(n.mount ? "Zoom into this file" : "Zoom in", "", function () { zoomTo(uid); });
    item("Copy link to node", "", function () { copyLink(uid); });

    if (n.mount) {
      m.appendChild(document.createElement("hr"));
      item("Reload from file", "", function () { loadDoc(uid, true); });
      var merr = mountErr(n, uid);
      if (merr && merr.kind === "missing") {
        item("Create this file", "", function () { createMountFile(uid); });
      }
      item("Change link target…", "", function () { relink(uid); });
      if (entry && entry.loaded && !entry.ro) {
        item("Add a node in that file", "", function () { addChild(uid, true); });
        item(entry.doc.child_style === "ordered"
             ? "Its children: → bulleted (-)"
             : "Its children: → numbered (1.)", "", function () { toggleStyle(uid); });
      }
    } else {
      m.appendChild(document.createElement("hr"));
      item(n.child_style === "ordered" ? "Children: → bulleted (-)"
                                       : "Children: → numbered (1.)", "",
           function () { toggleStyle(uid); });
      item("Add child", "", function () { addChild(uid); });
      if (!n.children.length) {
        item("Link a file here…", "", function () { relink(uid); });
      }
    }
    m.appendChild(document.createElement("hr"));
    item("Move up", "Alt+↑", function () { move(uid, -1); });
    item("Move down", "Alt+↓", function () { move(uid, 1); });
    item("Indent", "Tab", function () { indent(uid); });
    item("Outdent", "⇧Tab", function () { outdent(uid); });
    m.appendChild(document.createElement("hr"));
    item(n.mount ? "Unlink (keeps the file)" : "Delete", "",
         function () { removeNode(uid); }, "danger");

    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    var top = r.bottom + window.scrollY + 4;
    var left = Math.min(r.left + window.scrollX - 150, window.innerWidth - 210);
    m.style.top = top + "px"; m.style.left = Math.max(8, left) + "px";
    openMenuEl = m;
    setTimeout(function () {
      document.addEventListener("click", onDocClick, { once: true });
    }, 0);
  }
  function onDocClick(e) {
    if (openMenuEl && openMenuEl.contains(e.target)) {
      document.addEventListener("click", onDocClick, { once: true });
      return;
    }
    closeMenu();
  }

  function copyLink(uid) {
    var url = location.origin + location.pathname + "#" + uid;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast("link copied"); },
                                             function () { prompt("Link:", url); });
    } else prompt("Link:", url);
  }

  var toastT = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove("show"); }, 1600);
  }

  /* -------------------------------------------------------------- boot */
  $("up").onclick = upOne;
  $("home").onclick = function () { zoomTo(null); };
  $("hide").onclick = function () {
    state.hideDone = !state.hideDone; store("wn.hideDone", state.hideDone);
    commitEdit(true); render();
  };
  $("export").onclick = function () {
    commitEdit();
    var q = state.zoom ? "?root=" + encodeURIComponent(state.zoom) : "";
    save(true).then(function () { location.href = "/api/export" + q; });
  };
  window.addEventListener("hashchange", function () {
    var uid = location.hash.replace(/^#/, "") || null;
    if (uid !== state.zoom) {
      state.zoom = uid; commitEdit(true);
      ensureChain(uid).then(function () { render(); });
    }
  });

  state.zoom = location.hash.replace(/^#/, "") || null;
  loadDoc("").then(function (e) {
    if (!e.loaded) throw new Error(e.error || "could not load the document");
    return ensureChain(state.zoom);
  }).then(function () {
    if (state.zoom) {
      var hit = find(state.zoom);
      if (hit && hit.node.mount) return loadDoc(state.zoom);
    }
  }).then(function () {
    render(); setStatus();
  }).catch(function (e) {
    document.body.innerHTML = "<div class='wrap'><h1>wellnoded</h1><p>Could not load " +
      "the document: " + R.esc(e.message) + "</p></div>";
  });
})();
