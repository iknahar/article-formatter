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
- **Kind is inferred from the bracket's content OR its leading word**: a
  payload containing an image-file extension → `diagram`; a leading word or
  payload containing "external" → `ext` (one or more quoted search terms
  extracted and joined with " · or · " if multiple are given — e.g.
  `[External image → search "term one" and "term two"]`); a payload
  containing "AI generated"/"AI-generated" → `ai`; anything else defaults to
  `ai`. The bracket's leading word itself can be `Image`, `Diagram`, or
  `External`/`External image` — this changed 2026-08-02 (see §5) when a
  generation used `[External image → ...]` as the whole leading phrase
  instead of putting "external" inside the payload after `Image N →`.
- **Extra "Label → text" annotation lines are tolerated**, e.g.
  `Placement → where to put this image in the article`. The scanner looks
  for `Caption →`/`Alt →` up to 8 lines ahead, skipping any line that
  matches the same `Label → text` shape but isn't Caption or Alt, so an
  unexpected field like `Placement →` doesn't stop the scan before it
  reaches the real Caption/Alt lines below it. Genuinely unstructured
  prose (a real paragraph, not a labeled line) still stops the scan
  immediately, so real article text is never captured or discarded as if
  it were marker metadata.
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

**Images are uploaded separately, not embedded — see §5's dedicated bug
entry.** Before the HTML in step 1 above is built, `app.js`'s
`hostImagesInline(html)` finds every `<img>` still pointing at a `data:`
URI (the compiled preview's default via `exportHTML()`), uploads each one
individually to Blob storage via a new `POST /api/upload-image`
(`api/upload-image.js` — same Private-store-plus-`/api/view` pattern as
articles, just a different content type and a distinct `images/` prefix),
and rewrites the `<img src>` to the real hosted URL that comes back.
Images that are *already* hosted (e.g. after Resume, whose `<img src>` is
already a real `/api/view` link, not `data:`) are correctly left alone —
nothing to re-upload. This has to finish before `/api/publish` is called,
so Publish/Save-as-draft now shows "Uploading images…" first.

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

### Resume / true update (added 2026-08-02, same day; images fixed later same day — see §5)

The user asked directly for this after being told the earlier design only
supported Create/Read/Delete, not Update, because Blob only stored the
compiled HTML. Fixed by saving a **raw editable snapshot** alongside every
publish/draft-save (see §3.2):

- **Client (`app.js`) `buildSnapshot()`** — reads live DOM values
  (`$("title").value`, `$("subtitle").value`, `$("body").value`, deliberately
  *not* the possibly-stale `state.title`/`state.subtitle`). **Text only —
  deliberately no images.** The first version also serialized every
  `state.slots[].dataURL` into the snapshot, which duplicated every image a
  second time in the same request (the compiled `html` already embeds them
  inline) and caused real "Server said 413" failures on ordinary
  publishes once articles had a few images — Vercel Functions hard-cap
  request bodies at 4.5 MB, platform-level, non-configurable. Fixed by
  removing `images` from the snapshot entirely (see §5's dedicated entry).
- **`resumeArticle(pathname, skipConfirm)`** — confirms before discarding
  unsaved wizard state (unless arriving via the cross-page `?resume=` link,
  see below, where navigating here already was the confirmation), fetches
  the snapshot **and, in parallel, the already-published compiled HTML**
  via `/api/view`, restores the title/subtitle/body inputs, calls the
  existing `parseBody()` to re-derive `state.slots` from the raw body text
  (same function used by the normal "Analyze" step), then recovers each
  slot's image by **matching its caption text against the compiled HTML's
  `<figcaption>` elements** (parsed client-side with `DOMParser`) rather
  than from the snapshot — since diagrams, AI images, and external images
  all end up as a plain `dataURL` on their slot regardless of kind once
  filled, and all render through the same `<figure><img><figcaption>`
  shape in `exportHTML()`, this one mechanism covers all three image types
  with no size cost at all (a slot with no matching caption, i.e. never
  filled originally, is simply left empty). Re-renders via the existing
  `renderAnalysis()`/`renderSlots()`/`renderDiagramStatus()`, unlocks every
  step through Preview, and scrolls to the images step so the user
  immediately sees everything came back.
- **`resumedPathname`** (module-level in `app.js`) — tracks what's
  currently being edited. `publishArticle()` passes it as
  `overwritePathname` only when its prefix (`articles/` vs `drafts/`)
  matches what's about to be saved; mismatched cases (resumed a draft, hit
  Publish — or the reverse) fall through to creating a **new** entry
  instead, leaving the original untouched until manually deleted. This is a
  deliberate, simple default rather than a scope/kind-conversion feature —
  documented in the README, not hidden.
- **Cross-page**: since Manage moved to its own page (`manage.html`, later
  the same day — see §1 and §9), Resume there is a plain link,
  `index.html?resume=<encoded pathname>`. Compose's `app.js` checks
  `location.search` on load (`checkResumeParam()`), calls the same
  `resumeArticle()` with `skipConfirm: true`, then cleans the URL with
  `history.replaceState`.

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

**Third parser bug, same day, later:** a new marker style,
`[External image → search "term one" and "term two"]`, wasn't detected at
all — no diagram/AI/external slot got created for it. Root cause: `External`
as the bracket's *leading word* (replacing `Image`/`Diagram` entirely) had
never been anticipated; `MARKER_RE` only accepted `Diagram` or `Image`
there. Worse, the same real article used `Placement → ...` as an extra
annotation line instead of going straight to `Caption →`/`Alt →` — the
Caption/Alt lookahead loop stopped (`break`) on the very first line that
wasn't literally `Caption →` or `Alt →`, meaning it would have silently
**discarded** a real paragraph as marker metadata if one had immediately
followed a slot lacking Caption/Alt on the next line, in addition to just
failing to see the real Caption/Alt lines two lines further down. Fixed:
`MARKER_RE` now also accepts `External`/`External image` as the bracket's
leading word (kind-classification checks `mm[1]` for "external" now, not
only the payload); external keyword extraction now captures *all* quoted
phrases via a global match and joins multiple with " · or · " instead of
only ever taking the first; the Caption/Alt lookahead is now bounded (8
lines) and **skips** any other `Label → text`-shaped annotation line
(`ANNOTATION_RE`) instead of stopping on it, while still stopping
immediately on genuinely unstructured prose so real article paragraphs are
never eaten. Verified with a standalone Node test using the user's actual
bracket text plus a plausible Caption/Alt/paragraph continuation — all
three concerns (kind detection, non-Caption/Alt annotation tolerance,
paragraph preservation) confirmed working.

**Fourth bug, same day, right after — a real regression, not a parser
issue:** ordinary Publish and Save as Draft started failing with
`Server said 413` (no further detail — the plain non-JSON response meant
Vercel's platform rejected the request before this app's own function code
ever ran). Root cause: adding the Resume feature's snapshot (see §3's
Resume subsection) had made `buildSnapshot()` serialize every
`state.slots[].dataURL` a **second time**, on top of the same images
already embedded inline in the compiled `html` being uploaded in the same
request — roughly doubling the request body for any image-heavy article.
Vercel Functions cap request bodies at 4.5 MB, platform-level, not
configurable from code — confirmed via Vercel's own docs, which also
confirm nothing server-side can catch a request that already exceeds the
limit, since it never reaches function code at all. Fixed by removing
`images` from the snapshot entirely — it's text-only now
(title/subtitle/bodyRaw) — and reworking Resume to recover images from the
already-published compiled HTML by caption-matching instead (see §3's
Resume subsection for the mechanism). Also tightened `api/publish.js`'s own
size check to look at `html.length` plus the snapshot's serialized length
combined (threshold 4.3 MB, leaving headroom under the platform's hard
4.5 MB) so a request that's merely *close* to the limit gets a clear JSON
error instead of silently hitting the platform wall — this can't catch
every case (nothing running inside the function can, by definition), but
it's strictly better than before.

