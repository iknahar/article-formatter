"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function refreshArticleList() {
  const box = $("article-list");
  box.innerHTML = `<p class="lead">Loading…</p>`;
  try {
    const r = await fetch("/api/articles");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);

    const published = data.items.filter((i) => i.kind === "published").length;
    const draft = data.items.filter((i) => i.kind === "draft").length;
    $("stat-published").textContent = published;
    $("stat-draft").textContent = draft;
    $("stat-total").textContent = data.items.length;

    if (!data.items.length) {
      box.innerHTML = `<p class="lead">Nothing published or saved yet.</p>`;
      return;
    }
    box.innerHTML = "";
    data.items.forEach((item) => box.appendChild(articleRow(item)));
  } catch (err) {
    box.innerHTML = `<p class="lead" style="color:var(--bad)">Couldn't load the list: ${esc(err.message)}</p>`;
  }
}

function articleRow(item) {
  const row = document.createElement("div");
  row.className = "article-row";
  const name = item.pathname.split("/").pop();
  const when = new Date(item.uploadedAt).toLocaleString();
  const pill = item.kind === "draft" ? '<span class="tag ext">draft</span>' : '<span class="tag ai">published</span>';
  // Resume is a plain link to the Compose page — Manage is a separate page and can't reach into
  // that page's DOM directly, so the pathname travels via a ?resume= query param instead.
  const resumeHref = `index.html?resume=${encodeURIComponent(item.pathname)}`;
  row.innerHTML = `
    <div class="article-info">
      <div><b>${esc(name)}</b> ${pill}</div>
      <div class="meta">${esc(when)}</div>
    </div>
    <div class="article-actions">
      <a href="${item.url}" target="_blank" rel="noopener" class="copy">View</a>
      <a href="${resumeHref}" class="copy">Resume</a>
      <button class="copy delete-btn">Delete</button>
    </div>`;
  row.querySelector(".delete-btn").addEventListener("click", async () => {
    if (!confirm(`Delete ${name}? This can't be undone.`)) return;
    try {
      const r = await fetch("/api/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pathname: item.pathname }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.statusText);
      row.remove();
      refreshArticleList(); // cheap way to keep the stat counts in sync after a delete
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  });
  return row;
}

$("refresh-articles").addEventListener("click", refreshArticleList);
refreshArticleList();
