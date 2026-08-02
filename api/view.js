import { Readable } from "node:stream";
import { get } from "@vercel/blob";

// Serves a blob from the Private store publicly, no auth check — that's the point.
// The store itself is Private (so raw *.private.blob.vercel-storage.com URLs need an
// Authorization header nobody outside Vercel has), but a published article needs a
// plain link anyone — including Medium's story importer — can just open. This route
// authenticates to Blob server-side (OIDC, same as publish.js) and streams the
// content back with no gate of its own, making it the effectively-public front door.
export default async function handler(req, res) {
  const { pathname } = req.query;
  if (!pathname || typeof pathname !== "string") {
    return res.status(400).json({ error: "Missing pathname" });
  }
  try {
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200) {
      return res.status(404).send("Not found");
    }
    res.setHeader("Content-Type", result.blob.contentType || "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=300");
    Readable.fromWeb(result.stream).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load article" });
  }
}
