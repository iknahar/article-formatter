# article-formatter

A small wizard that assembles a Medium-import-ready article:

1. Enter the **title**
2. Pick a **subtitle** from the dropdown (or write your own)
3. Paste the **body copy** (with `**[Place Diagram N → file.png]**`, `**[Place Image N → AI generated, prompt N at the end]**`, and `**[Place Image N → external, search "keyword"]**` markers plus `*Caption →*` / `*Alt →*` lines)
4. Choose the **diagram folder**, files are matched to markers by filename
5. For each **AI image**, copy the shown prompt, generate it, click the 3:2 frame and paste from clipboard
6. For each **external image**, search the shown keyword, copy the image, paste the same way
7. Press **Compile**
8. Review the **editable preview** (captions and alt tags included)
9. Press **Publish** to get a public link, then paste it into **medium.com → Import a story**

## Deploy on GitHub Pages (recommended, free unique URLs)

1. In this repo on GitHub go to **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `/ (root)`** → Save
2. After ~1 minute the app is live at `https://iknahar.github.io/article-formatter/`
3. Create a token for the Publish button: GitHub → **Settings → Developer settings → Fine-grained personal access tokens → Generate new token**, Repository access = only `article-formatter`, Permissions = **Contents: Read and write**. Copy it.
4. In the app's publish step, keep destination **GitHub Pages**, paste the token (it's stored only in your browser), and hit Publish
5. Each publish commits `articles/<slug>-<id>.html` to the repo and returns a unique link like `https://iknahar.github.io/article-formatter/articles/my-story-mf3k2a.html`, wait ~1 minute for Pages to rebuild, then paste it into **medium.com → Import a story**

## Deploy on Vercel

1. Push this repo to GitHub
2. In [vercel.com](https://vercel.com) → **Add New → Project** → import `iknahar/article-formatter` → Deploy (no build settings needed, it's a static site with one API function)
3. Enable publishing: in the Vercel dashboard → **Storage → Create Database → Blob** → connect it to this project (this injects `BLOB_READ_WRITE_TOKEN` automatically) → **Redeploy**
4. Done. The Publish button now returns a public `*.blob.vercel-storage.com` link that Medium's importer can read

Without the Blob store, everything still works except Publish, use **Download HTML instead** and host the file anywhere public.

## Local development

```bash
npm i -g vercel
vercel dev
```

The static front end also works by just opening `index.html`, only `/api/publish` needs `vercel dev`.
