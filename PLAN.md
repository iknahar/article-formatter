# Article Formatter — Project Plan

> Read this file first in any new session working on this tool. It has the
> full context: what this is, why it exists, how it works, what's fixed,
> what's still manual, and what's untested. Keep it updated whenever the
> workflow or the app changes.

## 1. What this is

A small static web app (no build step, no framework) that turns a pasted
article package into a publish-ready page with images/diagrams placed,
captioned, and alt-tagged — removing the single most tedious manual step in
the user's writing workflow. **Two pages, added 2026-08-02** (originally one
page with everything on it):

- **Compose** (`index.html` + `app.js`) — the 9-step wizard, §1 below.
- **Manage** (`manage.html` + `manage.js`) — stat cards (Published / Drafts /
  Total) plus a list of everything stored, with View / Resume / Delete per
  item. Split out from the bottom of Compose into its own page when the
  user asked for a dashboard-style visual redesign (warm cream palette,
  pill-shaped segmented nav, big rounded cards — see §9) modeled on a
  reference HR-dashboard screenshot they shared; a management view doesn't
  belong bolted onto the bottom of a linear wizard once it has its own
  identity. Both pages share `style.css` and are linked via a `.pillnav` in
  the header (`Compose` / `Manage` tabs).
- **Resume across pages**: since Manage can't reach into Compose's DOM
  directly (separate page loads), its Resume links are plain
  `index.html?resume=<encoded pathname>` URLs. Compose's `app.js` checks
  `location.search` for a `resume` param on load
  (`checkResumeParam()`), calls the same `resumeArticle()` used for
  same-page resumes (skipping its confirm-dialog, since navigating here
  already was the confirmation), then cleans the URL with
  `history.replaceState`.

**The user's real workflow this replaces:** they write articles via a
separate Claude conversation using a large "master prompt" (voice/humor
rules, SEO suite spec, image/diagram tagging spec). That conversation returns
a text package: SEO suite + article body with image/diagram markers +
an image-prompt appendix. Historically, turning that into a finished article
meant manually placing every image, typing every caption, and typing every
alt tag by hand in the target editor. This app automates exactly that
placement/caption/alt-tag step — it does not write the article itself.

### The 9-step wizard (confirmed against the live app, 2026-08-02)

1. **Title** — free text input, exactly as it should appear on the published page.
2. **Subtitle** — plain text input (was a dropdown of auto-suggestions
   until 2026-08-02; the user found the suggestions weren't worth the
   extra click, removed).
3. **Body copy** — paste the whole package, SEO suite and all, or just the
   body — doesn't matter. Before parsing, `stripPreamble()` looks for a
   standalone line reading "the body" or "the article" (any heading level,
   case-insensitive, optional trailing parenthetical) and discards
   everything up to and including it; if no such line exists, the input is
   used as-is (backward compatible with pasting just the body directly).
   "Analyze" then parses it and reports counts (diagram/AI/external slots,
   paragraphs, headings, code blocks, prompts captured).
4. **Diagram folder** — pick a folder; every diagram marker's file is
   auto-matched by filename (case-insensitive, extension-agnostic on the
   stem) and dropped in.
5. **AI + external images** — one grouped section per kind. Each AI slot
   shows its full generation prompt (harvested from the appendix) plus a
   3:2 paste frame — copy the prompt into your generator, paste the result
   in with Ctrl+V. Each external slot shows the search keyword, caption, and
   alt tag so you know exactly what to look for; paste it the same way.
   Drag & drop and click-to-browse also work.
6. **Compile** — assembles everything into an editable preview.
7. **Preview & edit** — the compiled article is `contenteditable`; click
   into any paragraph and fix it. Every image (AI, external, and diagram
   alike) renders with its caption and a small alt-tag note beneath it.
8. **Publish** — one click, fully automatic (see §3 for the full history —
   this went through two other designs earlier the same day before landing
   here). Uploads to Vercel Blob storage via `/api/publish` and gets a live
   public link back immediately, no token or manual hand-off. Only the 20
   most recently published articles stay live; publishing a new one deletes
   the oldest automatically. Paste the returned link into your platform's
   story-import tool. A "Manage articles →" link on this step goes to the
   Manage page (§1 above).

## 2. Marker syntax the parser understands

Written by the *other* Claude session under the user's master prompt, so the
parser has to be tolerant — the exact phrasing has already drifted once
mid-project and broke parsing (see §5). Recognized forms, in the body text:

