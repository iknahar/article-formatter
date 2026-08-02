import { put, list, del } from "@vercel/blob";

// Rolling window: only this many PUBLISHED articles are kept live at once. Drafts are never
// auto-deleted by this limit — only explicit delete removes a draft.
// Override with a MAX_ARTICLES env var on the Vercel project if you want a different number.
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES) || 20;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  try {
    const { slug, html, draft } = req.body || {};
    if (!html || typeof html !== "string") {
      return res.status(400).json({ error: "Missing article HTML" });
    }
    if (html.length > 4_000_000) {
      return res.status(413).json({ error: "Article is too large (over 4 MB). Use fewer or smaller images." });
    }
    const safeSlug = String(slug || "article").replace(/[^a-z0-9-]/gi, "").slice(0, 60) || "article";
    const prefix = draft ? "drafts" : "articles";

    // This project's Blob store is Private (see README) — a private blob's own URL
    // requires an Authorization header and is not fetchable by anyone else, so we
    // upload with access: "private" and hand back a link through our own /api/view
    // route instead (see view.js), which authenticates to Blob server-side and
    // streams the content back with no auth gate of its own.
    const blob = await put(`${prefix}/${safeSlug}.html`, html, {
      access: "private",
      contentType: "text/html; charset=utf-8",
      addRandomSuffix: true,
    });

    // Only published articles are subject to the rolling window — drafts are exempt.
    let kept = null, deletedCount = 0;
    if (!draft) {
      const { blobs } = await list({ prefix: "articles/" });
      const byNewest = blobs.slice().sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      const stale = byNewest.slice(MAX_ARTICLES).map((b) => b.url);
      if (stale.length) await del(stale);
      kept = Math.min(byNewest.length, MAX_ARTICLES);
      deletedCount = stale.length;
    }

    const proto = req.headers["x-forwarded-proto"] || "https";
    const base = `${proto}://${req.headers.host}`;
    const publicUrl = `${base}/api/view?pathname=${encodeURIComponent(blob.pathname)}`;

    return res.status(200).json({
      url: publicUrl,
      kind: draft ? "draft" : "published",
      kept,
      deleted: deletedCount,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Publish failed" });
  }
}