**Fifth bug, same day:** a real external-image slot showed correctly
detected (kind, number, search keyword all right) but with `Caption → none`
and `Alt → none` — genuinely not present, not just a display issue. Root
cause, found by testing `CAPTION_RE`/`ALT_RE` in isolation: both were
`/^\*{1,2}Caption\s*→\s*(.+?)\*{1,2}\s*$/i` — `{1,2}` requires **at least
one** leading/trailing asterisk. A plain, unwrapped `Caption → text` line
with *zero* markdown emphasis around it (which is exactly what this
article's source used) never matched at all, silently. This was a
longstanding gap, not something introduced recently — `MARKER_RE` and
`ANNOTATION_RE` had always correctly used `{0,2}` (asterisks optional), but
these two never did. Fixed: both changed to `{0,2}`, and both (plus
`INLINE_CAP_ALT_RE`) now also accept `:` as an alternative to `→`/`->` as
the separator, since "Caption"/"Alt" are specific enough keywords that a
bare colon after them is safe to treat the same way (unlike the generic
`ANNOTATION_RE`, which deliberately was *not* widened to include bare `:` —
too many ordinary sentences use a "Word: explanation" shape, and treating
those as skippable annotations risked eating real prose). Verified with an
isolated Node test reproducing the exact reported case (numberless external
marker, unwrapped `Caption →`/`Alt →` lines) — both now populate correctly,
with surrounding real paragraphs still preserved.

**Also added the same day, on request:** a **Copy** button next to the
Search keyword for external-image slots (mirroring the AI slot's existing
"Copy prompt" button) — both now wired generically via a shared
`wireCopyButtons(card)` helper matching any `[data-copy]` button in a card,
rather than the old single-button `querySelector(".copy")` approach. And
the **whole card is now clickable** (`wireCardActivatesZone(card)`,
applied to AI/external slot cards and diagram cards alike) — clicking
anywhere in a slot card outside a real button forwards the click to its
paste zone (`zone.click()`), so pasting or picking a file no longer
requires aiming for the small dashed rectangle specifically.

**Sixth bug, found the next day — a significant one, present since the
very first publish:** the user imported a published article into Medium
and every image was missing; only the text came through. Root cause:
`exportHTML()` had always embedded every image as an inline `<img
src="data:image/...;base64,...">` — fine for this app's own live preview,
which just renders whatever `src` it's given, but Medium's "Import a
story" tool (like most page-import/readability tools) works by fetching
each `<img src>` over a real HTTP request so it can re-host the image on
its own CDN. A `data:` URI isn't a network resource — there's nothing at
that "address" to fetch — so the importer silently dropped every image
while still successfully scraping the surrounding text, which is exactly
what the user saw. **This affected every article published before this
fix, not just the one reported.** Fixed by adding `POST
/api/upload-image` (`api/upload-image.js`) — decodes a base64 `data:` URL,
uploads the raw bytes to Blob storage under `images/` (same Private-store
pattern as articles, own content type, served back through the *already
generic* `/api/view` route — no changes needed there, it already streams
whatever content type a blob has), and returns a real link. `app.js`'s new
`hostImagesInline(html)` runs before every publish/draft-save: parses the
compiled HTML, finds every `<img>` still on a `data:` URI, uploads each one
(in parallel), and rewrites its `src` to the real hosted URL — only *then*
does the resulting HTML go to `/api/publish`. Images that arrived already
hosted (via Resume, whose `<img src>` is already a real `/api/view` link)
are correctly skipped, so nothing gets re-uploaded on every re-save.
**Not yet verified against a real Medium import** — the mechanism is
sound and code-reviewed, but confirming the fix needs the user to publish
something fresh and actually try importing it.

**Related, found immediately after (same import test):** code blocks were
also missing entirely from the Medium import, and — more seriously — the
imported article's *text* cut off partway through, well before the real
end of the article. Root cause found for the code blocks: the compiled
markup was a bare `<pre>text</pre>` with **no `<code>` child element at
all** — not the standard HTML5 `<pre><code>...</code></pre>` shape most
import/readability tools specifically look for to recognize "this is a
code block." Fixed in the Compile step (`app.js`) to always wrap code text
in a `<code>` element inside the `<pre>`. Separately, and independent of
the import issue: `exportHTML()`'s embedded CSS never set a font-family
for code at all, so a published article's code blocks were rendering in
the serif body font instead of monospace even when they did survive —
added `pre code{font-family:Consolas,Menlo,monospace;white-space:pre}` to
match the live in-app preview's styling (`#preview pre` in `style.css`,
which was already correct).

