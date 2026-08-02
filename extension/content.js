// Article Formatter — Medium helper (content script)
// =====================================================================================
// Runs on any medium.com page. On a story-edit page it mounts a small panel bottom-right
// that IS the assembly UI: the body-copy textarea shows immediately (no click to reveal),
// and clicking Next replaces the visible fields with the next step's fields in place.
// Steps: Body copy → Diagram folder → AI images → External images → Assemble (compiles
// the article and inserts it into the Medium editor beneath, then fills alt + captions).
//
// The core wizard logic (parser, slot rendering, hostImagesInline, exportHTML,
// articleForPaste) is a native part of this file — no iframe, no wizard tab hop. That
// duplicates ~250 lines from the standalone-tab wizard.js, but keeping them together in
// content.js is what lets the panel render its own fields directly.
// =====================================================================================

(function () {
  if (window.__afMediumHelper) return;
  window.__afMediumHelper = true;

  const AF_API_BASE = "https://medium-formatter.vercel.app";

  // ================= wizard state =====================================================
  const state = {
    bodyRaw: "",
    blocks: [],       // parsed article blocks in order
    prompts: {},      // number → prompt text
    slots: [],        // image/diagram slots found in the body
    diagramFiles: {}, // basename(lowercase, no ext) → dataURL
    step: "body",     // "body" | "diagrams" | "ai" | "ext"
  };

  // ================= tiny helpers =====================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!(el && el.offsetParent !== null);
  const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const escAttr = (s) => esc(s).replace(/'/g, "&#39;");
  const inline = (t) => esc(t)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  function waitFor(fn, timeout = 3000, interval = 100) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function tick() {
        let v = null; try { v = fn(); } catch { v = null; }
        if (v) return resolve(v);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval);
      })();
    });
  }

  function fireMouse(el, type) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
  }

  // ================= parser (marker syntax same as wizard.js) =========================
  // The regex set below is intentionally identical to the standalone wizard's parser so the
  // exact same article text is accepted here. See wizard.js head-of-file comments for the
  // range of marker shapes we tolerate.
  const MARKER_RE = /^\*{0,2}\[\s*(?:Place\s+)?(Diagram|Image|External(?:\s+image)?)\s*(\d+)?\s*(?:→|·|-|—)\s*([^\]]+?)\]\*{0,2}\s*(.*)$/i;
  const ANNOTATION_RE = /^\*{0,2}[A-Za-z][\w\s]{0,24}?\s*(?:→|->)/;
  const CAPTION_RE = /^\*{0,2}Caption\s*(?:→|->|:)\s*(.+?)\*{0,2}\s*$/i;
  const ALT_RE = /^\*{0,2}Alt\s*(?:→|->|:)\s*(.+?)\*{0,2}\s*$/i;
  const INLINE_CAP_ALT_RE = /Caption\s*(?:→|->|:)\s*(.*?)\s*Alt\s*(?:→|->|:)\s*(.*)$/i;
  const stripEmph = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

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
          const codeText = codeBuf.join("\n");
          if (!skipSection && codeText.trim()) state.blocks.push({ type: "code", text: codeText });
          codeBuf = [];
        }
        inCode = !inCode; i++; continue;
      }
      if (inCode) { codeBuf.push(line); i++; continue; }
      const t = line.trim();
      const tClean = stripEmph(t);
      const pm = tClean.match(/^Prompt\s+(\d+)\b[,.]?\s*(.*)$/i);
      const im = !pm && tClean.match(/^Image\s+(\d+)\b[\s·:.,-]*(.*)$/i);
      if (pm) { flushPara(); curPromptKey = pm[1]; state.prompts[curPromptKey] = (pm[2] || "").trim(); i++; continue; }
      if (im) { flushPara(); curPromptKey = im[1]; state.prompts[curPromptKey] = (im[2] || "").trim(); i++; continue; }
      if (skipSection && curPromptKey != null && t) {
        state.prompts[curPromptKey] = (state.prompts[curPromptKey] ? state.prompts[curPromptKey] + " " : "") + tClean;
        i++; continue;
      }
      const hm = t.match(/^(#{1,3})\s+(.*)$/);
      if (hm) {
        flushPara();
        const wasAppendix = skipSection;
        skipSection = /image prompts/i.test(hm[2]);
        if (wasAppendix && !skipSection) curPromptKey = null;
        if (!skipSection) state.blocks.push({ type: "h" + hm[1].length, text: hm[2].trim() });
        i++; continue;
      }
      if (!skipSection && /^\*{0,2}image\s+prompts\b/i.test(tClean)) {
        flushPara(); skipSection = true; i++; continue;
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
          const quotes = [...payload.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1].trim());
          const kw = quotes.length
            ? quotes.join("  ·  or  ·  ")
            : payload.replace(/^external(\s+image)?[,·:]?\s*/i, "").replace(/search\s*(for)?:?\s*/i, "").trim();
          slot = { kind: "ext", num, keyword: kw, label: payload };
        } else {
          slot = { kind: "ai", num, label: payload };
        }
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
            if (MARKER_RE.test(s)) break;
            const cm = s.match(CAPTION_RE), am = s.match(ALT_RE);
            if (cm) { slot.caption = cm[1].trim(); j++; scanned++; continue; }
            if (am) { slot.alt = am[1].trim(); j++; scanned++; continue; }
            if (ANNOTATION_RE.test(s)) { j++; scanned++; continue; }
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

  function matchDiagrams() {
    state.slots.filter((s) => s.kind === "diagram").forEach((s) => {
      if (state.diagramFiles[s.file]) s.dataURL = state.diagramFiles[s.file];
    });
  }

  // ================= image compression ================================================
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

  // ================= slot figure / export HTML ========================================
  function slotFigure(s) {
    if (!s.dataURL) {
      const d = document.createElement("div");
      d.className = "af-missing";
      d.contentEditable = "false";
      d.textContent = `Image ${s.num} (${s.kind}) is missing.`;
      return d;
    }
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

  function buildArticleDOM() {
    matchDiagrams();
    const article = document.createElement("article");
    state.blocks.forEach((b) => {
      if (b.type === "p") { const p = document.createElement("p"); p.innerHTML = inline(b.text); article.appendChild(p); }
      else if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
        const h = document.createElement("h2"); h.textContent = b.text; article.appendChild(h);
      }
      else if (b.type === "code") {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = b.text;
        pre.appendChild(code);
        article.appendChild(pre);
      }
      else if (b.type === "slot") article.appendChild(slotFigure(b.slot));
    });
    return article;
  }

  // Move sibling <p class="img-caption"> back INTO a nested <figcaption> per figure, which is
  // what Medium's paste handler recognizes as the caption slot. Publish/Import needs the flat
  // shape (this app's standalone-wizard exportHTML emits it that way); the paste path needs the
  // nested one. This function does the transform right before we hand the HTML to Medium.
  function articleForPaste(articleEl) {
    articleEl.querySelectorAll("figure").forEach((fig) => {
      const next = fig.nextElementSibling;
      if (!next || !next.classList || !next.classList.contains("img-caption")) return;
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

  // Convert every data:-URI image to a same-origin blob: URL. Medium's paste handler needs to
  // fetch each <img src> to re-host on its own CDN; a data: URI has nothing at that "address"
  // (it isn't a network resource), so unhosted images used to get silently dropped on paste.
  // A blob: URL, by contrast, is a real fetchable resource — same origin as this Medium page,
  // lives entirely in this tab's memory, no server involved, no cost, no CORS. Medium fetches
  // it and uploads the bytes to Medium's own CDN, then rewrites the img src to their CDN URL.
  //
  // The blob URLs stay alive for the tab's lifetime — we don't revokeObjectURL, because
  // Medium's re-host happens async after the paste, and revoking too early would break it. The
  // memory cost is bounded (~1 MB per compressed image, tens of MB total worst case).
  function dataURLtoBlob(dataURL) {
    const commaIdx = dataURL.indexOf(",");
    if (commaIdx < 0) throw new Error("Malformed data URL");
    const meta = dataURL.slice(5, commaIdx);          // e.g. "image/jpeg;base64"
    const mime = (meta.match(/^([^;]+)/) || [])[1] || "application/octet-stream";
    const raw = dataURL.slice(commaIdx + 1);
    let bytes;
    if (/;base64/i.test(meta)) {
      const bin = atob(raw);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(raw));
    }
    return new Blob([bytes], { type: mime });
  }

  async function prepareImagesForPaste(articleEl) {
    const imgs = [...articleEl.querySelectorAll("img")].filter((im) => (im.getAttribute("src") || "").startsWith("data:"));
    if (!imgs.length) return;
    log(`Preparing ${imgs.length} image${imgs.length === 1 ? "" : "s"} for paste (no hosting)…`);
    for (const img of imgs) {
      const blob = dataURLtoBlob(img.getAttribute("src"));
      const blobUrl = URL.createObjectURL(blob);
      img.setAttribute("src", blobUrl);
    }
  }

  // ================= panel + log ======================================================
  let logEl;
  let panelEl;
  function log(msg, kind) {
    if (!logEl) return;
    const color = kind === "err" ? "#c0392b" : kind === "warn" ? "#b9770e"
      : kind === "ok" ? "#1a7a4c" : "#3a3d46";
    const line = document.createElement("div");
    line.style.cssText = `color:${color};margin:2px 0;white-space:pre-wrap;word-break:break-word`;
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  const S = { // shared styles used across the stepper
    btn:
      "display:block;width:100%;margin:6px 0 0;padding:8px 10px;border-radius:9px;" +
      "border:1px solid #cdbf93;background:#f5c518;color:#26262b;font-weight:600;" +
      "font-size:13px;cursor:pointer;font-family:inherit",
    btnOutline:
      "display:block;width:100%;margin:6px 0 0;padding:8px 10px;border-radius:9px;" +
      "border:1px solid #cdbf93;background:#fff;color:#26262b;font-weight:500;" +
      "font-size:12.5px;cursor:pointer;font-family:inherit",
    linkish:
      "background:none;border:none;color:#3a6cbf;text-decoration:underline;cursor:pointer;" +
      "padding:0;font-size:11.5px;font-family:inherit",
    input:
      "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cdbf93;" +
      "border-radius:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px;" +
      "background:#fffefa;color:#26262b;resize:vertical",
    stepHead: "font-size:13px;font-weight:700;color:#3a3d46;margin:2px 0 4px",
    hint: "font-size:11.5px;color:#6d6f78;line-height:1.4;margin:0 0 6px",
    pill:
      "display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:9px;margin:0 4px 4px 0;" +
      "background:#f4efe0;color:#4c4a41;border:1px solid #e4dcc4",
    slot:
      "border:1px solid #e4dcc4;border-radius:10px;padding:8px 10px;margin:6px 0;background:#fffdf6",
    slotTitle: "font-size:12px;font-weight:700;color:#3a3d46;margin:0 0 4px",
    slotMeta: "font-size:11.5px;color:#4c617f;margin:2px 0;word-break:break-word",
    pasteZone:
      "aspect-ratio:3/2;width:100%;border:2px dashed #cdbf93;border-radius:8px;margin:6px 0 4px;" +
      "background:#fff;display:flex;align-items:center;justify-content:center;color:#8b8578;" +
      "font-size:11.5px;text-align:center;cursor:pointer;position:relative;overflow:hidden;outline:none",
  };

  function buildPanel() {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-af-panel", "1");
    wrap.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
      "width:400px", "max-width:calc(100vw - 32px)",
      "max-height:calc(100vh - 32px)", "display:flex", "flex-direction:column",
      "background:#fffdf9", "border:1px solid #d9d2bd", "border-radius:14px",
      "box-shadow:0 10px 30px rgba(0,0,0,.18)",
      "font-family:system-ui,-apple-system,Segoe UI,sans-serif", "color:#26262b",
      "font-size:13px", "line-height:1.45",
    ].join(";");

    const title = document.createElement("div");
    title.style.cssText = "font-weight:700;font-size:13.5px;margin:0;padding:10px 34px 4px 12px;flex:0 0 auto";
    title.textContent = "Article Formatter";
    const hide = document.createElement("button");
    hide.textContent = "×"; hide.title = "Hide";
    hide.style.cssText = "position:absolute;top:8px;right:10px;border:none;background:none;font-size:16px;line-height:1;color:#9a9585;cursor:pointer;font-family:inherit";
    hide.onclick = () => wrap.remove();

    const stepArea = document.createElement("div");
    stepArea.setAttribute("data-af-step-area", "1");
    stepArea.style.cssText = "padding:2px 12px 8px;overflow:auto;flex:1 1 auto";

    logEl = document.createElement("div");
    logEl.style.cssText = [
      "margin:0 12px 10px", "max-height:120px", "overflow:auto", "font-size:11.5px",
      "font-family:ui-monospace,Consolas,monospace", "background:#f4efe0",
      "border-radius:8px", "padding:6px 8px", "border:1px solid #e4dcc4", "flex:0 0 auto",
    ].join(";");

    wrap.append(title, stepArea, logEl, hide);
    document.body.appendChild(wrap);
    panelEl = wrap;
    log("Paste your article body below to start.");
    renderStep();
  }

  function ensurePanel() {
    if (document.querySelector('[data-af-panel]')) return;
    if (!findEditor()) return;
    buildPanel();
  }

  // ================= step renderers ===================================================
  function renderStep() {
    const area = document.querySelector('[data-af-step-area]');
    if (!area) return;
    area.innerHTML = "";
    if (state.step === "body") return renderBodyStep(area);
    if (state.step === "diagrams") return renderDiagramsStep(area);
    if (state.step === "ai") return renderAiStep(area);
    if (state.step === "ext") return renderExtStep(area);
  }

  function stepHead(area, n, title) {
    const h = document.createElement("div");
    h.style.cssText = S.stepHead;
    h.textContent = `${n}. ${title}`;
    area.appendChild(h);
  }

  function hint(area, html) {
    const p = document.createElement("div");
    p.style.cssText = S.hint;
    p.innerHTML = html;
    area.appendChild(p);
  }

  function primaryButton(area, label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = S.btn;
    b.onclick = onClick;
    area.appendChild(b);
    return b;
  }

  function outlineButton(area, label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = S.btnOutline;
    b.onclick = onClick;
    area.appendChild(b);
    return b;
  }

  // ---------- step 1: body copy -----------------------------------------------------
  function renderBodyStep(area) {
    stepHead(area, 1, "Body copy");
    hint(area, "Paste the whole article (SEO suite is fine — parsing starts after a line reading &quot;the body&quot; or &quot;the article&quot;).");

    const ta = document.createElement("textarea");
    ta.rows = 8;
    ta.value = state.bodyRaw || "";
    ta.style.cssText = S.input + ";min-height:180px";
    ta.placeholder = "Paste here…";
    area.appendChild(ta);

    const summary = document.createElement("div");
    summary.style.cssText = "margin-top:6px;min-height:20px";
    area.appendChild(summary);

    const analyze = () => {
      const raw = ta.value;
      if (!raw.trim()) { summary.innerHTML = ""; return; }
      try {
        parseBody(raw);
        state.bodyRaw = raw;
        const d = state.slots.filter((s) => s.kind === "diagram").length;
        const a = state.slots.filter((s) => s.kind === "ai").length;
        const e = state.slots.filter((s) => s.kind === "ext").length;
        summary.innerHTML =
          `<span style="${S.pill}">${d} diagram slot${d === 1 ? "" : "s"}</span>` +
          `<span style="${S.pill}">${a} AI image slot${a === 1 ? "" : "s"}</span>` +
          `<span style="${S.pill}">${e} external image slot${e === 1 ? "" : "s"}</span>`;
      } catch (err) {
        summary.textContent = "Couldn't parse: " + err.message;
      }
    };
    ta.addEventListener("input", analyze);
    ta.addEventListener("paste", () => setTimeout(analyze, 0));
    // Auto-analyze on load if state already has body text (e.g., re-render after back-nav).
    if (state.bodyRaw) analyze();

    primaryButton(area, "Next · Diagram folder →", () => {
      if (!ta.value.trim()) { ta.focus(); return; }
      state.bodyRaw = ta.value;
      parseBody(state.bodyRaw);
      state.step = "diagrams";
      renderStep();
    });

    // Small secondary: if the user already pasted the article into Medium manually and only
    // needs alt+captions filled, they can trigger that path without going through the wizard.
    const alreadyBtn = document.createElement("button");
    alreadyBtn.textContent = "Already pasted into Medium? Fill captions & alt";
    alreadyBtn.style.cssText = S.linkish + ";margin-top:8px";
    alreadyBtn.onclick = () => runFillFromClipboard();
    area.appendChild(alreadyBtn);
  }

  // ---------- step 2: diagram folder -------------------------------------------------
  function renderDiagramsStep(area) {
    stepHead(area, 2, "Diagram folder");
    hint(area, "Pick the folder holding your diagram files. They match to markers by filename.");

    const chooseWrap = document.createElement("label");
    chooseWrap.style.cssText = "display:block;" + S.btnOutline + ";text-align:center;cursor:pointer";
    chooseWrap.textContent = "Choose diagram folder";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.webkitdirectory = true;
    fileInput.multiple = true;
    fileInput.accept = "image/*";
    fileInput.style.cssText = "display:none";
    chooseWrap.appendChild(fileInput);
    area.appendChild(chooseWrap);

    const status = document.createElement("div");
    status.style.cssText = "margin-top:6px;font-size:11.5px";
    area.appendChild(status);

    const renderStatus = () => {
      const diagrams = state.slots.filter((s) => s.kind === "diagram");
      if (!diagrams.length) { status.innerHTML = '<i style="color:#6d6f78">No diagram markers found in your body.</i>'; return; }
      status.innerHTML = diagrams.map((s) => {
        const ok = !!s.dataURL;
        const color = ok ? "#1a7a4c" : "#b9770e";
        const mark = ok ? "✓" : "•";
        return `<div style="color:${color};margin:2px 0"><b>${mark}</b> ${esc(s.file)}${ok ? "" : " <span style='color:#6d6f78'>(not matched yet)</span>"}</div>`;
      }).join("");
    };
    renderStatus();

    fileInput.addEventListener("change", async (ev) => {
      const files = [...ev.target.files].filter((f) => /image\//.test(f.type));
      status.innerHTML = `<i>Loading ${files.length} file${files.length === 1 ? "" : "s"}…</i>`;
      for (const f of files) {
        const base = f.name.replace(/\.(png|jpe?g|webp|avif|gif)$/i, "").toLowerCase();
        state.diagramFiles[base] = await compressToDataURL(f, 1400, 0.85);
      }
      matchDiagrams();
      renderStatus();
    });

    primaryButton(area, "Next · AI images →", () => {
      state.step = "ai";
      renderStep();
    });
    outlineButton(area, "← Back", () => { state.step = "body"; renderStep(); });
  }

  // ---------- step 3 + 4: image slots -----------------------------------------------
  function renderSlotsListInto(area, kind) {
    const list = state.slots.filter((s) => s.kind === kind);
    if (!list.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:12px;color:#6d6f78;padding:8px 0";
      empty.textContent = kind === "ai"
        ? "No AI image markers found in your body."
        : "No external image markers found in your body.";
      area.appendChild(empty);
      return;
    }
    list.forEach((s) => area.appendChild(buildSlotCard(s)));
  }

  function buildSlotCard(s) {
    const card = document.createElement("div");
    card.style.cssText = S.slot;

    const h = document.createElement("div");
    h.style.cssText = S.slotTitle;
    h.textContent = `Image ${s.num} · ${s.kind === "ai" ? "AI generated" : "external"}`;
    card.appendChild(h);

    // AI: prompt with copy button. External: keyword with copy button.
    const promptOrKw = document.createElement("div");
    promptOrKw.style.cssText = S.slotMeta;
    if (s.kind === "ai") {
      promptOrKw.innerHTML = `<b>Prompt:</b> ${esc(s.prompt || "no prompt found")}`;
    } else {
      promptOrKw.innerHTML = `<b>Search:</b> ${esc(s.keyword || s.label)}`;
    }
    card.appendChild(promptOrKw);

    const copyBtn = document.createElement("button");
    copyBtn.textContent = s.kind === "ai" ? "Copy prompt" : "Copy keyword";
    copyBtn.style.cssText = S.btnOutline + ";width:auto;display:inline-block;margin:2px 0 4px;padding:3px 10px;font-size:11.5px";
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      const val = s.kind === "ai" ? (s.prompt || "") : (s.keyword || s.label || "");
      navigator.clipboard.writeText(val);
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => (copyBtn.textContent = orig), 1500);
    };
    card.appendChild(copyBtn);

    const capMeta = document.createElement("div");
    capMeta.style.cssText = S.slotMeta;
    capMeta.innerHTML = `<b>Caption:</b> ${esc(s.caption || "none")}`;
    card.appendChild(capMeta);
    const altMeta = document.createElement("div");
    altMeta.style.cssText = S.slotMeta;
    altMeta.innerHTML = `<b>Alt:</b> ${esc(s.alt || "none")}`;
    card.appendChild(altMeta);

    card.appendChild(makePasteZone(s));

    // Click anywhere on the card (outside a button or the zone) focuses the zone so Ctrl+V lands.
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const zone = card.querySelector('[data-af-paste-zone]');
      if (zone && !zone.contains(e.target)) zone.focus();
    });
    return card;
  }

  function makePasteZone(slot) {
    const z = document.createElement("div");
    z.setAttribute("data-af-paste-zone", "1");
    z.tabIndex = 0;
    z.style.cssText = S.pasteZone;
    const render = () => {
      z.innerHTML = "";
      if (slot.dataURL) {
        const img = document.createElement("img");
        img.src = slot.dataURL;
        img.style.cssText = "max-width:100%;max-height:100%;display:block;border-radius:6px";
        z.appendChild(img);
        const rm = document.createElement("button");
        rm.textContent = "×";
        rm.title = "Remove image";
        rm.style.cssText = "position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:11px;border:none;background:rgba(0,0,0,.55);color:#fff;font-size:14px;line-height:1;cursor:pointer;font-family:inherit";
        rm.onclick = (e) => { e.stopPropagation(); slot.dataURL = null; render(); };
        z.appendChild(rm);
      } else {
        z.textContent = "Click, then paste (Ctrl+V) — or click to browse.";
      }
    };
    render();
    const set = async (blobOrFile) => {
      slot.dataURL = await compressToDataURL(blobOrFile, 1400, 0.85);
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

  function renderAiStep(area) {
    stepHead(area, 3, "AI images");
    hint(area, "Copy each prompt, generate the image, then paste into its 3:2 frame.");
    renderSlotsListInto(area, "ai");
    primaryButton(area, "Next · External images →", () => { state.step = "ext"; renderStep(); });
    outlineButton(area, "← Back", () => { state.step = "diagrams"; renderStep(); });
  }

  function renderExtStep(area) {
    stepHead(area, 4, "External images");
    hint(area, "Search for each image, copy it, paste into its frame. When ready, Assemble inserts into the Medium draft below.");
    renderSlotsListInto(area, "ext");
    primaryButton(area, "Assemble article", () => runAssemble());
    outlineButton(area, "← Back", () => { state.step = "ai"; renderStep(); });
  }

  // ================= assemble + insert ================================================
  async function runAssemble() {
    try {
      log("Building article…");
      const article = buildArticleDOM();
      await prepareImagesForPaste(article);
      const pasteArticle = articleForPaste(article);
      const figs = [...pasteArticle.querySelectorAll("figure")];
      const alts = figs.map((f) => (f.querySelector("img")?.getAttribute("alt") || "").trim());
      const captions = figs.map((f) => (f.querySelector("figcaption")?.textContent || "").trim());
      const payload = {
        bodyHTML: pasteArticle.innerHTML,
        text: pasteArticle.textContent,
        alts,
        captions,
      };
      log("Inserting into your Medium draft…");
      const summary = await insertArticle(payload);
      log(summary || "Done.", "ok");
    } catch (err) {
      log("Assemble failed: " + (err && err.message || err), "err");
    }
  }

  async function runFillFromClipboard() {
    const src = await getSource();
    if (!src) return;
    const nAlt = src.alts.filter(Boolean).length;
    const nCap = src.captions.filter(Boolean).length;
    log(`Clipboard article: ${nAlt} alt tag${nAlt === 1 ? "" : "s"}, ${nCap} caption${nCap === 1 ? "" : "s"}.`);
    log("Filling alt tags first…");
    await fillAlts(src.alts);
    log("Now filling captions…");
    await fillCaptions(src.captions);
  }

  async function getSource() {
    let html = null;
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes("text/html")) { html = await (await it.getType("text/html")).text(); break; }
      }
    } catch (e) {
      log("Couldn't read the clipboard (" + e.message + ").", "err");
      log("Click once in this page, then try again.", "warn");
      return null;
    }
    if (!html) { log("No HTML on the clipboard.", "err"); return null; }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const figs = [...doc.querySelectorAll("figure")];
    const alts = figs.map((f) => (f.querySelector("img")?.getAttribute("alt") || "").trim());
    const captions = figs.map((f) => {
      const inFc = f.querySelector("figcaption");
      if (inFc) return (inFc.textContent || "").trim();
      const sib = f.nextElementSibling;
      if (sib && sib.classList && sib.classList.contains("img-caption")) return (sib.textContent || "").trim();
      return "";
    });
    return { bodyHTML: doc.body.innerHTML, text: doc.body.textContent, alts, captions };
  }

  // ================= Medium DOM automation (unchanged) ================================
  function findEditor() {
    return document.querySelector('.postArticle-content[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"].editable')
      || document.querySelector('div.section-inner[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"]');
  }

  function placeCaretAtEnd(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function insertArticle(src) {
    const ed = findEditor();
    if (!ed) { log("Couldn't find the Medium editor on this page.", "err"); return "editor not found"; }
    const existingFigs = document.querySelectorAll("figure.graf--figure").length;
    const existingText = (ed.textContent || "").trim().length;
    if (existingFigs >= 3 || existingText >= 800) {
      const proceed = confirm(
        `This draft already has ${existingFigs} image${existingFigs === 1 ? "" : "s"} and about ${existingText} characters of text. ` +
        `Inserting again will DUPLICATE the article. Continue anyway?`
      );
      if (!proceed) {
        log("Insert cancelled — draft already has content. Use the 'Fill captions & alt' link on step 1 instead.", "warn");
        return "insert cancelled (draft not empty)";
      }
    }
    log("Inserting body via a synthetic paste…");
    placeCaretAtEnd(ed);
    const dt = new DataTransfer();
    dt.setData("text/html", src.bodyHTML);
    dt.setData("text/plain", src.text || "");
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));

    log("Waiting for images to finish uploading…");
    const wantImgs = (src.alts || []).length;
    const start = Date.now();
    let last = -1, stableSince = Date.now();
    while (Date.now() - start < 45000) {
      const nnow = document.querySelectorAll("figure.graf--figure").length;
      if (nnow !== last) { last = nnow; stableSince = Date.now(); }
      else if (nnow >= wantImgs && Date.now() - stableSince > 1800) break;
      await sleep(350);
    }
    const got = document.querySelectorAll("figure.graf--figure").length;
    if (!got && wantImgs) {
      log("No images appeared — the synthetic paste probably didn't take in this browser.", "err");
      return "body did not insert.";
    }
    await fillAlts(src.alts || []);
    await fillCaptions(src.captions || []);
    return `inserted body; images in editor: ${got}.`;
  }

  async function setAlt(figure, altText) {
    const img = figure.querySelector("img.graf-image") || figure.querySelector("img");
    if (!img) return false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      img.scrollIntoView({ block: "center" });
      await sleep(attempt === 1 ? 250 : 500);
      fireMouse(img, "mousedown"); fireMouse(img, "mouseup"); fireMouse(img, "click");
      const altBtn = await waitFor(
        () => [...document.querySelectorAll('.highlightMenu [data-action="alt"]')].find(visible),
        attempt === 1 ? 3500 : 5000
      );
      if (!altBtn) {
        if (attempt < 3) { document.body.click(); await sleep(300); continue; }
        log(`Alt button didn't appear after ${attempt} attempts — skipping this image.`, "warn");
        return false;
      }
      altBtn.click();
      const editable = await waitFor(
        () => document.querySelector('.editAltTextDialog [contenteditable="true"]'), 3500
      );
      if (!editable) {
        if (attempt < 3) { document.body.click(); await sleep(300); continue; }
        log("Alt dialog didn't open — skipping.", "warn");
        return false;
      }
      editable.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, altText);
      const saveBtn = document.querySelector('.overlay-actions [data-action="overlay-submit"]')
        || [...document.querySelectorAll(".overlay-actions button")].find((b) => /save/i.test(b.textContent));
      if (!saveBtn) { log("Couldn't find the alt dialog's Save button.", "warn"); return false; }
      saveBtn.click();
      await waitFor(() => !document.querySelector(".editAltTextDialog"), 2500);
      return true;
    }
    return false;
  }

  async function fillAlts(alts) {
    const figs = [...document.querySelectorAll("figure.graf--figure")];
    if (!figs.length) { log("No images in the editor yet.", "err"); return; }
    const n = Math.min(figs.length, alts.length);
    if (figs.length !== alts.length) {
      log(`Editor has ${figs.length} images, source has ${alts.length}. Filling ${n} in order.`, "warn");
    }
    let ok = 0;
    for (let i = 0; i < n; i++) {
      if (!alts[i]) { log(`Image ${i + 1}: no alt in source, left blank.`); continue; }
      log(`Image ${i + 1}/${n}: setting alt…`);
      if (await setAlt(figs[i], alts[i])) ok++;
      await sleep(250);
    }
    log(`Done — set alt on ${ok}/${n} images.`, "ok");
  }

  async function setCaption(figure, captionText) {
    if (!captionText) return false;
    const fc = figure.querySelector("figcaption.imageCaption") || figure.querySelector("figcaption");
    if (!fc) return false;
    fc.scrollIntoView({ block: "center" });
    await sleep(80);
    const target = (captionText || "").trim();
    const stuck = () => fc.textContent.trim() === target && !figure.classList.contains("is-defaultValue");
    const clearPlaceholder = () => {
      fc.querySelectorAll(".defaultValue").forEach((n) => n.remove());
      fc.querySelectorAll("br").forEach((br) => br.remove());
      figure.classList.remove("is-defaultValue");
    };
    const selectAllIn = () => {
      const range = document.createRange();
      range.selectNodeContents(fc);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const fireInput = () => {
      try { fc.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, data: target, inputType: "insertText" })); } catch {}
    };

    // Attempt A: click the image first (activates the caption slot), then click into figcaption
    // and insertText. That real-mouse-click on the image is what puts Medium's figure into
    // "selected" state, which is what makes the caption slot writable in the first place.
    const img = figure.querySelector("img.graf-image") || figure.querySelector("img");
    if (img) {
      fireMouse(img, "mousedown"); fireMouse(img, "mouseup"); fireMouse(img, "click");
      await waitFor(() => figure.classList.contains("is-selected"), 1500, 60);
      await sleep(80);
    }
    fireMouse(fc, "mousedown"); fireMouse(fc, "mouseup"); fireMouse(fc, "click");
    await sleep(60);
    fc.focus();
    await sleep(40);
    clearPlaceholder();
    selectAllIn();
    document.execCommand("insertText", false, target);
    fireInput();
    await sleep(120);
    if (stuck()) return true;

    // Attempt B: synthetic paste event scoped to the figcaption.
    fc.focus(); await sleep(30);
    clearPlaceholder();
    selectAllIn();
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", target);
      fc.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch {}
    await sleep(150);
    if (stuck()) return true;

    // Attempt C: direct DOM assignment + input event.
    while (fc.firstChild) fc.removeChild(fc.firstChild);
    fc.appendChild(document.createTextNode(target));
    figure.classList.remove("is-defaultValue");
    fireInput();
    await sleep(200);
    if (stuck()) return true;

    log(`  Caption didn't stick. figcaption.textContent = "${fc.textContent.slice(0, 40)}", is-defaultValue=${figure.classList.contains("is-defaultValue")}`, "warn");
    return false;
  }

  async function fillCaptions(captions) {
    const figs = [...document.querySelectorAll("figure.graf--figure")];
    if (!figs.length) { log("No images in the editor yet.", "err"); return; }
    const n = Math.min(figs.length, captions.length);
    if (figs.length !== captions.length) {
      log(`Editor has ${figs.length} images, source has ${captions.length}. Filling ${n} in order.`, "warn");
    }
    let ok = 0;
    for (let i = 0; i < n; i++) {
      if (!captions[i]) { log(`Image ${i + 1}: no caption in source, left blank.`); continue; }
      log(`Image ${i + 1}/${n}: setting caption…`);
      if (await setCaption(figs[i], captions[i])) ok++;
      await sleep(120);
    }
    log(`Done — set caption on ${ok}/${n} images.`, "ok");
  }

  // ================= boot =============================================================
  ensurePanel();
  const mo = new MutationObserver(() => ensurePanel());
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
