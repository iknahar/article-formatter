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

// ---------- step 1 → 2: subtitle suggestions ----------
document.querySelector('#step-title .next').addEventListener("click", () => {
  state.title = $("title").value.trim();
  if (!state.title) { $("title").focus(); return; }
  buildSubtitleOptions(state.title);
  unlock("step-subtitle"); scrollTo_("step-subtitle");
});

function buildSubtitleOptions(title) {
  const opts = [
    `${title.replace(/\.$/, "")}, explained the way a friend would explain it`,
    "A beginner's tour with real stories, diagrams, and working code",
    "Everything you need to understand it, told like a story",
    "From zero to genuinely getting it, one diagram at a time",
    "The plain-English version, with jokes and working Python",
    "Write my own…",
  ];
  const sel = $("subtitle-select");
  sel.innerHTML = "";
  opts.forEach((o, i) => {
    const el = document.createElement("option");
    el.value = i === opts.length - 1 ? "__custom__" : o;
    el.textContent = o;
    sel.appendChild(el);
  });
  sel.onchange = () => {
    $("subtitle-custom").classList.toggle("hidden", sel.value !== "__custom__");
    if (sel.value === "__custom__") $("subtitle-custom").focus();
  };
}
document.querySelector('#step-subtitle .next').addEventListener("click", () => {
  const sel = $("subtitle-select");
  state.subtitle = sel.value === "__custom__" ? $("subtitle-custom").value.trim() : sel.value;
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
const MARKER_RE = /^\*{0,2}\[\s*(?:Place\s+)?(Diagram|Image)\s+(\d+)\s*(?:→|·|-|—)\s*([^\]]+?)\]\*{0,2}\s*(.*)$/i;
const CAPTION_RE = /^\*{1,2}Caption\s*→\s*(.+?)\*{1,2}\s*$/i;
const ALT_RE = /^\*{1,2}Alt\s*→\s*(.+?)\*{1,2}\s*$/i;
const INLINE_CAP_ALT_RE = /Caption\s*→\s*(.*?)\s*Alt\s*→\s*(.*)$/i;
// unwrap markdown emphasis so brackets/captions read as plain text regardless of ** / * wrapping
const stripEmph = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

function parseBody(raw) {
  state.blocks = []; state.prompts = {}; state.slots = [];
  const lines = raw.replace(/\r/g, "").split("\n");
  let i = 0, inCode = false, codeBuf = [], paraBuf = [], skipSection = false, curPromptKey = null;

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
      const num = mm[2], payload = mm[3].trim(), restSameLine = stripEmph((mm[4] || "").trim());
      let slot;
      if (/^diagram$/i.test(mm[1]) || /\.(png|jpe?g|webp|avif|gif)\s*$/i.test(payload)) {
        const base = payload.split(/[\\/]/).pop().replace(/\.(png|jpe?g|webp|avif|gif)$/i, "").toLowerCase();
        slot = { kind: "diagram", num, file: base, label: payload };
      } else if (/ai[- ]?generated/i.test(payload)) {
        slot = { kind: "ai", num, label: payload };
      } else if (/external/i.test(payload)) {
        const kw = (payload.match(/["“]([^"”]+)["”]/) || [, payload.replace(/external[,·]?\s*(search)?/i, "").trim()])[1];
        slot = { kind: "ext", num, keyword: kw.trim(), label: payload };
      } else {
        slot = { kind: "ai", num, label: payload };
      }
      // caption / alt: same line as the bracket first, then following lines as a fallback
      let j = i + 1;
      const inlineCA = restSameLine.match(INLINE_CAP_ALT_RE);
      if (inlineCA) {
        slot.caption = inlineCA[1].replace(/\*+/g, "").trim();
        slot.alt = inlineCA[2].replace(/\*+/g, "").trim();
      } else {
        while (j < lines.length) {
          const s = lines[j].trim();
          if (!s) { j++; continue; }
          const cm = s.match(CAPTION_RE), am = s.match(ALT_RE);
          if (cm) { slot.caption = cm[1].trim(); j++; continue; }
          if (am) { slot.alt = am[1].trim(); j++; continue; }
          break;
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
    wrap.appendChild(card);
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
      <button class="copy" data-copy="${escAttr(s.prompt || "")}">Copy prompt</button>`;
  } else {
    inner += `<div class="meta"><b>Search →</b> ${esc(s.keyword || s.label)}</div>`;
  }
  inner += `<div class="meta"><b>Caption →</b> ${esc(s.caption || "none")}</div>
    <div class="meta"><b>Alt →</b> ${esc(s.alt || "none")}</div>`;
  card.innerHTML = inner;
  card.appendChild(makePasteZone(s, "Click, then paste the image here (Ctrl+V)"));
  const cp = card.querySelector(".copy");
  if (cp) cp.addEventListener("click", () => {
    navigator.clipboard.writeText(cp.dataset.copy);
    cp.textContent = "Copied ✓"; setTimeout(() => (cp.textContent = "Copy prompt"), 1500);
  });
  return card;
}

function makePasteZone(slot, emptyText) {
  const z = document.createElement("div");
  z.className = "pastezone" + (slot.dataURL ? " filled" : "");
  z.tabIndex = 0;
  z.innerHTML = slot.dataURL
    ? `<img src="${slot.dataURL}" alt=""><span class="state">Placed ✓ · paste again to replace</span>`
    : `<span class="state">${esc(emptyText)}</span>`;
  const set = async (blobOrFile) => {
    slot.dataURL = await compressToDataURL(blobOrFile, 1400, 0.85);
    z.classList.add("filled");
    z.innerHTML = `<img src="${slot.dataURL}" alt=""><span class="state">Placed ✓ · paste again to replace</span>`;
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

// GitHub Pages token persistence
$("gh-token").value = localStorage.getItem("gh-token") || "";
$("gh-token").addEventListener("change", () =>
  localStorage.setItem("gh-token", $("gh-token").value.trim()));

const slugify = () =>
  state.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "article";

// unicode-safe base64 for the GitHub contents API
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function publishToGitHub(html) {
  const owner = $("gh-owner").value.trim(), repo = $("gh-repo").value.trim(),
        branch = $("gh-branch").value.trim() || "main",
        token = $("gh-token").value.trim();
  if (!token) throw new Error("Paste your GitHub token first (see the README for how to create one).");
  const path = `articles/${slugify()}-${Date.now().toString(36)}.html`;
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: `Publish article: ${state.title}`, content: toBase64(html), branch }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `GitHub said ${r.status}`);
  return { url: `https://${owner}.github.io/${repo}/${path}`,
           note: "GitHub Pages takes ~1 minute to rebuild. If the link 404s, wait a moment and refresh before importing." };
}

$("publish").addEventListener("click", async () => {
  const res = $("publish-result");
  res.classList.remove("hidden", "error");
  res.textContent = "Publishing…";
  try {
    const html = exportHTML();
    const out = await publishToGitHub(html);
    res.innerHTML = `<b>Published.</b> Copy this link and use it wherever you need to import the story.<br>
      <a href="${out.url}" target="_blank" rel="noopener">${out.url}</a>
      <button class="copy" id="copy-link" style="margin-left:10px">Copy link</button>
      ${out.note ? `<br><small>${esc(out.note)}</small>` : ""}`;
    $("copy-link").onclick = () => navigator.clipboard.writeText(out.url);
  } catch (err) {
    res.classList.add("error");
    res.innerHTML = `<b>Publish failed.</b> ${esc(err.message)}<br>
      Check the token and that Pages is enabled (README has the steps).
      Either way <b>Download HTML instead</b> always works.`;
  }
});

$("download").addEventListener("click", () => {
  const blob = new Blob([exportHTML()], { type: "text/html" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.title || "article").toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".html";
  a.click();
});
