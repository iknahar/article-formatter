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
9. Press **Publish** to get a public link, then paste it into your publishing platform's story-import tool

## Deploy on GitHub Pages (free, unique URLs)

1. In this repo on GitHub go to **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `/ (root)`** → Save
2. After ~1 minute the app is live at `https://iknahar.github.io/article-formatter/`
3. Create a token for the Publish button: GitHub → **Settings → Developer settings → Fine-grained personal access tokens → Generate new token**, Repository access = only `article-formatter`, Permissions = **Contents: Read and write**. Copy it.
4. In the app's publish step, paste the token (it's stored only in your browser), and hit Publish
5. Each publish commits `articles/<slug>-<id>.html` to the repo and returns a unique link like `https://iknahar.github.io/article-formatter/articles/my-story-mf3k2a.html`, wait ~1 minute for Pages to rebuild, then paste it into your platform's story-import tool

Without a token, everything still works except Publish — use **Download HTML instead** and host the file anywhere public.

## Local development

Pure static site, no build step and no server needed — just open `index.html` directly in a browser, or serve the folder with any static file server:

```bash
python -m http.server 8080
```
