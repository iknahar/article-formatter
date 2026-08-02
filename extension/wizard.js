"use strict";
// ---------- state ----------
const state = {
  title: "",
  subtitle: "",
  blocks: [],          // parsed article blocks in order
  prompts: {},         // number -> prompt text
  slots: [],           // image/diagram slots found in the body
  diagramFiles: {},    // basename(lowercase, no ext) -> dataURL
};

const $ = (id) => document.getElementById(id);
const unlock = (id) => $(id).classList.remove("locked");
const scrollTo_ = (id) => $(id).scrollIntoView({ behavior: "smooth", block: "start" });

// ---------- step 1 → 2: title, subtitle ----------
document.querySelector('#step-title .next').addEventListener("click", () => {
  state.title = $("title").value.trim();
  if (!state.title) { $("title").focus(); return; }
  unlock("step-subtitle"); scrollTo_("step-subtitle");
});

document.querySelector('#step-subtitle .next').addEventListener("click", () => {
  state.subtitle = $("subtitle").value.trim();
  unlock("step-body"); scrollTo_("step-body");
});

// ---------- step 3: parse body ----------
$("analyze").addEventListener("click", () => {
  const raw = $("body").value;
  if (!raw.trim()) { $("body").focus(); return; }
  parseBody(raw);
  renderAnalysis();
  renderSlots();
  renderDiagramStatus();
  unlock("step-diagrams"); scrollTo_("step-diagrams");
});

// marker forms accepted (bracket may be followed by same-line or next-line Caption/Alt):
//  **[Place Diagram 2 → path/file.png]**   |  [Diagram 2 · path]
//  **[Place Image 9 → AI generated, prompt 9 at the end]** | [Image 9 · AI generated · ...]
//  **[Place Image 3 → external, search "keyword"]** | [Image 3 · external · search "kw"]
//  **[Image 6 → Place Diagram → diagrams/foo.png]** *Caption → ...* *Alt → ...*   (all one line, kind inferred from content, not just the label word)
//  **[Place Diagram → diagrams/foo.png]**   (no number at all — diagrams match by filename anyway, so the number is optional everywhere)
//  **[External image → search "term one" and "term two"]** (leading word is "External" itself, not "Image"/"Diagram" — kind inferred from this leading word too, not just payload content)
const MARKER_RE = /^\*{0,2}\[\s*(?:Place\s+)?(Diagram|Image|External(?:\s+image)?)\s*(\d+)?\s*(?:→|·|-|—)\s*([^\]]+?)\]\*{0,2}\s*(.*)$/i;
// A "Label → text" annotation line that isn't Caption or Alt (e.g. "Placement → ..."). Skipped
// while scanning for Caption/Alt so it doesn't stop the scan early or get eaten as a paragraph.
const ANNOTATION_RE = /^\*{0,2}[A-Za-z][\w\s]{0,24}?\s*(?:→|->)/;
// accepts → / -> / : as the separator — "Caption" and "Alt" are specific enough keywords that a
// bare colon after them is safe to treat as the same thing, unlike the generic ANNOTATION_RE above
// where a colon would be too easily confused with ordinary "Word: sentence" prose.
// {0,2} not {1,2} on both sides — markdown italic/bold wrapping is optional, a plain unwrapped
// "Caption → text" line with no asterisks at all was silently failing to match before this fix.
const CAPTION_RE = /^\*{0,2}Caption\s*(?:→|->|:)\s*(.+?)\*{0,2}\s*$/i;
const ALT_RE = /^\*{0,2}Alt\s*(?:→|->|:)\s*(.+?)\*{0,2}\s*$/i;
const INLINE_CAP_ALT_RE = /Caption\s*(?:→|->|:)\s*(.*?)\s*Alt\s*(?:→|->|:)\s*(.*)$/i;
// unwrap markdown emphasis so brackets/captions read as plain text regardless of ** / * wrapping
const stripEmph = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

// If the user pastes the whole package (SEO suite, preamble, everything) instead of just the
// body, find a standalone line reading "the body" or "the article" (any heading level, optional
// trailing parenthetical, case-insensitive) and start parsing right after it — not on it. That
// line and everything before it is discarded. No such line found -> the input is used as-is.
function stripPreamble(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  const marker = /^#{0,6}\s*\*{0,2}\s*(the body|the article)\s*\*{0,2}\s*(\(.*\))?\s*$/i;
  const idx = lines.findIndex((l) => marker.test(l.trim()));
  return idx === -1 ? raw : lines.slice(idx + 1).join("\n");
}