```
**[Place Diagram N → path/file.png]**
*Caption → ...*
*Alt → ...*

**[Place Image N → AI generated, prompt N at the end]**
*Caption → ...*
*Alt → ...*

**[Place Image N → external, search "keyword"]**
*Caption → ...*
*Alt → ...*
```

- Markdown `**`/`*` wrapping is optional and stripped before matching.
- **The number is optional** — `[Place Diagram → diagrams/foo.png]` with no
  `N` works fine. Diagrams have always matched by filename regardless of
  number; when a marker omits the number, one is auto-assigned (from 1001
  up) purely for the on-screen label, and doesn't collide with real
  explicit numbers used elsewhere for AI-image prompt lookup.
- `Caption →` / `Alt →` may be on the **same line** as the bracket (common
  when the source article wraps them in italics right after the bracket) or
  on the **following line(s)** — both are handled.
- **Kind is inferred from the bracket's content**, not just the leading
  word: a payload containing an image-file extension → `diagram`; containing
  "AI generated"/"AI-generated" → `ai`; containing "external" → `ext`
  (search keyword extracted from quotes, or from the text after
  "external,"); anything else defaults to `ai`.
- **Appendix prompts**, under any heading containing "image prompts": either
  `**Prompt N, <text>**` (text inline, legacy style) or `**Image N ·
  <label>**` followed by the real prompt as separate paragraph line(s)
  (newer style — the label itself is discarded, only what follows is used
  as the prompt).

## 3. Publishing, drafts, resume/update, and article management

**Vercel Blob, fully automatic, rolling 20-article window, drafts, a
management panel, and true resume/update.** (Current design, 2026-08-02.)
`POST /api/publish` (`api/publish.js`) takes
`{ slug, html, draft, snapshot, overwritePathname }`:

1. Uploads the compiled HTML to Vercel Blob storage (`put()`, **private**
   access — see the bug/fix below for why) under
   `articles/<slug>-<id>.html` normally, or `drafts/<slug>-<id>.html` when
   `draft: true` — a fresh random-suffixed pathname by default, **or** the
   exact `overwritePathname` given (with `allowOverwrite: true`,
   `addRandomSuffix: false`) when resuming an existing item — see §6 for
   what makes an update apply cleanly.
2. If `snapshot` is present, also uploads it as a companion JSON at the
   same pathname stem (`.json` instead of `.html`) — this is the wizard's
   raw editable input (title, subtitle, raw pasted body text, and every
   slot's image data, keyed by slot number), and it's what makes Resume
   possible. Always sent by the client now (see §6).
3. **Published articles only:** lists all `.html` blobs under `articles/`
   (`list()`, filtering out `.json` companions so they're not double
   counted), sorts newest-first, deletes (`del()`) everything beyond
   `MAX_ARTICLES`-most-recent (default 20, overridable via a `MAX_ARTICLES`
   env var), **and their companion `.json` files too**. **Drafts are
   exempt from this window entirely.**
4. Returns a link through this app's own `/api/view?pathname=...` route
   (`api/view.js`) — not the raw blob URL, which isn't directly fetchable
   on a private store — plus how many published articles are being
   kept/deleted (`null`/`0` for drafts) and the actual `pathname` used (so
   the client can track it for the next overwrite), straight back in the
   same request. One click, no polling, no manual hand-off.

`GET /api/articles` (`api/articles.js`) lists everything under both
`articles/` and `drafts/`, filtered to `.html` only (companions are an
implementation detail, never shown as separate items), merged and sorted
newest-first, each tagged `kind: "published"` or `"draft"`, with a
ready-to-use `/api/view` link. `GET /api/snapshot?pathname=...`
(`api/snapshot.js`) fetches an item's companion `.json` for Resume — 404s
cleanly for anything published before this feature existed, no companion
saved. `DELETE /api/delete` (`api/delete.js`, body `{ pathname }`) removes
one blob **and its companion snapshot** — used by the Manage panel's
Delete button on any item, published or draft.

**The "Manage articles" section** (bottom of `index.html`, always visible,
not gated behind wizard progress) calls `GET /api/articles` on load and
after every publish/save, renders each as a row (name, published/draft
pill, timestamp, **View** link, **Resume** button, **Delete** button), and
calls `DELETE /api/delete` with a `confirm()` prompt before removing a row.

### Resume / true update (added 2026-08-02, same day)

The user asked directly for this after being told the earlier design only
supported Create/Read/Delete, not Update, because Blob only stored the
compiled HTML. Fixed by saving a **raw editable snapshot** alongside every
publish/draft-save (see §3.2), and adding:

- **Client (`app.js`) `buildSnapshot()`** — reads live DOM values
  (`$("title").value`, `$("subtitle").value`, `$("body").value`, deliberately
  *not* the possibly-stale `state.title`/`state.subtitle`) plus every
  `state.slots[].dataURL` keyed by slot `num`. Since diagrams, AI images,
  and external images all end up as a plain `dataURL` on their slot
  regardless of kind once filled, **one snapshot mechanism covers all three
  image types** — resuming restores diagram images too, no need to
  re-select the diagram folder at all.
- **`resumeArticle(item)`** — confirms before discarding unsaved wizard
  state, fetches the snapshot, restores the title/subtitle/body inputs,
  calls the existing `parseBody()` to re-derive `state.slots` from the raw
  body text (same function used by the normal "Analyze" step), then
  re-attaches each slot's saved `dataURL` by matching `num`, re-renders via
  the existing `renderAnalysis()`/`renderSlots()`/`renderDiagramStatus()`,
  unlocks every step through Preview, and scrolls to the images step so the
  user immediately sees everything came back.
- **`resumedPathname`** (module-level in `app.js`) — tracks what's
  currently being edited. `publishArticle()` passes it as
  `overwritePathname` only when its prefix (`articles/` vs `drafts/`)
  matches what's about to be saved; mismatched cases (resumed a draft, hit
  Publish — or the reverse) fall through to creating a **new** entry
  instead, leaving the original untouched until manually deleted. This is a
  deliberate, simple default rather than a scope/kind-conversion feature —
  documented in the README, not hidden.

