import { del } from "@vercel/blob";

// Manual delete for a single article or draft, used by the Manage panel's Delete button.
export default async function handler(req, res) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "DELETE only" });
  }
  try {
    const { pathname } = req.body || {};
    if (!pathname || typeof pathname !== "string") {
      return res.status(400).json({ error: "Missing pathname" });
    }
    // del() is a no-op (not an error) for a pathname that doesn't exist, so it's safe to always
    // also try the companion snapshot even for articles published before Resume existed.
    const jsonPathname = pathname.replace(/\.html$/, ".json");
    await del([pathname, jsonPathname]);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Delete failed" });
  }
}
