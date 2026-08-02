# Medium helper extension

A tiny Chrome/Edge extension that finishes the job a paste can't: it fills in **alt text**
for every image in a Medium draft. It works together with the article-formatter web app — the
web app assembles and hosts the article, this handles the Medium side.

## Why it exists

Medium's **paste** handler is faithful — pasting the web app's "Copy for Medium" output straight
into a draft keeps code blocks, ASCII tables, and captions intact. The only thing a paste can't
carry is **alt text**, because Medium sets alt through a separate dialog per image. This extension
reads the alt text from the same clipboard payload and drives that dialog for you, image by image.

(Medium's *Import a story* tool, by contrast, mangles headings, code blocks, and ASCII no matter
how clean the source is — see the main project README's "Why paste, not Import". This extension is
the paste path's finishing touch, not a fix for Import.)

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. It's now active on `medium.com`.

There's no build step and no popup — a small panel appears bottom-right whenever you're on a
Medium story-edit page.

## Use it

1. In the **web app**, assemble the article as usual and click **Copy for Medium**. (This hosts
   every image and copies the finished article — with each image's alt text — to your clipboard.)
2. Open a **Medium draft** (`https://medium.com/p/<id>/edit` or **Write** → new story).
3. Click into the editor and press **Ctrl/Cmd + V** to paste the article. Code blocks, ASCII, and
   captions come through intact.
4. In the bottom-right panel, click **Fill alt tags**. It reads the alt text from your clipboard
   and sets it on every image, in order. Watch the log in the panel for progress.

There's also an experimental **Auto-insert body + alt (beta)** button that tries to do the paste
for you as well. If it doesn't insert anything in your browser, just use the manual Ctrl/Cmd+V in
step 3 — that's the guaranteed path — and then **Fill alt tags**.

## Limitations / notes

- It automates Medium's live editor DOM, which Medium can change at any time. If a button stops
  finding things, the panel log will say what didn't appear — send that along and the selectors
  can be updated.
- "Fill alt tags" reads the clipboard, so run it before you copy anything else. If the browser
  blocks the clipboard read, click once anywhere on the page and try again (browsers require a
  recent click before granting clipboard access).
- Captions ride in on the paste as an italic line under each image (how many Medium authors
  caption anyway); the extension doesn't move them into Medium's native `figcaption`.