This closes the Update gap from the original design note (now removed —
Update exists, with the one caveat above about kind-crossing being a fresh
create rather than a conversion).

**Bug found and fixed (2026-08-02, same day):** first real Publish attempt
after connecting the Blob store failed with `No token found. Either
configure the BLOB_READ_WRITE_TOKEN environment variable, or pass a token
option.` The user's project env vars showed `BLOB_STORE_ID` and
`BLOB_WEBHOOK_PUBLIC_KEY` — no `BLOB_READ_WRITE_TOKEN` — because Vercel now
connects new Blob stores using **OIDC** by default (a short-lived
`VERCEL_OIDC_TOKEN`, auto-rotated per deployment, paired with
`BLOB_STORE_ID`), not the older static read-write token. The pinned SDK
version, `@vercel/blob@^0.27.0`, predates OIDC support and only ever checks
for `BLOB_READ_WRITE_TOKEN`, so it threw immediately. Confirmed via current
Vercel docs that `put()`/`list()`/`del()` need **no code changes** for
OIDC — the SDK resolves credentials in order (explicit `token` option →
OIDC via `VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID` → `BLOB_READ_WRITE_TOKEN` →
throws) automatically once a current-enough SDK version is installed.
Fix: bumped `package.json` to `@vercel/blob@^2.6.1` (npm's current latest
as of this date). No changes needed to `api/publish.js` itself. Requires a
fresh Vercel deploy (which reinstalls dependencies) to take effect.

