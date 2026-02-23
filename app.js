// v1 MVP: "Record" focuses text area so you can use iOS dictation,
// then Stop auto-copies + optionally saves. Web speech APIs on iOS are unreliable,
// so we start with the fastest workable flow.

const $ = (id) => document.getElementById(id);

const textEl = $("text");
const recordBtn = $("recordBtn");
const stopBtn = $("stopBtn");
const copyBtn = $("copyBtn");
const saveBtn = $("saveBtn");
const clearBtn = $("clearBtn");
const statusEl = $("status");
const historyEl = $("history");
const exportBtn = $("exportBtn");
const importFile = $("importFile");

const LS_KEY = "vc_history_v1";

function nowIso() { return new Date().toISOString(); }

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveHistory(items) {
  localStorage.setItem(LS_KEY, JSON.stringify(items));
}

function setStatus(msg) { statusEl.textContent = msg; }

async function copyToClipboard(str) {
  try {
    await navigator.clipboard.writeText(str);
    setStatus("Copied ✅ Switch back and paste.");
    return true;
  } catch (e) {
    // Fallback: select text for manual copy
    textEl.focus();
    textEl.select();
    setStatus("Tap and Copy (clipboard permission blocked).");
    return false;
  }
}

function renderHistory() {
  const items = loadHistory().sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  historyEl.innerHTML = "";
  if (!items.length) {
    historyEl.innerHTML = `<div class="item"><div class="text">No history yet.</div></div>`;
    return;
  }

  for (const item of items) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="meta">
        <span>${new Date(item.createdAt).toLocaleString()}</span>
        <span>${(item.text || "").length} chars</span>
      </div>
      <div class="text">${escapeHtml(item.text || "")}</div>
      <div class="actions">
        <button class="btn" data-act="copy" data-id="${item.id}">Copy</button>
        <button class="btn danger" data-act="delete" data-id="${item.id}">Delete</button>
      </div>
    `;
    historyEl.appendChild(div);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

function addToHistory(text) {
  const items = loadHistory();
  items.push({ id: crypto.randomUUID(), createdAt: nowIso(), text });
  saveHistory(items);
  renderHistory();
}

recordBtn.addEventListener("click", () => {
  // "Record" mode: focus textarea so iOS dictation can be used immediately.
  // (This is the quickest web-first v1 that works reliably.)
  textEl.focus();
  stopBtn.disabled = false;
  recordBtn.disabled = true;
  setStatus("Dictate now using the keyboard mic. Tap Stop when done.");
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  recordBtn.disabled = false;

  const t = (textEl.value || "").trim();
  if (!t) {
    setStatus("Nothing to copy yet.");
    return;
  }
  await copyToClipboard(t);
});

copyBtn.addEventListener("click", async () => {
  const t = (textEl.value || "").trim();
  if (!t) return setStatus("Nothing to copy.");
  await copyToClipboard(t);
});

saveBtn.addEventListener("click", () => {
  const t = (textEl.value || "").trim();
  if (!t) return setStatus("Nothing to save.");
  addToHistory(t);
  setStatus("Saved to history ✅");
});

clearBtn.addEventListener("click", () => {
  textEl.value = "";
  setStatus("Cleared.");
});

historyEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === "copy") {
    const items = loadHistory();
    const item = items.find(x => x.id === id);
    if (!item) return;
    await copyToClipboard(item.text || "");
  }

  if (act === "delete") {
    const items = loadHistory().filter(x => x.id !== id);
    saveHistory(items);
    renderHistory();
    setStatus("Deleted.");
  }
});

exportBtn.addEventListener("click", () => {
  const items = loadHistory();
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: nowIso(), items }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `voice-clipboard-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Exported ✅");
});

importFile.addEventListener("change", async () => {
  const f = importFile.files?.[0];
  if (!f) return;
  const txt = await f.text();
  try {
    const data = JSON.parse(txt);
    const incoming = Array.isArray(data.items) ? data.items : [];
    // merge by id
    const existing = loadHistory();
    const map = new Map(existing.map(x => [x.id, x]));
    for (const it of incoming) {
      if (it?.id && typeof it.text === "string" && it.createdAt) map.set(it.id, it);
    }
    saveHistory([...map.values()]);
    renderHistory();
    setStatus("Imported ✅");
  } catch {
    setStatus("Import failed: invalid JSON.");
  } finally {
    importFile.value = "";
  }
});

renderHistory();
setStatus("Ready.");
