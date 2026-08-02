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

    // Everything the panel does, in two clear paths. The primary path opens the assembly overlay
    // right here on this Medium tab — the whole wizard (body/diagrams/images/preview) runs in an
    // iframe over the draft, and its "Insert into draft" writes directly into the editor beneath.
    // The secondary path is for when the article body has already been pasted manually and only
    // captions + alt still need filling.
    const sub = document.createElement("div");
    sub.innerHTML = 'Click <b>Assemble article</b> to build one here. If you already pasted the article, use <b>Fill captions &amp; alt tags</b>.';
    sub.style.cssText = "color:#6d6f78;font-size:11.5px;margin-bottom:9px";

    const btnStyle = [
      "display:block", "width:100%", "margin:5px 0", "padding:9px 10px",
      "border-radius:9px", "border:1px solid #cdbf93", "background:#f5c518",
      "color:#26262b", "font-weight:600", "font-size:12.5px", "cursor:pointer",
    ].join(";");
    const outlineStyle = btnStyle + ";background:#fff;border-color:#cdbf93;font-weight:500";

    const btnAssemble = document.createElement("button");
    btnAssemble.textContent = "Assemble article";
    btnAssemble.style.cssText = btnStyle;

    const btnFill = document.createElement("button");
    btnFill.textContent = "Fill captions & alt tags";
    btnFill.style.cssText = outlineStyle;

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

    wrap.append(title, sub, btnAssemble, btnFill, logEl, hide);
    document.body.appendChild(wrap);
    log("Ready. Click Assemble article to build one here, or Fill captions & alt tags if you already pasted.");

    btnAssemble.onclick = () => run(openAssemblyOverlay, btnAssemble);
    btnFill.onclick = () => run(fillAltAndCaptionsFlow, btnFill);
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

  // -------- assembly overlay ------------------------------------------------------
  // Sits where the compact panel lives (bottom-right corner) with the same footprint feel — a
  // small self-contained pane, no full-viewport backdrop, no context switch. It loads the
  // extension's own wizard.html in an iframe, so the wizard's step-by-step code (body ->
  // diagram folder -> AI slots -> external slots -> assemble) runs unchanged. The wizard
  // detects the embedded context via window.parent and skips its title/subtitle steps.
  //
  // While the overlay is open the compact panel hides itself so they don't visually stack, and
  // shows again when the overlay closes.
  let overlayEl = null;
  let hiddenPanelEl = null;
  function openAssemblyOverlay() {
    if (overlayEl) { overlayEl.style.display = "block"; return; }

    // Hide the compact panel while the overlay is open (same corner, same size range).
    hiddenPanelEl = document.querySelector('[data-af-panel]');
    if (hiddenPanelEl) hiddenPanelEl.style.display = "none";

    const shell = document.createElement("div");
    shell.setAttribute("data-af-overlay", "1");
    shell.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
      "width:400px", "max-width:calc(100vw - 32px)",
      "height:min(720px,calc(100vh - 32px))",
      "background:#fffdf9", "border:1px solid #d9d2bd", "border-radius:14px",
      "box-shadow:0 10px 30px rgba(0,0,0,.18)", "overflow:hidden",
      "font-family:system-ui,-apple-system,Segoe UI,sans-serif",
    ].join(";");

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.title = "Close (progress will be lost)";
    closeBtn.style.cssText = [
      "position:absolute", "top:8px", "right:10px", "z-index:2",
      "width:24px", "height:24px", "border-radius:12px", "border:none",
      "background:rgba(255,255,255,.9)", "font-size:16px", "line-height:1",
      "color:#3a3d46", "cursor:pointer", "box-shadow:0 1px 4px rgba(0,0,0,.15)",
    ].join(";");
    closeBtn.onclick = () => {
      const ok = confirm("Close the assembly panel? Anything you've filled in will be lost.");
      if (ok) closeAssemblyOverlay();
    };

    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("wizard.html");
    iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:#fffdf9";
    iframe.setAttribute("data-af-overlay-frame", "1");

    shell.append(closeBtn, iframe);
    document.body.appendChild(shell);
    overlayEl = shell;
  }
  function closeAssemblyOverlay() {
    if (!overlayEl) return;
    overlayEl.remove();
    overlayEl = null;
    if (hiddenPanelEl) { hiddenPanelEl.style.display = ""; hiddenPanelEl = null; }
    ensurePanel();
  }

  // Bridge between the wizard iframe and this content script. The wizard posts to window.parent;
  // that's us (this document). We validate the message shape, run the normal insert path, then
  // reply so the wizard can show its own confirmation before self-closing.
  window.addEventListener("message", async (e) => {
    if (!e.data || typeof e.data !== "object") return;
    if (e.data.type === "af-overlay-close") { closeAssemblyOverlay(); return; }
    if (e.data.type !== "af-overlay-send") return;
    ensurePanel(); // panel may not be built yet if user acted quickly
    try {
      log("Received article from the overlay — inserting…");
      const summary = await insertArticle(e.data.payload || {});
      try { e.source && e.source.postMessage({ type: "af-overlay-inserted", ok: true, summary }, "*"); } catch {}
    } catch (err) {
      log("Insert failed: " + (err && err.message || err), "err");
      try { e.source && e.source.postMessage({ type: "af-overlay-inserted", ok: false, error: (err && err.message) || String(err) }, "*"); } catch {}
    }
  });

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
    if (!html) { log('No HTML on the clipboard. In the wizard, click "Copy for Medium" first.', "err"); return null; }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const figs = [...doc.querySelectorAll("figure")];
    const alts = figs.map((f) => (f.querySelector("img")?.getAttribute("alt") || "").trim());
    // Extract each figure's caption text. articleForPaste in wizard.js nests the caption inside a
    // <figcaption> before the paste; if that shape isn't present (older clipboard, external copy),
    // fall back to the sibling <p class="img-caption"> that exportHTML emits.
    const captions = figs.map((f) => {
      const inFc = f.querySelector("figcaption");
      if (inFc) return (inFc.textContent || "").trim();
      const sib = f.nextElementSibling;
      if (sib && sib.classList && sib.classList.contains("img-caption")) return (sib.textContent || "").trim();
      return "";
    });
    return { bodyHTML: doc.body.innerHTML, text: doc.body.textContent, alts, captions };
  }

  // Fill Medium's own per-figure caption slot by driving its contenteditable
  // <figcaption class="imageCaption">. Empty state ships as
  //   <figure class="graf--figure is-defaultValue">
  //     …<figcaption><span class="defaultValue">Type caption…</span><br></figcaption>
  //   </figure>
  // and turns into plain text after real typing (parent loses "is-defaultValue"). The v0.2.x
  // approach (focus + selectContents + execCommand insertText) failed 17/17 in a real test — the
  // alt-text dialog accepts execCommand fine because it's a plain modal contenteditable, but the
  // figcaption sits inside Medium's rich-text editor framework which appears to require:
  //   (a) a real mouse click on the figcaption to clear the placeholder-on-focus state,
  //   (b) the placeholder <span class="defaultValue"> to be physically removed, and
  //   (c) the parent figure's is-defaultValue class to be cleared explicitly.
  // We do all three, then insertText. Multiple fallbacks in sequence (paste event, direct
  // DOM textContent) run only if the primary attempt didn't stick, so we don't spend time on
  // fallbacks when the primary works. Each attempt reports its outcome to the log.
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
      // A trailing <br> is Medium's empty-caption marker; strip it so our text is the only content.
      const brs = fc.querySelectorAll("br");
      brs.forEach((br) => br.remove());
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
      try {
        fc.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, data: target, inputType: "insertText" }));
      } catch { /* ignore */ }
    };

    // The important insight (from live user observation): the IMAGE is what needs the click, not
    // the figcaption. Clicking the image is what activates Medium's "figure selected" state (green
    // outline appears, `figure` gets `is-selected`, the caption slot below becomes writable).
    // Clicking the figcaption directly without first selecting the image was a no-op — Medium's
    // editor didn't treat the figcaption as focused-for-typing until the parent figure was
    // selected, which is why every attempt in the previous version returned "still shows
    // placeholder" for 17/17 images.
    const img = figure.querySelector("img.graf-image") || figure.querySelector("img");
    if (img) {
      fireMouse(img, "mousedown"); fireMouse(img, "mouseup"); fireMouse(img, "click");
      // Wait for Medium to mark the figure as selected — that's the signal the caption slot is live.
      await waitFor(() => figure.classList.contains("is-selected"), 1500, 60);
      await sleep(80);
    }

    // Attempt A: click into the figcaption, clear its placeholder, insertText.
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

    // Attempt B: synthetic paste event scoped to the figcaption (same mechanism that ingests
    // pasted Google-Docs content into the body correctly).
    fc.focus(); await sleep(30);
    clearPlaceholder();
    selectAllIn();
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", target);
      fc.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch { /* ignore */ }
    await sleep(150);
    if (stuck()) return true;

    // Attempt C: direct DOM assignment + input event. If Medium's editor reads the DOM on
    // input, this convinces it. If its model overrides the DOM on next tick, this will revert
    // and stuck() returns false — we report that specifically so the user knows the failure
    // mode is model-level and manual typing is the workaround for those.
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
      log(`Editor has ${figs.length} images, source article has ${captions.length}. Filling ${n} in order.`, "warn");
    }
    let ok = 0;
    for (let i = 0; i < n; i++) {
      if (!captions[i]) { log(`Image ${i + 1}: no caption in source, left blank.`); continue; }
      log(`Image ${i + 1}/${n}: setting caption…`);
      if (await setCaption(figs[i], captions[i])) ok++;
      await sleep(120);
    }
    log(`Done — set caption on ${ok}/${n} image${n === 1 ? "" : "s"}.`, "ok");
  }

  async function fillCaptionsFlow() {
    const src = await getSource();
    if (!src) return;
    log(`Clipboard article has ${src.captions.filter(Boolean).length} caption${src.captions.filter(Boolean).length === 1 ? "" : "s"}.`);
    await fillCaptions(src.captions);
  }

  // Combined path used by the panel's primary button: one clipboard read, alt first (via the
  // alt-dialog), then captions (via the figcaption DOM). Kept separate from the beta auto-insert
  // above so the reliable, verified path stays the default.
  async function fillAltAndCaptionsFlow() {
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

  // Drive Medium's alt-text dialog for one figure. Retries up to 3 times because the failure
  // observed in a real run (18/23 succeeded, 6 failed at the article's tail) was a scroll+mount
  // race: images near the end of a long article take longer to have their highlight menu appear,
  // Medium's editor is lazily attaching it as the viewport nears the bottom. Longer timeouts and
  // a settle after scroll addresses those without slowing down the happy path noticeably.
  async function setAlt(figure, altText) {
    const img = figure.querySelector("img.graf-image") || figure.querySelector("img");
    if (!img) return false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      // Scroll a bit above center so there's room below for Medium's highlight menu, which
      // appears above the image. On the very last images "center" leaves no room below and the
      // menu can end up clipped off-screen or fail to mount at all.
      img.scrollIntoView({ block: "center" });
      await sleep(attempt === 1 ? 250 : 500); // longer settle on retries
      fireMouse(img, "mousedown"); fireMouse(img, "mouseup"); fireMouse(img, "click");

      const altBtn = await waitFor(
        () => [...document.querySelectorAll('.highlightMenu [data-action="alt"]')].find(visible),
        attempt === 1 ? 3500 : 5000
      );
      if (!altBtn) {
        if (attempt < 3) {
          // Deselect anything before trying again — a stale highlight menu can block the next click.
          document.body.click();
          await sleep(300);
          continue;
        }
        log(`Alt button didn't appear after ${attempt} attempts — skipping this image.`, "warn");
        return false;
      }
      altBtn.click();

      const editable = await waitFor(
        () => document.querySelector('.editAltTextDialog [contenteditable="true"]'),
        3500
      );
      if (!editable) {
        if (attempt < 3) { document.body.click(); await sleep(300); continue; }
        log("Alt dialog didn't open — skipping this image.", "warn");
        return false;
      }
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
    return false;
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
    // Guard against double-inserting: if the draft already has significant content, don't silently
    // paste another copy on top of it (the user's log showed "Editor has 40 images" — the article
    // had been inserted twice because Auto-insert ran after the article was already present).
    const existingFigs = document.querySelectorAll("figure.graf--figure").length;
    const existingText = (ed.textContent || "").trim().length;
    if (existingFigs >= 3 || existingText >= 800) {
      const proceed = confirm(
        `This draft already has ${existingFigs} image${existingFigs === 1 ? "" : "s"} and about ${existingText} characters of text. ` +
        `Inserting again will DUPLICATE the article. Continue anyway?`
      );
      if (!proceed) {
        log("Insert cancelled — draft already has content. Use Fill captions & alt tags instead.", "warn");
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
      log("Fallback: use Copy for Medium in the wizard, press Ctrl/Cmd+V here yourself, then Fill alt tags.", "warn");
      return "body did not insert (synthetic paste blocked). Use manual paste + Fill alt tags.";
    }
    await fillAlts(src.alts || []);
    // Then captions — separate DOM path, per-figure figcaption. See setCaption for why we do this
    // even though the pasted HTML already carries figcaption text: some Medium builds don't fully
    // populate the caption slot from the paste, so we finalize it via the same DOM automation.
    await fillCaptions(src.captions || []);
    return `inserted body; images in editor: ${got}.`;
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
