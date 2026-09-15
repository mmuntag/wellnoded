/* wellnoded - read-only export: collapse/expand, zoom, hide-done, node links. */
(function () {
  "use strict";
  var R = window.WNRender;
  var DOC = window.WN_EXPORT.doc;
  var DOCTITLE = window.WN_EXPORT.title;
  var DOCROOT = window.WN_EXPORT.root || null;   // set when a subtree was exported
  var zoom = null, hideDone = false;
  var collapsed = new Set();

  function key(k, d) {
    try { var v = localStorage.getItem("wnx." + location.pathname + "." + k);
          return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function put(k, v) {
    try { localStorage.setItem("wnx." + location.pathname + "." + k, JSON.stringify(v)); }
    catch (e) {}
  }
  collapsed = new Set(key("collapsed", []));
  hideDone = key("hideDone", false);

  function find(id) {
    var hit = null;
    (function rec(ns) {
      for (var i = 0; i < ns.length; i++) {
        if (ns[i].id === id) { hit = ns[i]; return true; }
        if (rec(ns[i].children)) return true;
      }
      return false;
    })(DOC.children);
    return hit;
  }
  function pathTo(id) {
    var out = [];
    (function rec(ns, acc) {
      for (var i = 0; i < ns.length; i++) {
        var nx = acc.concat([ns[i]]);
        if (ns[i].id === id) { out = nx; return true; }
        if (rec(ns[i].children, nx)) return true;
      }
      return false;
    })(DOC.children, []);
    return out;
  }
  function shortPath(p) {
    if (!p) return "";
    var parts = String(p).split("/");
    return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : String(p);
  }
  function kidsOf(n) {
    var k = n ? n.children : DOC.children;
    return hideDone ? k.filter(function (x) { return !x.done; }) : k;
  }

  var app = document.getElementById("app");
  app.innerHTML =
    '<div class="wrap"><header class="bar">' +
    '<nav class="crumbs" id="crumbs"></nav>' +
    '<button class="btn" id="up">&#8593; up</button>' +
    '<button class="btn" id="home">&#8962; root</button>' +
    '<button class="btn" id="hide">hide done</button>' +
    '<span class="exp-note">read-only</span>' +
    '</header><h1 class="doctitle" id="doctitle"></h1>' +
    '<div class="zoomnote" id="zoomnote"></div>' +
    '<div class="tree" id="tree"></div></div>' +
    '<div class="toast" id="toast"></div>';

  var $ = function (i) { return document.getElementById(i); };

  function nodeEl(n, index, style) {
    var el = document.createElement("div");
    el.className = "node" + (n.done ? " done" : "") +
                   (collapsed.has(n.id) ? " collapsed" : "") +
                   (n.mount ? " mount" : "") +
                   (n.mount && n.mount.ro ? " ro" : "") +
                   (n.mount_error ? " broken" : "");
    el.dataset.id = n.id;
    var row = document.createElement("div");
    row.className = "row";

    var kids = kidsOf(n);
    var tw = document.createElement("span");
    tw.className = "twist" + (kids.length ? "" : " none");
    tw.textContent = kids.length ? "▼" : "";
    if (kids.length) tw.onclick = function (e) {
      e.stopPropagation();
      if (collapsed.has(n.id)) collapsed.delete(n.id); else collapsed.add(n.id);
      put("collapsed", Array.from(collapsed)); render();
    };
    row.appendChild(tw);

    var b = document.createElement("span");
    if (style === "ordered") { b.className = "num"; b.textContent = index + "."; }
    else { b.className = "bullet"; b.innerHTML = "<i></i>"; }
    b.title = "zoom in";
    b.onclick = function (e) { e.stopPropagation(); go(n.id); };
    row.appendChild(b);

    var c = document.createElement("div");
    c.className = "content";
    var t = document.createElement("div");
    t.className = "title";
    t.innerHTML = R.renderInline(n.title);
    if (n.mount) {
      var mp = document.createElement("span");
      mp.className = "mpath" + (n.mount_error ? " err" : "");
      mp.textContent = (n.mount.ro ? "\u25cb " : "\u2192 ") +
                       shortPath(n.mount.display || n.mount.raw || "");
      mp.title = n.mount_error || (n.mount.display || n.mount.raw || "");
      t.appendChild(mp);
    }
    if (collapsed.has(n.id) && n.children.length) {
      var cc = document.createElement("span");
      cc.className = "childcount"; cc.textContent = n.children.length;
      t.appendChild(cc);
    }
    c.appendChild(t);
    if (n.body && n.body.trim()) {
      var bd = document.createElement("div");
      bd.className = "body"; bd.innerHTML = R.renderBody(n.body);
      c.appendChild(bd);
    }
    if (n.mount_error) {
      var me = document.createElement("div");
      me.className = "mounterr";
      me.textContent = "not included in this export: " + n.mount_error;
      c.appendChild(me);
    }
    row.appendChild(c);
    el.appendChild(row);

    var kh = document.createElement("div");
    kh.className = "kids";
    kids.forEach(function (x, i) { kh.appendChild(nodeEl(x, i + 1, n.child_style)); });
    el.appendChild(kh);
    return el;
  }

  function render() {
    var root = zoom ? find(zoom) : null;
    if (zoom && !root) { zoom = null; }

    var c = $("crumbs"); c.innerHTML = "";
    function crumb(label, id, last) {
      if (c.children.length) {
        var s = document.createElement("span");
        s.className = "sep"; s.textContent = "›"; c.appendChild(s);
      }
      var a = document.createElement("a");
      a.textContent = label;
      if (last) { a.style.color = "var(--ink)"; a.style.cursor = "default"; }
      else a.onclick = function () { go(id); };
      c.appendChild(a);
    }
    crumb(DOCTITLE || "home", null, !root);
    if (root) pathTo(root.id).forEach(function (n, i, arr) {
      crumb(R.plain(n.title) || "untitled", n.id, i === arr.length - 1);
    });

    var dt = $("doctitle"), zn = $("zoomnote");
    if (root) {
      dt.innerHTML = R.renderInline(root.title);
      dt.style.textDecoration = root.done ? "line-through" : "";
      zn.innerHTML = root.body && root.body.trim() ? R.renderBody(root.body) : "";
      zn.style.color = "var(--dim)";
      document.title = R.plain(root.title) + " - " + DOCTITLE;
    } else if (DOCROOT) {
      dt.innerHTML = R.renderInline(DOCROOT.title);
      dt.style.textDecoration = DOCROOT.done ? "line-through" : "";
      zn.innerHTML = DOCROOT.body && DOCROOT.body.trim()
        ? R.renderBody(DOCROOT.body) : "";
      zn.style.color = "var(--dim)";
      document.title = DOCTITLE || "wellnoded";
    } else {
      dt.textContent = DOCTITLE || "";
      dt.style.textDecoration = "";
      zn.innerHTML = "";
      document.title = DOCTITLE || "wellnoded";
    }

    var host = $("tree"); host.innerHTML = "";
    var kids = kidsOf(root);
    if (!kids.length) {
      host.innerHTML = '<div class="empty">nothing here</div>';
    } else {
      var style = root ? root.child_style : DOC.child_style;
      kids.forEach(function (n, i) { host.appendChild(nodeEl(n, i + 1, style)); });
    }
    $("hide").className = "btn" + (hideDone ? " on" : "");
    $("up").disabled = !zoom;
    $("home").disabled = !zoom;
  }

  function go(id) {
    zoom = id || null;
    var want = zoom ? "#" + zoom : "";
    if (location.hash !== want) {
      if (history.replaceState) history.replaceState(null, "", location.pathname + location.search + want);
      else location.hash = want;
    }
    render(); window.scrollTo(0, 0);
  }

  $("up").onclick = function () {
    if (!zoom) return;
    var p = pathTo(zoom);
    go(p.length > 1 ? p[p.length - 2].id : null);
  };
  $("home").onclick = function () { go(null); };
  $("hide").onclick = function () { hideDone = !hideDone; put("hideDone", hideDone); render(); };
  window.addEventListener("hashchange", function () {
    var id = location.hash.replace(/^#/, "") || null;
    if (id !== zoom) { zoom = id; render(); }
  });

  zoom = location.hash.replace(/^#/, "") || null;
  render();
})();
