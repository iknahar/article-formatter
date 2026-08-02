import { put } from "@vercel/blob";

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
    return res.status(200).json({ url: blob.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Publish failed" });
  }
}