function parseBody(raw) {
  raw = stripPreamble(raw);
  state.blocks = []; state.prompts = {}; state.slots = [];
  const lines = raw.replace(/\r/g, "").split("\n");
  let i = 0, inCode = false, codeBuf = [], paraBuf = [], skipSection = false, curPromptKey = null, autoNum = 0;

  const flushPara = () => {
    const text = paraBuf.join(" ").trim();
    paraBuf = [];
    if (text && !skipSection) state.blocks.push({ type: "p", text });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      flushPara();
      if (inCode) {
        // Guard against an empty code block — a stray/adjacent fence pair with nothing (or only
        // whitespace) between the markers was producing a genuinely blank <pre><code></code></pre>
        // that rendered as an empty gray box right after a real one.
        const codeText = codeBuf.join("\n");
        if (!skipSection && codeText.trim()) state.blocks.push({ type: "code", text: codeText });
        codeBuf = [];
      }
      inCode = !inCode; i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    const t = line.trim();
    const tClean = stripEmph(t);

    // appendix prompt harvesting: "Prompt N, text..." (text inline) or "Image N · label" (label
    // discarded, the real prompt is the following paragraph line(s))
    const pm = tClean.match(/^Prompt\s+(\d+)\b[,.]?\s*(.*)$/i);
    const im = !pm && tClean.match(/^Image\s+(\d+)\b[\s·:.,-]*(.*)$/i);
    if (pm) { flushPara(); curPromptKey = pm[1]; state.prompts[curPromptKey] = (pm[2] || "").trim(); i++; continue; }
    // "Image N <prompt text on same line>" — same-line text after the number is the START of the
    // prompt (not "" — that silently discarded the whole prompt when the user's appendix put every
    // "Image N …" onto a single line, as in this session's article).
    if (im) { flushPara(); curPromptKey = im[1]; state.prompts[curPromptKey] = (im[2] || "").trim(); i++; continue; }
    if (skipSection && curPromptKey != null && t) {
      state.prompts[curPromptKey] = (state.prompts[curPromptKey] ? state.prompts[curPromptKey] + " " : "") + tClean;
      i++; continue;
    }

    const hm = t.match(/^(#{1,3})\s+(.*)$/);
    if (hm) {
      flushPara();
      const wasAppendix = skipSection;
      skipSection = /image prompts/i.test(hm[2]);  // drop the prompt appendix from the article
      if (wasAppendix && !skipSection) curPromptKey = null;  // leaving the appendix, stop accumulating
      if (!skipSection) state.blocks.push({ type: "h" + hm[1].length, text: hm[2].trim() });
      i++; continue;
    }
    // Also recognise a plain-caps "IMAGE PROMPTS" line as the appendix marker (no #), because
    // Claude's SEO-suite template writes it that way. Without this, the appendix leaked into the
    // article body and no AI-prompt text was captured for the slot cards.
    if (!skipSection && /^\*{0,2}image\s+prompts\b/i.test(tClean)) {
      flushPara();
      skipSection = true;
      i++; continue;
    }

    const mm = t.match(MARKER_RE);
    if (mm) {
      flushPara();
      const num = mm[2] || String(1000 + ++autoNum), payload = mm[3].trim(), restSameLine = stripEmph((mm[4] || "").trim());
      let slot;
      if (/^diagram$/i.test(mm[1]) || /\.(png|jpe?g|webp|avif|gif)\s*$/i.test(payload)) {
        const base = payload.split(/[\\/]/).pop().replace(/\.(png|jpe?g|webp|avif|gif)$/i, "").toLowerCase();
        slot = { kind: "diagram", num, file: base, label: payload };
      } else if (/^external/i.test(mm[1]) || /external/i.test(payload)) {
        // one or more quoted search terms — e.g. **[External image → search "term one" and "term two"]**
        const quotes = [...payload.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1].trim());
        const kw = quotes.length
          ? quotes.join("  ·  or  ·  ")
          : payload.replace(/^external(\s+image)?[,·:]?\s*/i, "").replace(/search\s*(for)?:?\s*/i, "").trim();
        slot = { kind: "ext", num, keyword: kw, label: payload };
      } else if (/ai[- ]?generated/i.test(payload)) {
        slot = { kind: "ai", num, label: payload };
      } else {
        slot = { kind: "ai", num, label: payload };
      }
      // caption / alt: same line as the bracket first, then following lines as a fallback. Lines
      // matching ANNOTATION_RE (e.g. "Placement → ...") are skipped rather than stopping the scan
      // or getting silently swallowed as a paragraph — but genuinely unstructured prose still
      // stops the scan immediately, so real article text is never eaten by mistake.
      let j = i + 1;
      const inlineCA = restSameLine.match(INLINE_CAP_ALT_RE);
      if (inlineCA) {
        slot.caption = inlineCA[1].replace(/\*+/g, "").trim();
        slot.alt = inlineCA[2].replace(/\*+/g, "").trim();
      } else {
        let scanned = 0;
        while (j < lines.length && scanned < 8 && !(slot.caption && slot.alt)) {
          const s = lines[j].trim();
          if (!s) { j++; continue; }
          if (MARKER_RE.test(s)) break; // don't bleed into the next marker's own territory
          const cm = s.match(CAPTION_RE), am = s.match(ALT_RE);
          if (cm) { slot.caption = cm[1].trim(); j++; scanned++; continue; }
          if (am) { slot.alt = am[1].trim(); j++; scanned++; continue; }
          if (ANNOTATION_RE.test(s)) { j++; scanned++; continue; } // e.g. "Placement → ..." — ignore, keep looking
          break; // real prose, not a labeled annotation — stop, let the outer loop treat it as a paragraph
        }
      }
      i = j;
      slot.dataURL = null;
      state.slots.push(slot);
      if (!skipSection) state.blocks.push({ type: "slot", slot });
      continue;
    }

    if (t === "" || t === "---") { flushPara(); i++; continue; }
    paraBuf.push(t); i++;
  }
  flushPara();
  state.slots.forEach((s) => { if (s.kind === "ai") s.prompt = state.prompts[s.num] || ""; });
}

function renderAnalysis() {
  const d = state.slots.filter((s) => s.kind === "diagram").length;
  const a = state.slots.filter((s) => s.kind === "ai").length;
  const e = state.slots.filter((s) => s.kind === "ext").length;
  const box = $("analysis");
  box.classList.remove("hidden");
  box.innerHTML =
    `<div><span class="pill d">${d} diagram slots</span>` +
    `<span class="pill a">${a} AI image slots</span>` +
    `<span class="pill e">${e} external image slots</span></div>` +
    `<div>${state.blocks.filter((b) => b.type === "p").length} paragraphs, ` +
    `${state.blocks.filter((b) => b.type.startsWith("h")).length} headings, ` +
    `${state.blocks.filter((b) => b.type === "code").length} code blocks parsed. ` +
    `${Object.keys(state.prompts).length} prompts captured from the appendix.</div>`;
}

// ---------- step 4: diagram folder ----------
$("diagram-folder").addEventListener("change", async (ev) => {
  const files = [...ev.target.files].filter((f) => /image\//.test(f.type));
  for (const f of files) {
    const base = f.name.replace(/\.(png|jpe?g|webp|avif|gif)$/i, "").toLowerCase();
    state.diagramFiles[base] = await compressToDataURL(f, 1400, 0.85);
  }
  matchDiagrams();
  renderDiagramStatus();
});

function matchDiagrams() {
  state.slots.filter((s) => s.kind === "diagram").forEach((s) => {
    if (state.diagramFiles[s.file]) s.dataURL = state.diagramFiles[s.file];
  });
}

function renderDiagramStatus() {
  const wrap = $("diagram-status");
  wrap.innerHTML = "";
  state.slots.filter((s) => s.kind === "diagram").forEach((s) => {
    const card = document.createElement("div");
    card.className = "slot";
    card.innerHTML = `<h4>Image ${s.num}<span class="tag dg">diagram</span></h4>
      <div class="meta"><b>File →</b> ${esc(s.label)}</div>
      <div class="meta"><b>Caption →</b> ${esc(s.caption || "none")}</div>`;
    card.appendChild(makePasteZone(s, s.dataURL ? "Matched from folder ✓" : "Not found in folder. Click here and paste it, or click to browse."));
    wireCardActivatesZone(card);
    wrap.appendChild(card);
  });
}

// wires every [data-copy] button in a card to copy its value to the clipboard, with a brief
// "Copied ✓" confirmation before reverting to its own original label
function wireCopyButtons(card) {
  card.querySelectorAll("[data-copy]").forEach((cp) => {
    const label = cp.dataset.label || cp.textContent;
    cp.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(cp.dataset.copy);
      cp.textContent = "Copied ✓"; setTimeout(() => (cp.textContent = label), 1500);
    });
  });
}