**The truncation is treated as a likely *symptom* of the same failure
class, not confirmed as a separate third bug.** Working theory: Medium's
importer hit an element shape it couldn't parse (the `data:`-URI image or
the bare `<pre>`), errored internally, and gave up on everything after
that point rather than skipping the one bad element and continuing —
consistent with the truncation point falling not too long after the
article's first image/diagram. If that's right, fixing the images and
code blocks should also fix the truncation, since the trigger is gone. **Not
verified** — this needs the user to publish fresh (with the images-plus-
code-blocks fix now live) and re-import to confirm the article comes
through complete. If it *still* truncates at the same point, the cause is
something else in the markup and needs the actual cutoff point identified
from a real re-test to diagnose further.

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

- [ ] **Any article published before the §5 image-hosting fix still has
  broken (data:-URI) images in its stored HTML** — the fix only applies to
  future publishes, it doesn't retroactively repair what's already in
  Blob storage. If old articles matter, they need to be re-published
  (Resume → Compile → Publish again) to pick up real hosted image URLs.
- [ ] Confirm the §5 image-hosting + code-block fixes actually work by
  publishing something fresh and importing it into Medium for real — not
  yet done. **Specifically check whether the article now comes through in
  full** (the truncation theory needs this exact test to confirm or rule
  out) — if it still cuts off at the same point, capture where exactly and
  what content sits right before the cutoff, since that pinpoints the real
  cause.
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
