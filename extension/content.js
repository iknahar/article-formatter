// Article Formatter — Medium helper (content script)
// =====================================================================================
// Runs on any medium.com page. When you're on a story-edit page it shows a small panel
// bottom-right. It works WITH the article-formatter web app, not instead of it:
//
//   1. In the web app, assemble the article as usual and click "Copy for Medium"
//      (that hosts every image and puts the finished article on your clipboard as HTML,
//       with each <img alt="..."> carrying the alt text and captions as italic lines).
//   2. Open a Medium draft (…/edit), press Ctrl/Cmd+V to paste the body in. Medium's
//      PASTE handler keeps code blocks, ASCII, and captions intact (its Import-a-story
//      tool does not — that's the whole reason this flow exists).
//   3. Click "Fill alt tags" in this panel. It reads the same clipboard HTML to recover
//      each image's alt text, then drives Medium's own Alt-text dialog for every image
//      in order. Alt is the one thing a paste can't carry (Medium sets it in a separate
//      dialog), so this is the piece the extension uniquely adds.
//
// There's also an experimental "Auto-insert body + alt" button that tries to do the
// paste for you via a synthetic paste event, then fills alt — handy if it works in your
// browser, but the manual Ctrl+V above is the guaranteed path.
//
// NOTE: this automates Medium's live editor DOM, which Medium can change without notice.
// Everything is best-effort with on-panel logging so failures are visible and fixable.
// =====================================================================================