// clicking anywhere on the card (outside a real button and outside the paste zone itself)
// activates the paste zone inside it, so Ctrl+V or the file picker works without having to
// aim for the small dashed rectangle specifically
function wireCardActivatesZone(card) {
  card.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const zone = card.querySelector(".pastezone");
    // .focus() only — NOT .click(). The zone's own click handler opens the native file picker
    // when empty, which should only happen from clicking the dashed zone itself on purpose, not
    // from clicking anywhere on the outer card. Focusing is enough to make Ctrl+V paste work.
    if (zone && !zone.contains(e.target)) zone.focus();
  });
}

// ---------- step 5/6: AI + external slots ----------
function renderSlots() {
  const ai = $("ai-slots"), ext = $("ext-slots");
  ai.innerHTML = ""; ext.innerHTML = "";
  state.slots.filter((s) => s.kind === "ai").forEach((s) => ai.appendChild(slotCard(s)));
  state.slots.filter((s) => s.kind === "ext").forEach((s) => ext.appendChild(slotCard(s)));
  $("ai-title").classList.toggle("hidden", !ai.children.length);
  $("ext-title").classList.toggle("hidden", !ext.children.length);
  unlock("step-images");
}

function slotCard(s) {
  const card = document.createElement("div");
  card.className = "slot";
  const tag = s.kind === "ai" ? '<span class="tag ai">AI · generate &amp; paste</span>' : '<span class="tag ext">external · find &amp; paste</span>';
  let inner = `<h4>Image ${s.num}${tag}</h4>`;
  if (s.kind === "ai") {
    inner += `<div class="prompt">${esc(s.prompt || "No prompt found for this number, paste any image.")}</div>
      <button type="button" class="copy" data-copy="${escAttr(s.prompt || "")}" data-label="Copy prompt">Copy prompt</button>`;
  } else {
    inner += `<div class="meta"><b>Search →</b> ${esc(s.keyword || s.label)}</div>
      <button type="button" class="copy" data-copy="${escAttr(s.keyword || s.label || "")}" data-label="Copy keyword">Copy keyword</button>`;
  }
  inner += `<div class="meta"><b>Caption →</b> ${esc(s.caption || "none")}</div>
    <div class="meta"><b>Alt →</b> ${esc(s.alt || "none")}</div>`;
  card.innerHTML = inner;
  card.appendChild(makePasteZone(s, "Click, then paste the image here (Ctrl+V)"));
  wireCopyButtons(card);
  wireCardActivatesZone(card);
  return card;
}

