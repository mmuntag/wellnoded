/* wellnoded renderer: inline markdown + a small, self-contained LaTeX subset.
   No dependencies, so the exported html works offline from file://          */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------ helpers */
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ------------------------------------------------------------- math   */
  var SYM = {
    alpha:"α", beta:"β", gamma:"γ", delta:"δ",
    epsilon:"ε", varepsilon:"ε", zeta:"ζ", eta:"η",
    theta:"θ", vartheta:"ϑ", iota:"ι", kappa:"κ",
    lambda:"λ", mu:"μ", nu:"ν", xi:"ξ", pi:"π",
    varpi:"ϖ", rho:"ρ", varrho:"ϱ", sigma:"σ",
    varsigma:"ς", tau:"τ", upsilon:"υ", phi:"φ",
    varphi:"ϕ", chi:"χ", psi:"ψ", omega:"ω",
    Gamma:"Γ", Delta:"Δ", Theta:"Θ", Lambda:"Λ",
    Xi:"Ξ", Pi:"Π", Sigma:"Σ", Upsilon:"Υ",
    Phi:"Φ", Psi:"Ψ", Omega:"Ω",
    times:"×", div:"÷", cdot:"⋅", cdots:"⋯",
    ldots:"…", dots:"…", vdots:"⋮", ddots:"⋱",
    pm:"±", mp:"∓", ast:"∗", star:"⋆", circ:"∘",
    bullet:"∙", oplus:"⊕", otimes:"⊗",
    leq:"≤", le:"≤", geq:"≥", ge:"≥", neq:"≠",
    ne:"≠", approx:"≈", sim:"∼", simeq:"≃",
    equiv:"≡", cong:"≅", propto:"∝", ll:"≪", gg:"≫",
    to:"→", rightarrow:"→", longrightarrow:"⟶",
    leftarrow:"←", longleftarrow:"⟵", leftrightarrow:"↔",
    Rightarrow:"⇒", Leftarrow:"⇐", Leftrightarrow:"⇔",
    mapsto:"↦", uparrow:"↑", downarrow:"↓",
    infty:"∞", partial:"∂", nabla:"∇", forall:"∀",
    exists:"∃", nexists:"∄", neg:"¬", lnot:"¬",
    emptyset:"∅", varnothing:"∅", in:"∈", notin:"∉",
    ni:"∋", subset:"⊂", subseteq:"⊆", supset:"⊃",
    supseteq:"⊇", cup:"∪", cap:"∩", setminus:"∖",
    land:"∧", wedge:"∧", lor:"∨", vee:"∨",
    angle:"∠", perp:"⊥", parallel:"∥", therefore:"∴",
    because:"∵", degree:"°", prime:"′", hbar:"ℏ",
    ell:"ℓ", Re:"ℜ", Im:"ℑ", aleph:"ℵ",
    langle:"⟨", rangle:"⟩", lfloor:"⌊", rfloor:"⌋",
    lceil:"⌈", rceil:"⌉", vert:"|", Vert:"‖", backslash:"\\",
    checkmark:"✓", surd:"√"
  };
  var BIGOP = { sum:"∑", prod:"∏", coprod:"∐", int:"∫",
                iint:"∬", iiint:"∭", oint:"∮",
                bigcup:"⋃", bigcap:"⋂", bigoplus:"⨁",
                bigotimes:"⨂", lim:"lim", limsup:"lim sup",
                liminf:"lim inf", max:"max", min:"min", sup:"sup", inf:"inf" };
  var FUNC = ("sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh " +
              "log ln lg exp det dim deg gcd ker hom arg mod Pr").split(" ");
  var BB = { R:"ℝ", N:"ℕ", Z:"ℤ", Q:"ℚ", C:"ℂ",
             P:"ℙ", E:"𝔼", H:"ℍ", F:"𝔽" };
  var SPACE = { ",":"0.17em", ":":"0.22em", ";":"0.28em", "!":"-0.17em",
                " ":"0.25em", quad:"1em", qquad:"2em" };
  var ACCENT = { hat:"̂", bar:"̄", vec:"⃗", dot:"̇",
                 ddot:"̈", tilde:"̃", widehat:"̂",
                 overline:"̄", check:"̌", breve:"̆",
                 acute:"́", grave:"̀" };

  function tokenize(src) {
    var t = [], i = 0, n = src.length;
    while (i < n) {
      var c = src[i];
      if (c === "\\") {
        var m = /^\\([a-zA-Z]+)/.exec(src.slice(i));
        if (m) { t.push({ k: "cmd", v: m[1] }); i += m[0].length; }
        else { t.push({ k: "cmd", v: src[i + 1] || "" }); i += 2; }
      } else if ("{}^_&".indexOf(c) >= 0) {
        t.push({ k: c }); i++;
      } else if (/\s/.test(c)) {
        i++;
      } else {
        t.push({ k: "ch", v: c }); i++;
      }
    }
    return t;
  }

  function mathToHtml(src, display) {
    var t = tokenize(src), i = 0;

    function peek() { return t[i]; }

    function group() {                       // one atom, {..} aware
      var tk = t[i];
      if (!tk) return "";
      if (tk.k === "{") { i++; var h = list(true); if (t[i] && t[i].k === "}") i++; return h; }
      return atom();
    }

    function optArg() {
      if (t[i] && t[i].k === "ch" && t[i].v === "[") {
        i++; var out = "";
        while (t[i] && !(t[i].k === "ch" && t[i].v === "]")) out += atom();
        if (t[i]) i++;
        return out;
      }
      return null;
    }

    function rawGroup() {                    // literal text inside {..}
      var out = "", depth = 0;
      if (t[i] && t[i].k === "{") { i++; depth = 1; }
      else { var a = t[i]; i++; return a ? (a.v || "") : ""; }
      while (t[i] && depth > 0) {
        if (t[i].k === "{") depth++;
        else if (t[i].k === "}") { depth--; if (!depth) { i++; break; } }
        out += (t[i].v !== undefined ? t[i].v : t[i].k);
        i++;
      }
      return out;
    }

    function atom() {
      var tk = t[i];
      if (!tk) return "";
      if (tk.k === "{") return group();
      if (tk.k === "}") { i++; return ""; }
      if (tk.k === "&") { i++; return "<span class=\"m-sp\"></span>"; }
      if (tk.k === "^" || tk.k === "_") { i++; return ""; }

      if (tk.k === "ch") {
        i++;
        var c = tk.v;
        if (/[A-Za-z]/.test(c)) return "<i>" + esc(c) + "</i>";
        if (/[0-9.]/.test(c)) return esc(c);
        if ("+-=<>".indexOf(c) >= 0)
          return "<span class=\"m-bin\">" + esc(c === "-" ? "−" : c) + "</span>";
        if (c === ",") return ", ";
        return esc(c);
      }

      // command
      i++;
      var v = tk.v;

      if (v === "frac" || v === "dfrac" || v === "tfrac") {
        var a = group(), b = group();
        return "<span class=\"m-frac\"><span class=\"m-num\">" + a +
               "</span><span class=\"m-den\">" + b + "</span></span>";
      }
      if (v === "binom" || v === "choose") {
        var x = group(), y = group();
        return "<span class=\"m-par\">(</span><span class=\"m-frac m-nol\">" +
               "<span class=\"m-num\">" + x + "</span><span class=\"m-den\">" +
               y + "</span></span><span class=\"m-par\">)</span>";
      }
      if (v === "sqrt") {
        var idx = optArg(), r = group();
        return "<span class=\"m-sqrt\">" +
               (idx ? "<span class=\"m-root\">" + idx + "</span>" : "") +
               "<span class=\"m-surd\">√</span><span class=\"m-rad\">" +
               r + "</span></span>";
      }
      if (v === "text" || v === "mathrm" || v === "operatorname" ||
          v === "textrm" || v === "mbox")
        return "<span class=\"m-text\">" + esc(rawGroup()) + "</span>";
      if (v === "textbf" || v === "mathbf")
        return "<b class=\"m-text\">" + esc(rawGroup()) + "</b>";
      if (v === "textit" || v === "mathit")
        return "<i>" + esc(rawGroup()) + "</i>";
      if (v === "mathbb") {
        var g = rawGroup();
        return "<span class=\"m-text\">" + esc(BB[g] || g) + "</span>";
      }
      if (v === "mathcal" || v === "mathscr")
        return "<span class=\"m-cal\">" + esc(rawGroup()) + "</span>";
      if (ACCENT[v]) {
        return "<span class=\"m-acc\">" + group() +
               "<span class=\"m-accm\">" + ACCENT[v] + "</span></span>";
      }
      if (v === "left" || v === "right") {
        var d = t[i]; i++;
        var ch = d ? (d.k === "cmd" ? (SYM[d.v] || "") : (d.v || "")) : "";
        if (ch === "." || ch === "") return "";
        return "<span class=\"m-par\">" + esc(ch) + "</span>";
      }
      if (SPACE[v] !== undefined)
        return "<span style=\"display:inline-block;width:" + SPACE[v] + "\"></span>";
      if (BIGOP[v]) {
        var sym = BIGOP[v];
        var word = sym.length > 1;
        var lower = null, upper = null;
        while (t[i] && (t[i].k === "^" || t[i].k === "_")) {
          var isUp = t[i].k === "^"; i++;
          var s = group();
          if (isUp) upper = s; else lower = s;
        }
        var body = "<span class=\"m-op" + (word ? " m-text" : " m-bigop") + "\">" +
                   esc(sym) + "</span>";
        if (!lower && !upper) return body;
        if (display) {
          return "<span class=\"m-limits\">" +
                 "<span class=\"m-up\">" + (upper || "") + "</span>" + body +
                 "<span class=\"m-lo\">" + (lower || "") + "</span></span>";
        }
        return body + scripts(upper, lower);
      }
      if (FUNC.indexOf(v) >= 0)
        return "<span class=\"m-text\">" + v + "</span>";
      if (SYM[v] !== undefined) {
        var s2 = SYM[v];
        var isRel = "≤≥≠≈≡→⇒↔∈".indexOf(s2) >= 0;
        return isRel ? "<span class=\"m-bin\">" + esc(s2) + "</span>" : esc(s2);
      }
      if (v === "\\") return display ? "<br>" : " ";
      if ("{}$%_&#".indexOf(v) >= 0) return esc(v);
      return "<span class=\"m-text\">" + esc(v) + "</span>";
    }

    function scripts(up, lo) {
      var out = "";
      if (up != null && lo != null)
        return "<span class=\"m-ss\"><sup>" + up + "</sup><sub>" + lo + "</sub></span>";
      if (up != null) out += "<sup>" + up + "</sup>";
      if (lo != null) out += "<sub>" + lo + "</sub>";
      return out;
    }

    function list(inGroup) {
      var out = "";
      while (i < t.length) {
        if (inGroup && t[i].k === "}") break;
        var a = atom();
        var up = null, lo = null;
        while (t[i] && (t[i].k === "^" || t[i].k === "_")) {
          var isUp = t[i].k === "^"; i++;
          var s = group();
          if (isUp) up = s; else lo = s;
        }
        out += a + scripts(up, lo);
      }
      return out;
    }

    var html = list(false);
    return "<span class=\"math" + (display ? " math-display" : "") + "\">" +
           html + "</span>";
  }

  /* --------------------------------------------------------- inline md  */
  function emphasize(s) {
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|#[\w-]+)\)/g,
      function (_, txt, url) {
        return '<a href="' + esc(url) + '"' +
               (url[0] === "#" ? "" : ' target="_blank" rel="noopener"') +
               ">" + txt + "</a>";
      });
    s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?])/g,
      function (_, pre, url) {
        var href = url.indexOf("www.") === 0 ? "http://" + url : url;
        return pre + '<a href="' + esc(href) + '" target="_blank" rel="noopener">' +
               url + "</a>";
      });
    s = s.replace(/~~([\s\S]+?)~~/g, "<s>$1</s>");
    s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+?)__/g, "<u>$1</u>");
    s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");
    return s;
  }

  /* Split into math / code / text, render each, reassemble. */
  function renderInline(src) {
    if (!src) return "";
    var out = "", i = 0, n = src.length;
    var buf = "";
    function flush() { if (buf) { out += emphasize(esc(buf)); buf = ""; } }

    while (i < n) {
      var c = src[i];
      if (c === "\\" && i + 1 < n && "$`*_~[]\\".indexOf(src[i + 1]) >= 0) {
        buf += src[i + 1]; i += 2; continue;
      }
      if (c === "`") {
        var end = src.indexOf("`", i + 1);
        if (end > i) {
          flush();
          out += "<code>" + esc(src.slice(i + 1, end)) + "</code>";
          i = end + 1; continue;
        }
      }
      if (c === "$") {
        var disp = src[i + 1] === "$";
        var open = disp ? "$$" : "$";
        var e = src.indexOf(open, i + open.length);
        if (e > i) {
          var inner = src.slice(i + open.length, e);
          if (inner.trim() && !(!disp && /^\s|\s$/.test(inner) && /^\d/.test(inner))) {
            flush();
            out += mathToHtml(inner, disp);
            i = e + open.length; continue;
          }
        }
      }
      buf += c; i++;
    }
    flush();
    return out;
  }

  /* Body: blank-line separated paragraphs, $$..$$ blocks kept on own line. */
  function renderBody(src) {
    if (!src || !src.trim()) return "";
    var paras = src.replace(/\r/g, "").split(/\n{2,}/);
    return paras.map(function (p) {
      var t = p.trim();
      if (!t) return "";
      var dm = /^\$\$([\s\S]+)\$\$$/.exec(t);
      if (dm) return "<p class=\"md\">" + mathToHtml(dm[1], true) + "</p>";
      return "<p class=\"md\">" + renderInline(t).replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  /* Plain-text version of a title, for document.title etc. */
  function plain(src) {
    var d = document.createElement("div");
    d.innerHTML = renderInline(src || "");
    return d.textContent || "";
  }

  global.WNRender = { renderInline: renderInline, renderBody: renderBody,
                      mathToHtml: mathToHtml, esc: esc, plain: plain };
})(this);
