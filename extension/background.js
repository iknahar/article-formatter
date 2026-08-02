// Background service worker.
//   1. Clicking the toolbar icon opens the self-contained wizard page in its own tab.
//   2. Relays the finished article from the wizard tab to the content script running in an open
//      Medium story-edit tab (the two live in different tabs, so they can't talk directly).

// Toolbar click → open (or focus) the wizard.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("wizard.html");
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId != null) chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});

// Open the wizard from anywhere (used by the on-page panel's "Open the wizard" button).
async function openWizard() {
  const url = chrome.runtime.getURL("wizard.html");
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId != null) await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// Wizard → (this worker) → Medium tab's content script.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "af-open-wizard") {
    openWizard().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type !== "af-send") return; // not ours

  (async () => {
    try {
      // Find an open Medium story-edit tab. Edit URLs vary (/p/<id>/edit, /new-story,
      // /@user/<slug>/edit), so match medium.com broadly and prefer one that looks like an editor.
      const tabs = await chrome.tabs.query({ url: ["https://medium.com/*"] });
      const editTab =
        tabs.find((t) => /\/(edit|new-story)\b/.test(t.url || "")) ||
        tabs.find((t) => /\/p\//.test(t.url || "")) ||
        tabs[0];
      if (!editTab) {
        sendResponse({ ok: false, error: "No medium.com tab is open. Open a Medium draft (…/edit) in another tab, then try again." });
        return;
      }
      // Ask that tab's content script to insert the article.
      const reply = await chrome.tabs.sendMessage(editTab.id, { type: "af-insert", payload: msg.payload });
      sendResponse(reply || { ok: false, error: "The Medium tab didn't respond. Reload that tab so the helper loads, then retry." });
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