function makePasteZone(slot, emptyText) {
  const z = document.createElement("div");
  z.className = "pastezone" + (slot.dataURL ? " filled" : "");
  z.tabIndex = 0;
  const render = () => {
    z.innerHTML = slot.dataURL
      ? `<img src="${slot.dataURL}" alt=""><span class="state">Placed ✓ · paste again to replace</span>
         <button type="button" class="remove-img" title="Remove image">×</button>`
      : `<span class="state">${esc(emptyText)}</span>`;
    if (slot.dataURL) {
      z.querySelector(".remove-img").addEventListener("click", (e) => {
        e.stopPropagation();
        slot.dataURL = null;
        z.classList.remove("filled");
        render();
      });
    }
  };
  render();
  const set = async (blobOrFile) => {
    slot.dataURL = await compressToDataURL(blobOrFile, 1400, 0.85);
    z.classList.add("filled");
    render();
  };
  z.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (item) { e.preventDefault(); set(item.getAsFile()); }
  });
  z.addEventListener("dragover", (e) => e.preventDefault());
  z.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
    if (f) set(f);
  });
  z.addEventListener("click", () => {
    if (z.querySelector("img")) { z.focus(); return; }
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.onchange = () => inp.files[0] && set(inp.files[0]);
    inp.click();
  });
  return z;
}

// shrink any image to a web-friendly JPEG data URL
function compressToDataURL(file, maxW, q) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", q));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

// ---------- step 7/8: compile + preview ----------
document.querySelectorAll("[data-goto]").forEach((b) =>
  b.addEventListener("click", () => { unlock(b.dataset.goto); scrollTo_(b.dataset.goto); }));

