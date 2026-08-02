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
    await del(pathname);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Delete failed" });
  }
}