**Second bug found and fixed (2026-08-02, same day, right after the first):**
next Publish attempt failed with `Cannot use public access on a private
store. The store is configured with private access.` The user's Blob store
had been created with **Private** access (visible in the dashboard
screenshot), but `api/publish.js` hardcoded `access: "public"` on `put()`.
Newer Vercel Blob stores enforce one access mode consistently — you cannot
request the other mode per-call. Checked Vercel's private-storage docs
directly: **a private blob's own URL is not publicly fetchable at all** —
reading it requires an `Authorization` header (OIDC or a static
`BLOB_READ_WRITE_TOKEN`), full stop. Returning `blob.url` as-is to the
browser would have produced a link nobody (including Medium's importer)
could actually open.

Two ways to fix this: (a) have the user create a *new* Public store instead,
or (b) keep the store they already set up and add a thin proxy route that
authenticates to Blob server-side and re-exposes the content with no auth
gate of its own. Chose **(b)** — it needed no further dashboard changes from
the user, who'd already been through two rounds of Blob setup friction that
same session. Added `api/view.js`: takes `?pathname=...`, calls
`get(pathname, { access: "private" })` (authenticates via the same OIDC the
serverless function already has), and streams the result back with
`Readable.fromWeb(result.stream).pipe(res)` — deliberately with **no**
auth check of its own, since the entire point is a link anyone can open.
`api/publish.js` now uploads with `access: "private"` and returns
`https://<host>/api/view?pathname=<blob.pathname>` (built from the
incoming request's own `req.headers.host`, not a hardcoded domain) instead
of the raw blob URL.

**If a future session wants to switch to a Public store instead:** change
`access: "private"` → `"public"` in both `api/publish.js` and `api/view.js`,
and have `/api/publish` return `blob.url` directly — `api/view.js` becomes
unnecessary in that case. Documented in the README too.

**This requires the app itself to be deployed on Vercel**, not just GitHub
Pages — GitHub Pages is static-only and cannot run `/api/publish` at all.
Deployment steps are in the README (`Deploy on Vercel` section): import the
repo into Vercel, enable a Blob store (auto-injects
`BLOB_READ_WRITE_TOKEN`), redeploy. **This one step needs the user's own
Vercel account** — it can't be done from this session (no `vercel` CLI
installed, and connecting a Vercel account requires an interactive
OAuth/browser login the assistant can't perform headlessly). Everything
else (code, retention logic, UI) is done and pushed.

GitHub Pages hosting stays enabled too and still works for browsing the
wizard steps 1–8, but Publish will fail there with a clear error message
pointing at the Vercel requirement (no serverless runtime on Pages).

### History of this feature (why it's been rebuilt twice)

1. **Original build** (before this session touched it): Vercel Blob publish,
   alongside a GitHub Pages option — user picked GitHub Pages as sole
   destination, Vercel path removed entirely (§6 old note, now superseded).
2. **Second design** (same day): removed GitHub-API-token requirement from
   the browser; replaced with "show predicted link, download file, hand off
   to Claude to push via the Claude Code session's own `gh` auth." Worked,
   but was explicitly a two-step, human-in-the-loop process — the user
   confirmed this friction ("i do not want to push after preparing an
   article") right after trying it once.
3. **Current design**: the user asked directly for automatic Vercel
   deployment with a capped rolling link count ("max 5 links... delete the
   old ones") — restoring and enhancing the original Vercel Blob path with
   the retention logic. This is a deliberate, explicit reversal of the
   GitHub-Pages-only decision from earlier the same day, not a
   misunderstanding — don't second-guess it in a future session.

## 4. Repo / identity

- Repo: `iknahar/article-formatter` (public).
- Permanent local clone: `C:\Users\User\Desktop\medium\article-formatter`
  (deliberately nested inside the user's general working folder, but is its
  **own separate git repo** — the outer folder's `.gitignore` excludes
  `article-formatter/` so the two repos never tangle).
- Local git identity for this repo is pinned explicitly (not just inherited
  from global config) to the user's real GitHub identity:
  `user.name = "Kamrun Nahar"`, `user.email = "knahar.kamrun@gmail.com"`
  — matches the `iknahar` GitHub account, which `gh auth status` shows as
  the only authenticated, active account on this machine.
- One old commit message (`21ed596`, "Article formatter: 9-step wizard to
  build Medium-import-ready articles") still contains the word "Medium" —
  it's in git history, not file content. Fixing it means rewriting history
  with a force-push. **Not done** — needs the user's explicit go-ahead
  first, since rewriting published history is a destructive, hard-to-reverse
  operation.

## 5. Bugs found and fixed (2026-08-02)

The user reported a real parsing failure: pasting a live article produced
"0 diagram slots, 0 AI image slots, 0 external image slots" despite having
loaded the correct diagram folder. Root cause, found in `app.js`:

1. `MARKER_RE` required the bracket to be the **entire line** (`$` anchored
   right after the closing `]`). The actual pasted format put
   `*Caption → ...* *Alt → ...*` right after the bracket on the same line,
   so the whole regex silently failed to match — every image line was
   treated as an ordinary paragraph instead.
2. `PROMPT_RE` (the appendix harvester) only understood
   `**Prompt N, <text>**` on one line. The newer appendix style,
   `**Image N · <label>**` with the real prompt as a *separate* following
   paragraph, matched nothing — hence "0 prompts captured."

Both fixed: `MARKER_RE` now captures trailing same-line content separately
and tries it first for Caption/Alt before falling back to reading the next
lines; the appendix harvester is now a proper stateful accumulator that
understands both header styles. **Verified** against the user's actual
failing article text (isolated the parser into a standalone Node script and
ran it against the real bracket lines) — all three slot kinds now parse
correctly with the right file/search-term/caption/alt/prompt.

## 6. History note: the parallel-build mistake

Earlier in this project the assistant was *not* told this app already
existed, misread the user's "current repo is fine" as license to pick any
repo name, and built a second, redundant tool from scratch
(`portal.html` in a separate `iknahar/medium-automation` repo) — duplicating
this app's functionality with a worse publish story (clipboard-copy only,
no real publish-to-a-public-URL flow). When the user pointed out the
existing `article-formatter` repo, work consolidated back here and the
duplicate was abandoned. **`medium-automation` and `portal.html` are dead —
do not resume work on them.** `iknahar/medium-automation` still exists on
GitHub; the user has not yet decided whether to delete it themselves
(deletion is something only they can do — permanent repo deletion is outside
what the assistant will perform) or leave it archived/private.

## 7. Known limitations / not yet verified

- No screenshot-capable environment is available in this session — every
  fix (parser, publish/draft/resume logic) has been verified either by
  extracting and running the relevant code in isolated Node, or by direct
  code review against Vercel's own current docs, never by visually
  exercising the real browser UI end to end. The user has been the one
  actually clicking through the deployed app and reporting real errors back
  — that loop is working well, keep relying on it rather than assuming
  something works untested.
- Native OS folder-picker interaction (diagram folder step) has not been
  driven end-to-end in this session (same reason as above).
- Resume/update (§3) is code-reviewed and syntax-checked but not yet
  exercised against a real deployment by the user — the publish/draft flow
  before it went through several real rounds of user-reported failures
  (OIDC, then private-vs-public access) before working, so treat this as
  "should work" rather than "confirmed" until the user reports back.
- `GET /api/articles` calls `list()` twice (once per prefix) rather than
  once — fine at this scale (personal use, well under Blob's list limits),
  not worth optimizing unless it becomes slow.

## 8. Open TODOs

- [ ] User: decide the fate of `iknahar/medium-automation` (leave, make
  private, or delete it themselves) — this repo doesn't exist anymore as of
  this writing (user deleted it), so this item is effectively resolved,
  kept here only as a record.
- [ ] User: say the word if the old `article-formatter` commit message with
  "Medium" in it should be scrubbed via history rewrite (destructive, needs
  explicit ask) — low priority, cosmetic only.
- [ ] Do one real end-to-end run of the full flow including Resume: paste a
  real package, load a real diagram folder, paste real images, compile,
  publish, then Resume that same item from Manage articles and confirm
  everything (title/subtitle/body/all images) comes back correctly.
- [ ] Do one real visual pass of the §9 redesign in an actual browser — it
  was built from a reference screenshot and code review only, no
  screenshot-capable environment was available (see §7).

## 9. Visual design system (2026-08-02 redesign)

User shared a screenshot of an HR/dashboard-style product (warm cream
background, big rounded white cards, black-pill-shaped active nav tab,
bold stat numbers, clean sans-serif) and asked for that visual language,
not a literal copy of the HR-specific widgets (employee photos, onboarding
checklists) — those don't apply to an article-management tool. What
carried over, in `style.css` (`:root` tokens):

- **Palette**: warm cream `--bg:#f6f0de`, warm off-white cards
  `--card:#fffdf6`, near-black ink `--ink:#18160f`, warm muted gray
  `--muted:#8c8570`, golden-yellow accent `--accent:#f5c518` (used for
  primary actions and progress-y elements — the reference's black-pill
  "active tab" became `--ink` background, since the accent yellow doing
  double duty as both "active nav" and "primary button" read as too
  busy/samey).
- **Shape**: `.step`/`.stat-card` cards at 22–24px radius (was 16px),
  pill-shaped (999px radius) buttons/nav tabs/tags throughout (was 6–10px
  rounded rectangles).
- **New `.pillnav`/`.pill-tab`** — a segmented capsule nav shared verbatim
  (same HTML block, same classes) between `index.html` and `manage.html`,
  with `.active` styled as a solid ink-black pill, mirroring the
  reference's "Dashboard" active tab treatment.
- **New `.stat-row`/`.stat-card`/`.stat-num`/`.stat-label`** on the Manage
  page — big bold numbers (34px/800 weight) over a small muted label,
  mirroring the reference's "Interviews / Hired / Project time" stat strip.
  Manage shows Published / Drafts / Total, computed client-side in
  `manage.js` from the same `/api/articles` response already needed for the
  list (no new endpoint).
- All existing functional class names (`.slot`, `.pastezone`, `.tag`,
  `.hidden`, `.locked`, `.filled`, etc.) were deliberately left unchanged —
  this was a re-theme (colors/radii/spacing), not a markup/logic rewrite,
  so `app.js`'s className-toggling continued to work with zero JS changes
  needed for the visual pass itself.
