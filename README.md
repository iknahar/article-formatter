# article-formatter

Two pages: **Compose** (`index.html`) is the wizard below. **Manage** (`manage.html`) lists,
resumes, and deletes everything you've published or saved as a draft — linked from the top nav
on both pages.

A small wizard that assembles a publish-ready article:

1. Enter the **title**
2. Enter the **subtitle**
3. Paste the **body copy** — the whole package, SEO suite and all, is fine; parsing
   automatically starts right after a line reading "the body" or "the article" (with
   `**[Place Diagram N → file.png]**`, `**[Place Image N → AI generated, prompt N at the end]**`,
   and `**[Place Image N → external, search "keyword"]**` markers plus `*Caption →*` /
   `*Alt →*` lines — the number is optional, diagrams match by filename regardless)
4. Choose the **diagram folder**, files are matched to markers by filename
5. For each **AI image**, copy the shown prompt, generate it, click the 3:2 frame and paste from clipboard
6. For each **external image**, search the shown keyword, copy the image, paste the same way
7. Press **Compile**
8. Review the **editable preview** (captions and alt tags included)
9. Press **Publish** — one click, fully automatic. Uploads the article and hands back a live
   public link immediately. No token, no manual hand-off step. Or press **Save as draft**
   instead to store it without publishing — drafts aren't limited or auto-deleted
10. Paste that link into your publishing platform's story-import tool

Only your **20 most recent** published articles stay live — publishing a new one automatically
deletes the oldest beyond that, so there's nothing to clean up by hand. Change the limit with a
`MAX_ARTICLES` environment variable on the Vercel project if you want a different number. Drafts
are exempt from this limit entirely.

**Manage** (`manage.html`, its own page): stat cards up top (Published / Drafts / Total), then a
list of everything with **View**, **Resume**, and **Delete** for each. **Resume** takes you back
to Compose (`index.html?resume=<pathname>` — Manage is a separate page, so this travels as a URL
rather than a direct DOM call) and reloads that item's original title, subtitle, raw pasted body
text, and every image (diagram, AI-generated, and external alike) restored exactly as they were —
a real editable snapshot is saved alongside the compiled HTML every time you Publish or Save as
draft, specifically so this works. Edit anything, hit Compile again, then Publish or Save as draft
again — it overwrites the same entry in place (same link, true update) rather than creating a new
one, as long as you're saving back to the same kind you resumed from (resuming a draft and hitting
Publish instead creates a new published entry, and vice versa — the old one stays until you delete
it yourself). Delete removes an item, and its saved snapshot, for good.

## Deploy on Vercel (required for Publish to work)

Publish needs a real serverless function to upload the article somewhere and hand back a link —
that only runs on Vercel, not on a static host like GitHub Pages.

1. In [vercel.com](https://vercel.com) → **Add New → Project** → import `iknahar/article-formatter` → Deploy (no build settings needed, it's a static site with two API functions)
2. Enable storage: in the Vercel dashboard → **Storage → Create Database → Blob** → set access
   to **Private** → connect it to this project (this injects `BLOB_STORE_ID` and a
   short-lived, auto-rotating OIDC token — no static secret to copy anywhere) → **Redeploy**
3. Done. The Publish button uploads to the private store and hands back a link through this
   app's own `/api/view` route (`https://<your-deployment>/api/view?pathname=...`), which
   authenticates to Blob on the server and streams the content back — anyone with that link,
   including Medium's story importer, can open it, even though the underlying store is private.
   The 20-link rolling window is enforced automatically on every publish

**Why Private, not Public?** A Public Blob store's URLs are directly, publicly fetchable —
simpler, but this project intentionally uses Private plus the `/api/view` proxy above so the
underlying storage is never exposed directly and everything is served through code you control.
If you'd rather use a Public store instead, change both `access: "private"` occurrences in
`api/publish.js` and `api/view.js` to `"public"`, and `/api/publish` can return `blob.url`
directly instead of building the `/api/view` link — `view.js` becomes unnecessary in that case.

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
