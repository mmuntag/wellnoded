/* wellnoded - editor front end */
(function () {
  "use strict";
  var R = window.WNRender;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    doc: null, rev: null, file: "",
    zoom: null,                 // node id we are zoomed into
    editing: null,              // {id, field}
    collapsed: load("wn.collapsed", []),
    hideDone: load("wn.hideDone", false),
    dirty: false, saving: false, lastErr: null,
    undo: [], redo: []
  };
  var collapsed = new Set(state.collapsed);

  function load(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ------------------------------------------------------------- model */
  function walk(nodes, fn, parent, depth) {
    depth = depth || 0;
    for (var i = 0; i < nodes.length; i++) {
      if (fn(nodes[i], parent, i, depth) === false) return false;
      if (walk(nodes[i].children, fn, nodes[i], depth + 1) === false) return false;
    }
    return true;
  }
  function find(id) {
    var hit = null;
    walk(state.doc.children, function (n, p, i) {
      if (n.id === id) { hit = { node: n, parent: p, index: i }; return false; }
    }, null);
    return hit;
  }
  function siblingsOf(parent) {
    return parent ? parent.children : state.doc.children;
  }
  function pathTo(id) {
    var path = [];
    (function rec(nodes, acc) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i], next = acc.concat([n]);
        if (n.id === id) { path = next; return true; }
        if (rec(n.children, next)) return true;
      }
      return false;
    })(state.doc.children, []);
    return path;
  }
  function newId() {
    var used = {};
    walk(state.doc.children, function (n) { used[n.id] = 1; });
    var a = "0123456789abcdefghijklmnopqrstuvwxyz", id;
    do {
      id = a[(Math.random() * 36) | 0] + a[(Math.random() * 36) | 0] +
           a[(Math.random() * 36) | 0];
    } while (used[id]);
    return id;
  }
  function blank() {
    return { id: newId(), title: "", body: "", done: false,
             child_style: "bullet", children: [] };
  }

  /* -------------------------------------------------------- undo stack */
  function snapshot() {
    state.undo.push(JSON.stringify(state.doc));
    if (state.undo.length > 120) state.undo.shift();
    state.redo.length = 0;
  }
  function undo() {
    if (!state.undo.length) return toast("nothing to undo");
    state.redo.push(JSON.stringify(state.doc));
    state.doc = JSON.parse(state.undo.pop());
    state.editing = null; render(); save(true);
  }
  function redo() {
    if (!state.redo.length) return toast("nothing to redo");
    state.undo.push(JSON.stringify(state.doc));
    state.doc = JSON.parse(state.redo.pop());
    state.editing = null; render(); save(true);
  }

  /* -------------------------------------------------------- persistence
     Structural edits flush at once (250 ms coalescing); typing is debounced
     at 1.2 s; a dirty document is forced out every 10 s; and anything still
     pending is flushed on blur, tab-hide and unload.                      */
  var TYPE_DEBOUNCE = 1200, STRUCT_DEBOUNCE = 250, MAX_WAIT = 10000;
  var timer = null, firstDirty = 0;

  function markDirty(structural) {
    state.dirty = true;
    if (!firstDirty) firstDirty = Date.now();
    setStatus();
    var wait = structural ? STRUCT_DEBOUNCE : TYPE_DEBOUNCE;
    if (Date.now() - firstDirty > MAX_WAIT) wait = 0;
    clearTimeout(timer);
    timer = setTimeout(function () { save(); }, wait);
  }

  var inflight = null;

  function save(force) {
    clearTimeout(timer);
    if (!state.dirty && !force) return Promise.resolve();
    if (state.saving) {
      // queue behind the request already on the wire, so callers that wait
      // (the export button, Ctrl+S) really do see their edits land first
      return inflight.then(function () { return save(force); },
                           function () { return save(force); });
    }
    state.saving = true; setStatus();
    var body = JSON.stringify({ rev: state.rev, doc: state.doc });
    inflight = fetch("/api/doc", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: body
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, code: r.status, j: j }; });
    }).then(function (res) {
      state.saving = false;
      if (res.code === 409) {
        state.lastErr = "conflict";
        setStatus();
        if (confirm("data.md was changed on disk by something else.\n\n" +
                    "OK  = discard those changes and keep what is on screen\n" +
                    "Cancel = reload the file (your unsaved edits are lost)")) {
          state.rev = res.j.rev;
          return fetch("/api/doc", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rev: res.j.rev, doc: state.doc, force: true })
          }).then(function (r) { return r.json(); }).then(function (j) {
            state.rev = j.rev; state.dirty = false; firstDirty = 0;
            state.lastErr = null; setStatus();
          });
        }
        state.doc = res.j.doc; state.rev = res.j.rev;
        state.dirty = false; firstDirty = 0; state.lastErr = null;
        render(); setStatus();
        return;
      }
      if (!res.ok) throw new Error(res.j.error || ("HTTP " + res.code));
      state.rev = res.j.rev; state.dirty = false; firstDirty = 0;
      state.lastErr = null; setStatus();
    }).catch(function (e) {
      state.saving = false; state.lastErr = e.message; setStatus();
      timer = setTimeout(function () { save(); }, 4000);
    });
    return inflight;
  }

  function setStatus() {
    var el = $("status");
    el.className = "status";
    if (state.lastErr) { el.className += " err"; el.textContent = "unsaved!"; el.title = state.lastErr; return; }
    if (state.saving) { el.textContent = "saving"; return; }
    if (state.dirty) { el.className += " dirty"; el.textContent = "●"; el.title = "unsaved changes"; return; }
    el.textContent = "saved"; el.title = state.file;
  }

  window.addEventListener("beforeunload", function (e) {
    commitEdit(true);
    if (state.dirty) {
      try {
        navigator.sendBeacon("/api/doc", new Blob(
          [JSON.stringify({ rev: state.rev, doc: state.doc })],
          { type: "application/json" }));
      } catch (err) {}
      if (state.lastErr) { e.preventDefault(); e.returnValue = ""; }
    }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { commitEdit(true); save(); }
  });

  /* ------------------------------------------------------------ render */
  function visibleChildren(node) {
    var kids = node ? node.children : state.doc.children;
    if (!state.hideDone) return kids;
    return kids.filter(function (n) { return !n.done; });
  }

  function render() {
    var root = state.zoom ? (find(state.zoom) || {}).node : null;
    if (state.zoom && !root) { state.zoom = null; location.hash = ""; }

    renderCrumbs(root);

    var dt = $("doctitle"), zn = $("zoomnote");
    if (root) {
      dt.innerHTML = R.renderInline(root.title) || "<span style='color:var(--faint)'>untitled</span>";
      dt.className = "doctitle" + (root.done ? " struck" : "");
      dt.style.textDecoration = root.done ? "line-through" : "";
      dt.onclick = function () { startEdit(root.id, "title"); };
      dt.style.cursor = "text";
      zn.innerHTML = "";
      if (root.body.trim()) { zn.innerHTML = R.renderBody(root.body); zn.style.color = "var(--dim)"; }
      document.title = R.plain(root.title) + " - wellnoded";
    } else {
      var h = (state.doc.header || []).join("\n");
      var m = /^#\s+(.*)$/m.exec(h);
      dt.innerHTML = m ? R.renderInline(m[1]) : "";
      dt.onclick = null; dt.style.cursor = "";
      dt.style.display = m ? "" : "none";
      zn.innerHTML = "";
      document.title = (m ? R.plain(m[1]) + " - " : "") + "wellnoded";
    }

    var host = $("tree");
    host.innerHTML = "";
    var parentNode = root || null;
    var kids = visibleChildren(parentNode);
    if (!kids.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = state.hideDone && (parentNode ? parentNode.children : state.doc.children).length
        ? "everything here is done (hide done is on)"
        : "empty - click here to start";
      e.onclick = function () { addChild(parentNode); };
      host.appendChild(e);
    } else {
      var style = parentNode ? parentNode.child_style : state.doc.child_style;
      kids.forEach(function (n, i) { host.appendChild(nodeEl(n, i + 1, style)); });
    }
    $("export").title = state.zoom
      ? "Download a read-only html copy of this subtree"
      : "Download a read-only html copy";
    $("hide").className = "btn" + (state.hideDone ? " on" : "");
    $("up").disabled = !state.zoom;
    $("home").disabled = !state.zoom;
    restoreEditor();
  }

  function renderCrumbs(root) {
    var c = $("crumbs");
    c.innerHTML = "";
    function add(label, id, isLast) {
      if (c.children.length) {
        var s = document.createElement("span");
        s.className = "sep"; s.textContent = "›"; c.appendChild(s);
      }
      var a = document.createElement("a");
      a.textContent = label;
      if (isLast) { a.style.color = "var(--ink)"; a.style.cursor = "default"; }
      else a.onclick = function () { zoomTo(id); };
      c.appendChild(a);
    }
    var hm = /^#\s+(.*)$/m.exec((state.doc.header || []).join("\n"));
    add(hm ? R.plain(hm[1]) : "home", null, !root);
    if (root) {
      var path = pathTo(root.id);
      path.forEach(function (n, i) {
        add(R.plain(n.title) || "untitled", n.id, i === path.length - 1);
      });
    }
  }

  function nodeEl(n, index, style) {
    var el = document.createElement("div");
    el.className = "node" + (n.done ? " done" : "") +
                   (collapsed.has(n.id) ? " collapsed" : "");
    el.dataset.id = n.id;

    var row = document.createElement("div");
    row.className = "row";

    var kids = visibleChildren(n);
    var tw = document.createElement("span");
    tw.className = "twist" + (kids.length ? "" : " none");
    tw.textContent = kids.length ? "▼" : "";
    if (kids.length) tw.onclick = function (e) { e.stopPropagation(); toggleCollapse(n.id); };
    row.appendChild(tw);

    var b;
    if (style === "ordered") {
      b = document.createElement("span");
      b.className = "num"; b.textContent = index + ".";
    } else {
      b = document.createElement("span");
      b.className = "bullet"; b.innerHTML = "<i></i>";
    }
    b.title = "zoom in";
    b.onclick = function (e) { e.stopPropagation(); zoomTo(n.id); };
    row.appendChild(b);

    var content = document.createElement("div");
    content.className = "content";
    var t = document.createElement("div");
    t.className = "title";
    t.innerHTML = R.renderInline(n.title);
    if (collapsed.has(n.id) && n.children.length) {
      var cc = document.createElement("span");
      cc.className = "childcount"; cc.textContent = n.children.length;
      t.appendChild(cc);
    }
    t.onclick = function (e) {
      if (e.target.tagName === "A") return;
      startEdit(n.id, "title", caretFromClick(e));
    };
    content.appendChild(t);
    if (n.body.trim()) {
      var bd = document.createElement("div");
      bd.className = "body";
      bd.innerHTML = R.renderBody(n.body);
      bd.onclick = function (e) {
        if (e.target.tagName === "A") return;
        startEdit(n.id, "body");
      };
      content.appendChild(bd);
    }
    row.appendChild(content);

    var dots = document.createElement("button");
    dots.className = "dots"; dots.innerHTML = "⋯"; dots.title = "node menu";
    dots.onclick = function (e) { e.stopPropagation(); openMenu(n, dots); };
    row.appendChild(dots);

    el.appendChild(row);

    var kidHost = document.createElement("div");
    kidHost.className = "kids";
    kids.forEach(function (c, i) { kidHost.appendChild(nodeEl(c, i + 1, n.child_style)); });
    el.appendChild(kidHost);
    return el;
  }

  function caretFromClick() { return null; }

  /* ------------------------------------------------------------ editor */
  function startEdit(id, field, caret) {
    if (state.editing && state.editing.id === id && state.editing.field === field) return;
    commitEdit();
    state.editing = { id: id, field: field, caret: caret };
    if (state.zoom === id) { renderZoomEditor(); return; }
    var el = document.querySelector('.node[data-id="' + id + '"]');
    if (!el) { state.editing = null; return; }
    mountEditor(el, id, field);
  }

  function renderZoomEditor() {
    // editing the zoomed node's own title/body happens in the header area
    var hit = find(state.editing.id); if (!hit) return;
    var n = hit.node, dt = $("doctitle"), zn = $("zoomnote");
    dt.innerHTML = "";
    var box = document.createElement("div");
    box.className = "edit";
    var ta = mkTa("ta-title", n.done ? n.title : n.title, "title");
    ta.style.font = "600 27px/1.25 var(--serif)";
    box.appendChild(ta);
    var tb = mkTa("ta-body", n.body, "body");
    tb.placeholder = "notes…";
    box.appendChild(tb);
    dt.appendChild(box);
    zn.innerHTML = "";
    wire(box, n, ta, tb);
    (state.editing.field === "body" ? tb : ta).focus();
    autosize(ta); autosize(tb);
  }

  function mkTa(cls, val, name) {
    var ta = document.createElement("textarea");
    ta.className = cls; ta.value = val || ""; ta.rows = 1;
    ta.dataset.field = name; ta.spellcheck = true;
    return ta;
  }

  function mountEditor(el, id, field) {
    var hit = find(id); if (!hit) return;
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
    wire(box, n, ta, tb);
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

  function wire(box, n, ta, tb) {
    [ta, tb].forEach(function (x) {
      x.addEventListener("input", function () {
        autosize(x);
        n[x.dataset.field] = x.value;
        markDirty(false);
      });
      x.addEventListener("focus", function () {
        if (state.editing) state.editing.field = x.dataset.field;
      });
    });
    ta.addEventListener("keydown", function (e) { titleKeys(e, n, ta, tb); });
    tb.addEventListener("keydown", function (e) { bodyKeys(e, n, ta, tb); });
    box.addEventListener("focusout", function (e) {
      setTimeout(function () {
        if (box.contains(document.activeElement)) return;
        if (state.editing && state.editing.id === n.id) commitEdit();
      }, 0);
    });
  }

  function commitEdit(quiet) {
    if (!state.editing) return;
    var id = state.editing.id;
    var el = document.querySelector('.node[data-id="' + id + '"] .edit') ||
             document.querySelector("#doctitle .edit");
    if (el) {
      var hit = find(id);
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
    var id = state.editing.id;
    if (state.zoom === id) { renderZoomEditor(); return; }
    var el = document.querySelector('.node[data-id="' + id + '"]');
    if (el) mountEditor(el, id, state.editing.field);
    else state.editing = null;
  }

  /* ------------------------------------------------- structural actions */
  function flatVisible() {
    var out = [];
    (function rec(nodes, parent) {
      var list = state.hideDone ? nodes.filter(function (n) { return !n.done; }) : nodes;
      list.forEach(function (n) {
        out.push(n);
        if (!collapsed.has(n.id)) rec(n.children, n);
      });
    })(state.zoom ? (find(state.zoom) || { node: { children: [] } }).node.children
                  : state.doc.children, null);
    return out;
  }

  function addSibling(n, where) {
    var hit = find(n.id); if (!hit) return;
    snapshot();
    var fresh = blank();
    var sibs = siblingsOf(hit.parent);
    if (!collapsed.has(n.id) && n.children.length && where !== "before") {
      n.children.unshift(fresh);
    } else {
      sibs.splice(hit.index + (where === "before" ? 0 : 1), 0, fresh);
    }
    state.editing = { id: fresh.id, field: "title" };
    markDirty(true); render();
  }
  function addChild(parent) {
    snapshot();
    var fresh = blank();
    (parent ? parent.children : state.doc.children).push(fresh);
    if (parent) collapsed.delete(parent.id);
    state.editing = { id: fresh.id, field: "title" };
    markDirty(true); render();
  }
  function removeNode(n, silent) {
    var hit = find(n.id); if (!hit) return;
    if (!silent && (n.children.length || n.title.trim().length > 40) &&
        !confirm("Delete “" + (R.plain(n.title) || "untitled") + "”" +
                 (n.children.length ? " and its " + n.children.length + " child node(s)" : "") + "?"))
      return;
    snapshot();
    var sibs = siblingsOf(hit.parent);
    sibs.splice(hit.index, 1);
    if (state.zoom === n.id) { state.zoom = hit.parent ? hit.parent.id : null; syncHash(); }
    state.editing = null;
    markDirty(true); render();
  }
  function indent(n) {
    var hit = find(n.id); if (!hit || hit.index === 0) return;
    snapshot();
    var sibs = siblingsOf(hit.parent);
    var prev = sibs[hit.index - 1];
    sibs.splice(hit.index, 1);
    prev.children.push(n);
    collapsed.delete(prev.id); persistCollapsed();
    markDirty(true); render();
  }
  function outdent(n) {
    var hit = find(n.id); if (!hit || !hit.parent) return;
    var gp = find(hit.parent.id);
    snapshot();
    hit.parent.children.splice(hit.index, 1);
    var target = gp ? siblingsOf(gp.parent) : state.doc.children;
    var at = gp ? gp.index + 1 : target.length;
    target.splice(at, 0, n);
    markDirty(true); render();
  }
  function move(n, dir) {
    var hit = find(n.id); if (!hit) return;
    var sibs = siblingsOf(hit.parent);
    var j = hit.index + dir;
    if (j < 0 || j >= sibs.length) return;
    snapshot();
    sibs.splice(hit.index, 1);
    sibs.splice(j, 0, n);
    markDirty(true); render();
  }
  function toggleDone(n) {
    snapshot(); n.done = !n.done; markDirty(true); render();
  }
  function toggleStyle(n) {
    snapshot();
    var t = n ? n : state.doc;
    t.child_style = t.child_style === "ordered" ? "bullet" : "ordered";
    markDirty(true); render();
  }
  function toggleCollapse(id) {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    persistCollapsed(); render();
  }
  function persistCollapsed() { store("wn.collapsed", Array.from(collapsed)); }

  function zoomTo(id) {
    commitEdit(true);
    state.zoom = id || null;
    syncHash();
    render();
    window.scrollTo(0, 0);
  }
  function syncHash() {
    var want = state.zoom ? "#" + state.zoom : "";
    if (location.hash !== want) history.pushState(null, "", location.pathname + want);
  }
  function upOne() {
    if (!state.zoom) return;
    var p = pathTo(state.zoom);
    zoomTo(p.length > 1 ? p[p.length - 2].id : null);
  }

  /* --------------------------------------------------------- keyboard  */
  function titleKeys(e, n, ta, tb) {
    var atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    var atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;

    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      n.title = ta.value; n.body = tb.value;
      if (state.zoom === n.id) { addChild(n); return; }
      addSibling(n, atStart && ta.value ? "before" : "after");
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault(); tb.focus();
      tb.setSelectionRange(tb.value.length, tb.value.length); return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); n.title = ta.value; n.body = tb.value;
      state.editing = null; toggleDone(n); return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      n.title = ta.value; n.body = tb.value;
      state.editing = { id: n.id, field: "title", caret: ta.selectionStart };
      if (e.shiftKey) outdent(n); else indent(n);
      return;
    }
    if (e.key === "Backspace" && atStart && !ta.value && !n.children.length) {
      e.preventDefault();
      var list = flatVisible(), i = list.indexOf(n);
      var prev = i > 0 ? list[i - 1] : null;
      removeNode(n, true);
      if (prev) startEdit(prev.id, "title", "end");
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (e.altKey || e.metaKey)) {
      e.preventDefault();
      n.title = ta.value; n.body = tb.value;
      state.editing = { id: n.id, field: "title", caret: ta.selectionStart };
      move(n, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (e.key === "ArrowUp" && atStart) {
      var l = flatVisible(), ix = l.indexOf(n);
      if (ix > 0) { e.preventDefault(); n.title = ta.value; n.body = tb.value;
                    startEdit(l[ix - 1].id, "title", "end"); }
      return;
    }
    if (e.key === "ArrowDown" && atEnd) {
      var l2 = flatVisible(), ix2 = l2.indexOf(n);
      if (ix2 >= 0 && ix2 < l2.length - 1) {
        e.preventDefault(); n.title = ta.value; n.body = tb.value;
        startEdit(l2[ix2 + 1].id, "title", 0);
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); ta.blur(); commitEdit(); save(); }
  }

  function bodyKeys(e, n, ta, tb) {
    if (e.key === "Escape") {
      e.preventDefault(); ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length); return;
    }
    if (e.key === "Backspace" && tb.selectionStart === 0 && tb.selectionEnd === 0 && !tb.value) {
      e.preventDefault(); ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length); return;
    }
    if (e.key === "Tab") {
      e.preventDefault(); ta.focus(); return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); n.title = ta.value; n.body = tb.value;
      state.editing = null; toggleDone(n);
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
  function openMenu(n, anchor) {
    if (openMenuEl && openMenuEl.dataset.for === n.id) return closeMenu();
    closeMenu();
    anchor.classList.add("open");
    var m = document.createElement("div");
    m.className = "menu"; m.dataset.for = n.id;
    function item(label, key, fn, cls) {
      var b = document.createElement("button");
      if (cls) b.className = cls;
      b.innerHTML = "<span>" + label + "</span>" + (key ? "<span class='k'>" + key + "</span>" : "");
      b.onclick = function () { closeMenu(); fn(); };
      m.appendChild(b);
    }
    item(n.done ? "Un-strike" : "Strike through", "Ctrl+↵", function () { toggleDone(n); });
    item("Zoom in", "", function () { zoomTo(n.id); });
    item("Copy link to node", "", function () { copyLink(n.id); });
    m.appendChild(document.createElement("hr"));
    item(n.child_style === "ordered" ? "Children: → bulleted (-)"
                                     : "Children: → numbered (1.)", "",
         function () { toggleStyle(n); });
    item("Add child", "", function () { addChild(n); });
    item("Move up", "Alt+↑", function () { move(n, -1); });
    item("Move down", "Alt+↓", function () { move(n, 1); });
    item("Indent", "Tab", function () { indent(n); });
    item("Outdent", "⇧Tab", function () { outdent(n); });
    m.appendChild(document.createElement("hr"));
    item("Delete", "", function () { removeNode(n); }, "danger");

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

  function copyLink(id) {
    var url = location.origin + location.pathname + "#" + id;
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
    var id = location.hash.replace(/^#/, "") || null;
    if (id !== state.zoom) { state.zoom = id; commitEdit(true); render(); }
  });

  fetch("/api/doc").then(function (r) { return r.json(); }).then(function (j) {
    state.doc = j.doc; state.rev = j.rev; state.file = j.file;
    state.zoom = location.hash.replace(/^#/, "") || null;
    render(); setStatus();
  }).catch(function (e) {
    document.body.innerHTML = "<div class='wrap'><h1>wellnoded</h1><p>Could not load " +
      "the document: " + R.esc(e.message) + "</p></div>";
  });
})();
