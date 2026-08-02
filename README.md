# article-formatter

A small wizard that assembles a publish-ready article:

1. Enter the **title**
2. Pick a **subtitle** from the dropdown (or write your own)
3. Paste the **body copy** (with `**[Place Diagram N → file.png]**`, `**[Place Image N → AI generated, prompt N at the end]**`, and `**[Place Image N → external, search "keyword"]**` markers plus `*Caption →*` / `*Alt →*` lines)
4. Choose the **diagram folder**, files are matched to markers by filename
5. For each **AI image**, copy the shown prompt, generate it, click the 3:2 frame and paste from clipboard
6. For each **external image**, search the shown keyword, copy the image, paste the same way
7. Press **Compile**
8. Review the **editable preview** (captions and alt tags included)
9. Press **Publish** — no token, no setup. It shows the exact link this article will live at
   (e.g. `https://iknahar.github.io/article-formatter/articles/my-story-mf3k2a.html`) and
   downloads the HTML file under that same name
10. Send that downloaded file to Claude in your chat — it pushes it to `articles/` in this repo
    on your behalf (already authenticated, no token needed from you). The link shown in step 9
    goes live once that's pushed and GitHub Pages rebuilds (usually about a minute)
11. Paste that link into your publishing platform's story-import tool

## Deploy on GitHub Pages (free, unique URLs)

In this repo on GitHub go to **Settings → Pages → Build and deployment → Source: Deploy from a
branch → `main` / `/ (root)`** → Save. After ~1 minute the app is live at
`https://iknahar.github.io/article-formatter/`. (Already enabled on this repo.)

## Local development

Pure static site, no build step and no server needed — just open `index.html` directly in a browser, or serve the folder with any static file server:

```bash
python -m http.server 8080
```
