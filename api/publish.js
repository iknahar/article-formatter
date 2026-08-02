import { put, list, del } from "@vercel/blob";

// Rolling window: only this many published articles are kept live at once.
// Override with a MAX_ARTICLES env var on the Vercel project if you want a different number.
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES) || 5;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  try {
    const { slug, html } = req.body || {};
    if (!html || typeof html !== "string") {
      return res.status(400).json({ error: "Missing article HTML" });
    }
    if (html.length > 4_000_000) {
      return res.status(413).json({ error: "Article is too large (over 4 MB). Use fewer or smaller images." });
    }
    const safeSlug = String(slug || "article").replace(/[^a-z0-9-]/gi, "").slice(0, 60) || "article";

    const blob = await put(`articles/${safeSlug}.html`, html, {
      access: "public",
      contentType: "text/html; charset=utf-8",
      addRandomSuffix: true,
    });

    // enforce the rolling window: keep the MAX_ARTICLES most recently uploaded, delete the rest
    const { blobs } = await list({ prefix: "articles/" });
    const byNewest = blobs.slice().sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const stale = byNewest.slice(MAX_ARTICLES).map((b) => b.url);
    if (stale.length) await del(stale);

    return res.status(200).json({
      url: blob.url,
      kept: Math.min(byNewest.length, MAX_ARTICLES),
      deleted: stale.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Publish failed" });
  }
}
