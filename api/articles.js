import { list } from "@vercel/blob";

// Lists everything stored — both published articles and drafts — for the Manage panel.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  try {
    const [pub, drafts] = await Promise.all([
      list({ prefix: "articles/" }),
      list({ prefix: "drafts/" }),
    ]);
    const toEntry = (kind) => (b) => ({
      pathname: b.pathname,
      kind,
      uploadedAt: b.uploadedAt,
      size: b.size,
      url: `/api/view?pathname=${encodeURIComponent(b.pathname)}`,
    });
    const isHtml = (b) => b.pathname.endsWith(".html");
    const items = [
      ...pub.blobs.filter(isHtml).map(toEntry("published")),
      ...drafts.blobs.filter(isHtml).map(toEntry("draft")),
    ].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    return res.status(200).json({ items });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to list articles" });
  }
}