$("compile").addEventListener("click", () => {
  matchDiagrams();
  const prev = $("preview");
  prev.innerHTML = "";
  prev.appendChild(el("h1", state.title));
  if (state.subtitle) { const s = el("p", state.subtitle); s.className = "sub"; prev.appendChild(s); }
  state.blocks.forEach((b) => {
    if (b.type === "p") { const p = document.createElement("p"); p.innerHTML = inline(b.text); prev.appendChild(p); }
    else if (b.type === "h1" || b.type === "h2" || b.type === "h3") prev.appendChild(el(b.type === "h1" ? "h2" : "h2", b.text));
    else if (b.type === "code") {
      // <pre><code> — not bare <pre>text</pre>. Import tools generally recognize the standard
      // HTML5 code-block shape and preserve it; a bare <pre> with no <code> child was apparently
      // being treated as unrecognized markup and dropped on Medium import, same failure class as
      // the data:-URI images fixed earlier.
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = b.text;
      pre.appendChild(code);
      prev.appendChild(pre);
    }
    else if (b.type === "slot") prev.appendChild(slotFigure(b.slot));
  });
  unlock("step-preview"); scrollTo_("step-preview");
});

function slotFigure(s) {
  if (!s.dataURL) {
    const d = document.createElement("div");
    d.className = "missing";
    d.contentEditable = "false";
    d.textContent = `Image ${s.num} (${s.kind}) is missing. Go back and paste it, then press Compile again.`;
    return d;
  }
  // Caption is a plain sibling <p> after the <figure>, not nested inside a <figcaption> —
  // Medium's story importer was dropping the figcaption's text entirely even though the image
  // itself (and its alt attribute) came through fine, matching the same pattern as the
  // data:-URI images and bare <pre> code blocks fixed earlier: it wants flatter, more
  // conventional article-body markup, not semantically-nested structures.
  const frag = document.createDocumentFragment();
  const f = document.createElement("figure");
  const img = document.createElement("img");
  img.src = s.dataURL; img.alt = s.alt || s.caption || `Image ${s.num}`;
  f.appendChild(img);
  frag.appendChild(f);
  if (s.caption || s.alt) {
    const cap = document.createElement("p");
    cap.className = "img-caption";
    cap.innerHTML = (s.caption ? `<em>${esc(s.caption)}</em>` : "") +
      (s.alt ? `<span class="alt-note">alt · ${esc(s.alt)}</span>` : "");
    frag.appendChild(cap);
  }
  return frag;
}

const el = (t, text) => { const n = document.createElement(t); n.textContent = text; return n; };
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const escAttr = (s) => esc(s).replace(/'/g, "&#39;");
const inline = (t) => esc(t)
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/\*([^*]+)\*/g, "<em>$1</em>");

// ---------- step 9: publish ----------
function exportHTML() {
  const body = $("preview").cloneNode(true);
  body.removeAttribute("contenteditable");
  body.querySelectorAll(".missing").forEach((n) => n.remove());
  body.querySelectorAll(".alt-note").forEach((n) => n.remove());
  const css = `body{margin:0;background:#fff;color:#191a1e;font-family:Georgia,serif;line-height:1.7}
article{max-width:700px;margin:0 auto;padding:48px 20px 90px;font-size:18px}
h1{font-size:2.1em;line-height:1.15;margin:.4em 0 .2em}h2{font-size:1.45em;margin:1.6em 0 .5em;line-height:1.25}
.sub{font-style:italic;color:#6d6f78;font-size:1.15em;margin-bottom:1.4em}
p{margin:0 0 1em}figure{margin:1.6em 0 .3em}figure img{max-width:100%;display:block;border-radius:8px}
.img-caption{font-family:system-ui,sans-serif;font-size:.75em;color:#6d6f78;margin:0 0 1.6em}
pre{background:#f1f1ee;border-radius:10px;padding:16px 18px;overflow-x:auto;font-size:.72em;line-height:1.55}
pre code{font-family:Consolas,Menlo,monospace;white-space:pre}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(state.title)}</title>
<meta name="description" content="${esc(state.subtitle)}">
<style>${css}</style></head><body><article>${body.innerHTML}</article></body></html>`;
}

const slugify = () =>
  state.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "article";

// Tracks which stored item (if any) the wizard was loaded from via Resume. While set, publishing
// or saving a draft overwrites that SAME pathname (true in-place update, same link) instead of
// minting a new one. Cleared whenever the kind being saved (draft vs published) no longer matches
// where it came from, since an overwrite across that boundary isn't allowed server-side anyway.
let resumedPathname = null;

function buildSnapshot() {
  // Deliberately text-only. Images are NOT duplicated here — they already live once inside the
  // compiled `html` being uploaded in the same request, and Vercel Functions hard-cap request
  // bodies at 4.5 MB (platform-level, not configurable). Duplicating every image a second time
  // into the snapshot was the actual cause of "Server said 413" on ordinary publishes — fixed by
  // recovering images for Resume from the already-published HTML instead (see resumeArticle).
  return {
    title: $("title").value.trim(),
    subtitle: $("subtitle").value.trim(),
    bodyRaw: $("body").value,
  };
}

