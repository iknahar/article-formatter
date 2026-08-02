# Article Formatter — Medium extension

A **self-contained** Chrome/Edge extension: the whole article-formatter wizard runs inside the
extension (open it from the toolbar), and the finished article goes **straight into an open Medium
draft** — images hosted, captions in place, and every image's **alt text** filled in
automatically. No separate web app to open, no copy/paste/import dance.

## Why it works this way

Medium's **paste** handler is faithful — it keeps code blocks, ASCII tables, and captions intact.
Its **"Import a story"** tool is not: it injects empty headings and code blocks, collapses code
onto one line, and breaks ASCII, even when the source HTML is clean. So this extension inserts the
body through the *paste* path, never Import. The one thing a paste can't carry is **alt text**
(Medium sets it in a separate dialog), so the extension drives that dialog per image itself.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. An **Article Formatter** icon appears in the toolbar.

No build step.

## Use it

1. Click the toolbar icon → the **wizard** opens in its own tab.
2. Work through it exactly as before: title, subtitle, body copy, diagram folder, then paste each
   AI/external image into its 3:2 slot (each slot shows its prompt or search keyword plus its
   caption and alt so you know which is which). Press **Compile**, review the editable preview.
3. In another tab, open a **Medium draft** — **Write** → start a new story (URL becomes
   `https://medium.com/p/<id>/edit`). Leave it open.
4. Back in the wizard, click **Send to Medium draft**. It hosts every image, then inserts the whole
   article into that draft and fills in all the alt text. Switch to the Medium tab to review.

### If the one-click insert doesn't take

Some browsers block the programmatic paste the one-click path uses. Fallback, fully reliable:

1. In the wizard, click **Copy for Medium** instead (copies the whole article to your clipboard).
2. On the Medium draft, click into the editor and press **Ctrl/Cmd + V**.
3. In the small panel that appears bottom-right on the Medium page, click **Fill alt tags**.

Same result — the body via a real paste, alt via the panel.

## Notes / limitations

- It automates Medium's live editor DOM, which Medium can change at any time. Everything logs to
  the bottom-right panel on the Medium page, so if something stops working, that log says what
  didn't appear — send it along and the selectors/timing can be updated.
- Images are hosted through the deployed helper API (`medium-formatter.vercel.app`) so Medium can
  fetch them on paste; the wizard UI itself is fully self-contained, but that one background call
  means the API needs to stay deployed. (A future version could skip it if pasted `data:` images
  turn out to upload reliably — untested so far.)
- The wizard here is a copy of the web app's wizard (`index.html`/`app.js`/`style.css`). Fixes to
  the shared parsing/compile/preview logic have to be applied in both places.
- Captions ride in on the paste as an italic line under each image; the extension doesn't move
  them into Medium's native `figcaption`.
