import { Readable } from "node:stream";
import { get } from "@vercel/blob";

// Fetches the raw editable snapshot (title/subtitle/body text/every image's data) saved
// alongside a published article or draft, so the wizard can be reloaded and re-edited.
// Articles published before this feature existed have no companion .json — 404s cleanly.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const { pathname } = req.query;
  if (!pathname || typeof pathname !== "string") {
    return res.status(400).json({ error: "Missing pathname" });
  }
  try {
    const jsonPathname = pathname.replace(/\.html$/, ".json");
    const result = await get(jsonPathname, { access: "private" });
    if (!result || result.statusCode !== 200) {
      return res.status(404).json({ error: "No saved snapshot for this article (published before Resume existed?)" });
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    Readable.fromWeb(result.stream).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load snapshot" });
  }
}
