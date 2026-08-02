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
      if (inCode) { if (!skipSection) state.blocks.push({ type: "code", text: codeBuf.join("\n") }); codeBuf = []; }
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
    if (im) { flushPara(); curPromptKey = im[1]; state.prompts[curPromptKey] = ""; i++; continue; }
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
    if (zone && !zone.contains(e.target)) zone.click();
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
    else if (b.type === "code") { const pre = document.createElement("pre"); pre.textContent = b.text; prev.appendChild(pre); }
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
  const f = document.createElement("figure");
  const img = document.createElement("img");
  img.src = s.dataURL; img.alt = s.alt || s.caption || `Image ${s.num}`;
  f.appendChild(img);
  const fc = document.createElement("figcaption");
  fc.innerHTML = esc(s.caption || "") +
    (s.alt ? `<span class="alt-note">alt · ${esc(s.alt)}</span>` : "");
  f.appendChild(fc);
  return f;
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
p{margin:0 0 1em}figure{margin:1.6em 0}figure img{max-width:100%;display:block;border-radius:8px}
figcaption{font-family:system-ui,sans-serif;font-size:.75em;color:#6d6f78;margin-top:.6em}
pre{background:#f1f1ee;border-radius:10px;padding:16px 18px;overflow-x:auto;font-size:.72em;line-height:1.55}`;
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

// One click, fully automatic: posts the compiled HTML (plus a raw-input snapshot for Resume) to
// /api/publish (a Vercel serverless function backed by Vercel Blob storage). The endpoint uploads
// it, gets a real public URL back immediately, and — for a real publish, not a draft — enforces a
// rolling window (MAX_ARTICLES most recent stay live, older ones deleted automatically). Requires
// this app to be deployed on Vercel with a Blob store connected (a static host like GitHub Pages
// has no serverless runtime, so /api/publish 404s there — see README).
async function publishArticle(isDraft) {
  const res = $("publish-result");
  res.classList.remove("hidden", "error");
  res.textContent = isDraft ? "Saving draft…" : "Publishing…";
  try {
    const html = exportHTML();
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
$("publish").addEventListener("click", () => publishArticle(false));
$("save-draft").addEventListener("click", () => publishArticle(true));

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
    // <figcaption> elements; a slot with no matching caption (never filled originally) is simply
    // left empty, same as it was.
    if (compiledHtml) {
      const doc = new DOMParser().parseFromString(compiledHtml, "text/html");
      const captionToSrc = new Map();
      doc.querySelectorAll("figure").forEach((fig) => {
        const img = fig.querySelector("img");
        const cap = fig.querySelector("figcaption");
        if (img && cap) captionToSrc.set(cap.textContent.trim(), img.getAttribute("src"));
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