(function () {
  if (window.__afMediumHelper) return;
  window.__afMediumHelper = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------- tiny UI ----------------------------------------------------------------
  let logEl;
  function log(msg, kind) {
    const color = kind === "err" ? "#c0392b" : kind === "warn" ? "#b9770e"
      : kind === "ok" ? "#1a7a4c" : "#3a3d46";
    const line = document.createElement("div");
    line.style.cssText = `color:${color};margin:2px 0;white-space:pre-wrap;word-break:break-word`;
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function buildPanel() {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-af-panel", "1");
    wrap.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
      "width:320px", "background:#fffdf9", "border:1px solid #d9d2bd",
      "border-radius:14px", "box-shadow:0 10px 30px rgba(0,0,0,.18)",
      "font-family:system-ui,-apple-system,Segoe UI,sans-serif", "color:#26262b",
      "padding:12px 12px 10px", "font-size:13px", "line-height:1.45",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "Article Formatter";
    title.style.cssText = "font-weight:700;font-size:13.5px;margin-bottom:2px";

    // The most important line on the panel: tell the user this is NOT where the article gets
    // pasted. Pasting raw text directly into Medium here bypasses the whole wizard (image slots,
    // captions, alt) — which was the failure mode observed in v0.2.0's screenshots.
    const sub = document.createElement("div");
    sub.innerHTML = 'Open the <b>wizard</b> to assemble your article (title, body, images, captions). It sends the finished article straight into this draft.';
    sub.style.cssText = "color:#6d6f78;font-size:11.5px;margin-bottom:9px";

    const btnStyle = [
      "display:block", "width:100%", "margin:5px 0", "padding:9px 10px",
      "border-radius:9px", "border:1px solid #cdbf93", "background:#f5c518",
      "color:#26262b", "font-weight:600", "font-size:12.5px", "cursor:pointer",
    ].join(";");
    const outlineStyle = btnStyle + ";background:#fff;border-color:#cdbf93;font-weight:500";

    const btnOpen = document.createElement("button");
    btnOpen.textContent = "Open the wizard";
    btnOpen.style.cssText = btnStyle;

    // Advanced/fallback: only useful once the wizard has already run, put its output on the
    // clipboard, and the user has already pasted the body into the editor manually. Kept
    // available but visually secondary and behind a small "Advanced" toggle so it doesn't
    // mislead a first-time user into pressing it with nothing on the clipboard.
    const adv = document.createElement("details");
    adv.style.cssText = "margin-top:6px";
    const advSum = document.createElement("summary");
    advSum.textContent = "Advanced: manual paste helpers";
    advSum.style.cssText = "cursor:pointer;font-size:11.5px;color:#6d6f78;padding:3px 0;list-style:disclosure-closed";
    adv.appendChild(advSum);
    const advHelp = document.createElement("div");
    advHelp.style.cssText = "color:#6d6f78;font-size:11px;margin:4px 0 2px";
    advHelp.innerHTML = 'Use these only after the wizard has run. In the wizard: click <b>Copy for Medium</b>, then here press Ctrl/Cmd+V into the editor, then click <b>Fill alt tags</b>.';
    const btnAlt = document.createElement("button");
    btnAlt.textContent = "Fill alt tags (needs wizard clipboard)";
    btnAlt.style.cssText = outlineStyle;
    const btnAuto = document.createElement("button");
    btnAuto.textContent = "Auto-insert body + alt (beta)";
    btnAuto.style.cssText = outlineStyle;
    adv.append(advHelp, btnAlt, btnAuto);

    logEl = document.createElement("div");
    logEl.style.cssText = [
      "margin-top:8px", "max-height:150px", "overflow:auto", "font-size:11.5px",
      "font-family:ui-monospace,Consolas,monospace", "background:#f4efe0",
      "border-radius:8px", "padding:7px 8px", "border:1px solid #e4dcc4",
    ].join(";");

    const hide = document.createElement("button");
    hide.textContent = "×";
    hide.title = "Hide";
    hide.style.cssText = "position:absolute;top:8px;right:10px;border:none;background:none;font-size:16px;line-height:1;color:#9a9585;cursor:pointer";
    hide.onclick = () => wrap.remove();

    wrap.append(title, sub, btnOpen, adv, logEl, hide);
    document.body.appendChild(wrap);
    log("Click 'Open the wizard' to build the article. This panel only handles Medium-side steps.");

    btnOpen.onclick = () => run(async () => {
      log("Opening the wizard in a new tab…");
      const reply = await chrome.runtime.sendMessage({ type: "af-open-wizard" });
      if (!reply || !reply.ok) log("Couldn't open the wizard: " + ((reply && reply.error) || "no response"), "err");
      else log("Wizard opened — switch to that tab to assemble your article.", "ok");
    }, btnOpen);
    btnAlt.onclick = () => run(fillAltFlow, btnAlt);
    btnAuto.onclick = () => run(autoFlow, btnAuto);
    return wrap;
  }

  async function run(fn, btn) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "Working…";
    try { await fn(); } catch (e) { log("Error: " + (e && e.message || e), "err"); }
    btn.disabled = false;
    btn.textContent = old;
  }

  // -------- helpers ----------------------------------------------------------------
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

  const visible = (el) => !!(el && el.offsetParent !== null);

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

  function fireMouse(el, type) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
  }

  // Read the article-formatter web app's "Copy for Medium" payload back off the clipboard.
  // We only need it for the alt text (and, for the beta button, the body HTML) — the visible
  // article body is already in the editor from your manual paste.
  async function getSource() {
    let html = null;
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes("text/html")) { html = await (await it.getType("text/html")).text(); break; }
      }
    } catch (e) {
      log("Couldn't read the clipboard (" + e.message + ").", "err");
      log("Click in this page once, then try again — the browser needs a click first.", "warn");
      return null;
    }
    if (!html) { log('No HTML on the clipboard. In the web app, click "Copy for Medium" first.', "err"); return null; }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const figs = [...doc.querySelectorAll("figure")];
    const alts = figs.map((f) => (f.querySelector("img")?.getAttribute("alt") || "").trim());
    return { bodyHTML: doc.body.innerHTML, text: doc.body.textContent, alts };
  }

  // Drive Medium's alt-text dialog for one figure.
  async function setAlt(figure, altText) {
    const img = figure.querySelector("img.graf-image") || figure.querySelector("img");
    if (!img) return false;
    img.scrollIntoView({ block: "center" });
    await sleep(150);
    fireMouse(img, "mousedown"); fireMouse(img, "mouseup"); fireMouse(img, "click");

    const altBtn = await waitFor(
      () => [...document.querySelectorAll('.highlightMenu [data-action="alt"]')].find(visible),
      2500
    );
    if (!altBtn) { log("Alt button didn't appear for one image — skipped.", "warn"); return false; }
    altBtn.click();

    const editable = await waitFor(
      () => document.querySelector('.editAltTextDialog [contenteditable="true"]'),
      2500
    );
    if (!editable) { log("Alt dialog didn't open — skipped one image.", "warn"); return false; }
    editable.focus();
    // Clear whatever's there (placeholder or old value), then type the alt text.
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, altText);

    const saveBtn = document.querySelector('.overlay-actions [data-action="overlay-submit"]')
      || [...document.querySelectorAll(".overlay-actions button")].find((b) => /save/i.test(b.textContent));
    if (!saveBtn) { log("Couldn't find the alt dialog's Save button — skipped.", "warn"); return false; }
    saveBtn.click();
    await waitFor(() => !document.querySelector(".editAltTextDialog"), 2500);
    return true;
  }

  async function fillAlts(alts) {
    const figs = [...document.querySelectorAll("figure.graf--figure")];
    if (!figs.length) {
      log("No images in the editor yet. Paste the article first (Ctrl/Cmd+V).", "err");
      return;
    }
    const n = Math.min(figs.length, alts.length);
    if (figs.length !== alts.length) {
      log(`Editor has ${figs.length} images, clipboard article has ${alts.length}. Filling ${n} in order.`, "warn");
    }
    let ok = 0;
    for (let i = 0; i < n; i++) {
      if (!alts[i]) { log(`Image ${i + 1}: no alt text in source, left blank.`); continue; }
      log(`Image ${i + 1}/${n}: setting alt…`);
      if (await setAlt(figs[i], alts[i])) ok++;
      await sleep(250);
    }
    log(`Done — set alt text on ${ok}/${n} image${n === 1 ? "" : "s"}.`, "ok");
  }

  // -------- flows ------------------------------------------------------------------
  async function fillAltFlow() {
    const src = await getSource();
    if (!src) return;
    log(`Clipboard article has ${src.alts.length} image${src.alts.length === 1 ? "" : "s"}.`);
    await fillAlts(src.alts);
  }

  // Insert a whole article: synthetic-paste the body, wait for Medium's async image uploads to
  // settle, then fill alt. Shared by the on-page "Auto-insert" button and the wizard→background
  // message. `src` is { bodyHTML, text, alts }. Returns a short summary string.
  async function insertArticle(src) {
    const ed = findEditor();
    if (!ed) { log("Couldn't find the Medium editor on this page.", "err"); return "editor not found"; }
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
      log("Fallback: use Copy for Medium in the wizard, press Ctrl/Cmd+V here yourself, then Fill alt tags.", "warn");
      return "body did not insert (synthetic paste blocked). Use manual paste + Fill alt tags.";
    }
    await fillAlts(src.alts || []);
    return `inserted body; images in editor: ${got}.`;
  }

  async function autoFlow() {
    const src = await getSource();
    if (!src) return;
    await insertArticle(src);
  }

  // -------- boot -------------------------------------------------------------------
  // Medium is a single-page app; the editor may mount after load and across navigations.
  // Show the panel once an editor is present and there's no panel already.
  function ensurePanel() {
    if (document.querySelector('[data-af-panel]')) return;
    if (!findEditor()) return;
    buildPanel();
  }
  ensurePanel();
  const mo = new MutationObserver(() => ensurePanel());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Receive a finished article from the wizard tab (relayed by the background worker) and insert it.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "af-insert") return;
    ensurePanel(); // make sure the log panel exists so progress is visible
    (async () => {
      try {
        log("Received article from the wizard — inserting…");
        const summary = await insertArticle(msg.payload || {});
        sendResponse({ ok: true, summary });
      } catch (err) {
        log("Insert failed: " + (err && err.message || err), "err");
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      }
    })();
    return true; // async sendResponse
  });
})();
