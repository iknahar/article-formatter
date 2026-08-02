import { put } from "@vercel/blob";

// Uploads a single image (as a base64 data URL) to Blob storage and returns a real,
// independently-fetchable link through /api/view. This exists because embedding images as
// data: URIs directly in the published HTML — the original design — turned out to be
// invisible to Medium's story importer: it fetches each <img src> over HTTP to re-host on its
// own CDN, and a data: URI has nothing to fetch, so every image was silently dropped on import
// even though the text came through fine. See PLAN.md for the full story.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  try {
    const { dataURL } = req.body || {};
    if (!dataURL || typeof dataURL !== "string") {
      return res.status(400).json({ error: "Missing dataURL" });
    }
    const m = dataURL.match(/^data:([^;]+);base64,(.*)$/s);
    if (!m) {
      return res.status(400).json({ error: "Only base64 data: URLs are supported" });
    }
    const contentType = m[1];
    const buffer = Buffer.from(m[2], "base64");
    if (buffer.length > 4_000_000) {
      return res.status(413).json({ error: "Image is too large (over 4 MB)." });
    }
    const ext = (contentType.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "jpg";
    const pathname = `images/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    // Same Private-store-plus-/api/view pattern as articles (see publish.js) — no separate
    // decision to make here, just reusing the existing mechanism for a different content type.
    const blob = await put(pathname, buffer, {
      access: "private", contentType, addRandomSuffix: false,
    });

    const proto = req.headers["x-forwarded-proto"] || "https";
    const base = `${proto}://${req.headers.host}`;
    return res.status(200).json({ url: `${base}/api/view?pathname=${encodeURIComponent(blob.pathname)}` });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Image upload failed" });
  }
}