// Medium's story importer (and most "import a page" tools) fetch each <img src> over HTTP to
// re-host it on their own CDN. A data: URI has nothing to fetch — no separate network resource
// exists — so images embedded that way (exportHTML's default, for the live in-app preview) were
// silently dropped on import even though the text came through fine. Fixed by uploading each
// still-data:-URI image to its own real Blob URL via /api/upload-image and rewriting the <img
// src> to point there before the HTML goes to /api/publish. Images already hosted from an
// earlier publish (e.g. after Resume, whose src is already a real /api/view link, not data:)
// are correctly skipped — nothing to re-upload.
// In the extension build the wizard is an extension page, not served from the Vercel app, so a
// relative "/api/..." would resolve to chrome-extension://… and fail. Point at the deployed app
// (allowed by host_permissions in manifest.json). Images still get hosted to real URLs so a paste
// into Medium can fetch them; the UI stays fully self-contained.
const AF_API_BASE = "https://medium-formatter.vercel.app";
async function hostImagesInline(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = [...doc.querySelectorAll("img")].filter((img) => (img.getAttribute("src") || "").startsWith("data:"));
  await Promise.all(imgs.map(async (img) => {
    const r = await fetch(AF_API_BASE + "/api/upload-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataURL: img.getAttribute("src") }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Image upload failed (${r.status})`);
    img.setAttribute("src", data.url);
  }));
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

// One click, fully automatic: uploads any not-yet-hosted images first (see hostImagesInline
// above), then posts the resulting HTML (plus a raw-input snapshot for Resume) to /api/publish
// (a Vercel serverless function backed by Vercel Blob storage). The endpoint uploads it, gets a
// real public URL back immediately, and — for a real publish, not a draft — enforces a rolling
// window (MAX_ARTICLES most recent stay live, older ones deleted automatically). Requires this
// app to be deployed on Vercel with a Blob store connected (a static host like GitHub Pages has
// no serverless runtime, so /api/publish 404s there — see README).
async function publishArticle(isDraft) {
  const res = $("publish-result");
  res.classList.remove("hidden", "error");
  res.textContent = "Uploading images…";
  try {
    const html = await hostImagesInline(exportHTML());
    res.textContent = isDraft ? "Saving draft…" : "Publishing…";
    const prefix = isDraft ? "drafts/" : "articles/";
    const overwritePathname = resumedPathname && resumedPathname.startsWith(prefix) ? resumedPathname : undefined;
    const r = await fetch("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slugify(), html, draft: isDraft, snapshot: buildSnapshot(), overwritePathname }),
    });
    let data;
    try { data = await r.json(); } catch { data = { error: `Server said ${r.status} ${r.statusText}` }; }
    if (!r.ok) throw new Error(data.error || r.statusText);
    resumedPathname = data.pathname || null;
    const label = isDraft ? "Draft saved." : "Published.";
    const note = isDraft
      ? "Drafts aren't limited or auto-deleted — find it any time on the Manage page."
      : `Keeping your ${data.kept} most recent article${data.kept === 1 ? "" : "s"} live` +
        (data.deleted ? `, removed ${data.deleted} older one${data.deleted === 1 ? "" : "s"}` : "") + ".";
    res.innerHTML = `<b>${label}</b> Copy this link and use it wherever you need to import the story.<br>
      <a href="${data.url}" target="_blank" rel="noopener">${data.url}</a>
      <button class="copy" id="copy-link" style="margin-left:10px">Copy link</button>
      <br><small>${note}${overwritePathname ? " Updated in place — same link as before." : ""}</small>`;
    $("copy-link").onclick = () => navigator.clipboard.writeText(data.url);
  } catch (err) {
    res.classList.add("error");
    res.innerHTML = `<b>${isDraft ? "Save draft" : "Publish"} failed.</b> ${esc(err.message)}<br>
      Make sure this app is deployed on Vercel with a Blob store connected (README has the steps).`;
  }
}
// The link-flow buttons (Publish / Save as draft) don't exist in the extension's self-contained
// wizard page — it sends straight to Medium instead of minting a shareable link. Guard the wiring
// so their absence doesn't throw and halt the rest of the script.
$("publish")?.addEventListener("click", () => publishArticle(false));
$("save-draft")?.addEventListener("click", () => publishArticle(true));

// Copy the finished article to the clipboard as rich HTML so it can be pasted STRAIGHT into
// Medium's editor (Ctrl/Cmd+V), bypassing "Import a story" entirely. This exists because Medium's
// async story-importer — a different, stricter code path than its live in-editor paste handler —
// demonstrably injects an empty heading after every heading and an empty code block after every
// real one, collapses code-block newlines onto a single line, and breaks ASCII art, all while the
// HTML we hand it (visible as importData.postHTML on the imported page) is clean and correct. The
// paste handler, the same one that faithfully ingests pasted Google-Docs/Word content, does none
// of that. Images are pre-hosted (same as Publish) so their <img src> is a real URL Medium's paste
// handler can fetch and re-host; a data: URI would be dropped. Captions ride along as a plain
// italic paragraph after each figure (how Medium authors caption anyway). Alt text is the one
// thing a paste can't carry — Medium sets it through a separate dialog — so it's intentionally left
// off here; that gap is exactly what the DOM-driving browser extension would fill.
// Rewrite the sibling `<p class="img-caption"><em>text</em></p>` back into a nested
// `<figcaption>text</figcaption>` inside the preceding `<figure>`. Two flows in this app want
// opposite shapes for the same reason (Medium behaves differently on each path):
//   - Publish/Import: Medium's story importer DROPS `<figcaption>` text on ingest, so exportHTML
//     leaves captions as flat sibling `<p>`s to survive that path.
//   - Paste/Send: Medium's live-editor PASTE handler is the opposite — it only recognises a
//     caption inside `<figcaption>`; a sibling italic paragraph just becomes normal body italic
//     and Medium's caption slot stays empty. This function converts the flat form back into the
//     nested form right before the paste flow reads the HTML.
function articleForPaste(articleEl) {
  articleEl.querySelectorAll("figure").forEach((fig) => {
    const next = fig.nextElementSibling;
    if (!next || !next.classList || !next.classList.contains("img-caption")) return;
    // The caption paragraph body is `<em>caption text</em>[<span class="alt-note">alt · ...</span>]`
    // — pull only the caption text. exportHTML already strips alt-note; belt-and-braces here too.
    const clone = next.cloneNode(true);
    clone.querySelectorAll(".alt-note").forEach((n) => n.remove());
    const capText = (clone.textContent || "").trim();
    next.remove();
    if (!capText) return;
    const fc = articleEl.ownerDocument.createElement("figcaption");
    fc.textContent = capText;
    fig.appendChild(fc);
  });
  return articleEl;
}

async function copyForMedium() {
  const res = $("publish-result");
  res.classList.remove("hidden", "error");
  res.textContent = "Hosting images…";
  try {
    const fullHtml = await hostImagesInline(exportHTML());
    const doc = new DOMParser().parseFromString(fullHtml, "text/html");
    const article = articleForPaste(doc.querySelector("article"));
    const html = article.innerHTML;
    const text = article.textContent;
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error("This browser can't write rich text to the clipboard. Use Publish + Import instead, or try Chrome.");
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    res.innerHTML = `<b>Copied.</b> Open a <b>new Medium story</b> and press
      <b>Ctrl/Cmd&nbsp;+&nbsp;V</b> straight into the editor — do <i>not</i> use Import a story.<br>
      <small>Headings, code blocks, and the ASCII table come through Medium's paste handler intact.
      Alt text can't travel in a paste (Medium sets it in a separate dialog) — say the word if you
      want the browser-extension route that fills alt tags too.</small>`;
  } catch (err) {
    res.classList.add("error");
    res.innerHTML = `<b>Copy failed.</b> ${esc(err.message)}`;
  }
}
$("copy-medium")?.addEventListener("click", copyForMedium);

// ---------- extension-only: send straight to the open Medium draft ----------------------------
// Self-contained flow's step 6. Builds the finished article (hosting images to real URLs first,
// exactly like Copy for Medium), then hands {bodyHTML, text, alts} to the background service
// worker, which relays it to the content script running in an open Medium story-edit tab. That
// content script pastes the body (Medium's paste handler keeps code/ASCII/captions) and fills each
// image's alt via Medium's alt dialog. `chrome` is defined because this runs as an extension page;
// on the plain web app (no chrome.runtime) the button simply isn't present.
async function sendToMedium() {
  const res = $("publish-result");
  if (!res) return;
  res.classList.remove("hidden", "error");
  res.textContent = "Hosting images…";
  try {
    const fullHtml = await hostImagesInline(exportHTML());
    const doc = new DOMParser().parseFromString(fullHtml, "text/html");
    const article = articleForPaste(doc.querySelector("article"));
    const alts = [...article.querySelectorAll("figure img")].map((im) => (im.getAttribute("alt") || "").trim());
    const payload = { bodyHTML: article.innerHTML, text: article.textContent, alts };

    res.textContent = "Sending to your open Medium draft…";
    const reply = await chrome.runtime.sendMessage({ type: "af-send", payload });
    if (!reply || !reply.ok) {
      throw new Error((reply && reply.error) || "No open Medium story-edit tab was found. Open a Medium draft (…/edit) in another tab, then try again.");
    }
    res.innerHTML = `<b>Sent to Medium.</b> ${esc(reply.summary || "Check the draft tab.")}<br>
      <small>Switch to the Medium tab to review. If the body didn't insert, use <b>Copy for Medium</b>
      above, paste with Ctrl/Cmd+V yourself, then click <b>Fill alt tags</b> in the Medium panel.</small>`;
  } catch (err) {
    res.classList.add("error");
    res.innerHTML = `<b>Send failed.</b> ${esc(err.message)}`;
  }
}
$("send-medium")?.addEventListener("click", sendToMedium);

// ---------- resume: reload a stored item's raw inputs back into the wizard ----------
// Called either from the Manage page (via a ?resume=<pathname> link, since Manage is a separate
// page and can't reach into this page's DOM directly) or in principle from anywhere with a
// pathname. skipConfirm is true for the query-param case, since navigating here already was the
// confirmation — there's no "current wizard progress" to protect on a fresh page load.
async function resumeArticle(pathname, skipConfirm) {
  if (!skipConfirm && !confirm("Load this into the wizard? Any unsaved current progress will be replaced.")) return;
  try {
    const [snapRes, htmlRes] = await Promise.all([
      fetch(`/api/snapshot?pathname=${encodeURIComponent(pathname)}`),
      fetch(`/api/view?pathname=${encodeURIComponent(pathname)}`),
    ]);
    const snap = await snapRes.json();
    if (!snapRes.ok) throw new Error(snap.error || snapRes.statusText);
    const compiledHtml = htmlRes.ok ? await htmlRes.text() : "";

    resumedPathname = pathname;
    $("title").value = snap.title || "";
    $("subtitle").value = snap.subtitle || "";
    $("body").value = snap.bodyRaw || "";
    state.title = snap.title || "";
    state.subtitle = snap.subtitle || "";

    parseBody(snap.bodyRaw || "");

    // Images live only in the compiled HTML (not the snapshot — see buildSnapshot). Recover them
    // by matching each freshly re-parsed slot's caption text against the published article's own
    // caption element. Current articles carry the caption as a sibling <p class="img-caption">
    // after the <figure> (see slotFigure); articles published before that change still have it
    // nested inside a <figcaption> — check both shapes so Resume keeps working on older articles.
    if (compiledHtml) {
      const doc = new DOMParser().parseFromString(compiledHtml, "text/html");
      const captionToSrc = new Map();
      doc.querySelectorAll("figure").forEach((fig) => {
        const img = fig.querySelector("img");
        if (!img) return;
        const sib = fig.nextElementSibling;
        const capEl = sib && sib.classList.contains("img-caption") ? sib : fig.querySelector("figcaption");
        if (!capEl) return;
        const clone = capEl.cloneNode(true);
        clone.querySelectorAll(".alt-note").forEach((n) => n.remove());
        const capText = clone.textContent.trim();
        if (capText) captionToSrc.set(capText, img.getAttribute("src"));
      });
      state.slots.forEach((s) => {
        const src = captionToSrc.get((s.caption || "").trim());
        if (src) s.dataURL = src;
      });
    }

    renderAnalysis();
    renderSlots();
    renderDiagramStatus();
    ["step-subtitle", "step-body", "step-diagrams", "step-images", "step-preview"].forEach(unlock);
    scrollTo_("step-images");
  } catch (err) {
    alert("Couldn't resume: " + err.message);
  }
}

// Arrived via a Resume link from the Manage page (index.html?resume=<encoded pathname>) — load it
// automatically, then clean the URL so a reload doesn't re-trigger it.
(function checkResumeParam() {
  const params = new URLSearchParams(location.search);
  const pathname = params.get("resume");
  if (pathname) {
    resumeArticle(pathname, true);
    history.replaceState(null, "", location.pathname);
  }
})();
