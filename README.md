# article-formatter

A small wizard that assembles a publish-ready article:

1. Enter the **title**
2. Pick a **subtitle** from the dropdown (or write your own)
3. Paste the **body copy** (with `**[Place Diagram N → file.png]**`, `**[Place Image N → AI generated, prompt N at the end]**`, and `**[Place Image N → external, search "keyword"]**` markers plus `*Caption →*` / `*Alt →*` lines — the number is optional, diagrams match by filename regardless)
4. Choose the **diagram folder**, files are matched to markers by filename
5. For each **AI image**, copy the shown prompt, generate it, click the 3:2 frame and paste from clipboard
6. For each **external image**, search the shown keyword, copy the image, paste the same way
7. Press **Compile**
8. Review the **editable preview** (captions and alt tags included)
9. Press **Publish** — one click, fully automatic. Uploads the article and hands back a live
   public link immediately. No token, no manual hand-off step
10. Paste that link into your publishing platform's story-import tool

Only your **5 most recent** published articles stay live — publishing a new one automatically
deletes the oldest beyond that, so there's nothing to clean up by hand. Change the limit with a
`MAX_ARTICLES` environment variable on the Vercel project if you want a different number.

## Deploy on Vercel (required for Publish to work)

Publish needs a real serverless function to upload the article somewhere and hand back a link —
that only runs on Vercel, not on a static host like GitHub Pages.

1. In [vercel.com](https://vercel.com) → **Add New → Project** → import `iknahar/article-formatter` → Deploy (no build settings needed, it's a static site with one API function)
2. Enable storage: in the Vercel dashboard → **Storage → Create Database → Blob** → connect it to this project (this injects `BLOB_READ_WRITE_TOKEN` automatically) → **Redeploy**
3. Done. The Publish button now uploads to Blob storage and returns a public `*.blob.vercel-storage.com` link immediately, with the 5-link rolling window enforced automatically

## Also on GitHub Pages (static preview only, Publish won't work there)

In this repo on GitHub go to **Settings → Pages → Build and deployment → Source: Deploy from a
branch → `main` / `/ (root)`** → Save. After ~1 minute the wizard itself is browsable at
`https://iknahar.github.io/article-formatter/` — useful for filling out steps 1–8, but the
Publish button needs the Vercel deployment above since GitHub Pages can't run `/api/publish`.

## Local development

```bash
npm i -g vercel
vercel dev
```

The static front end also works by just opening `index.html`, only `/api/publish` needs `vercel dev`.
