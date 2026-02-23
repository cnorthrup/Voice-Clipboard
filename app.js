// v2: MediaRecorder → Groq Whisper → auto-copy
// ?record=true opens a focused overlay for Back Tap / Action Button / Shortcut flow

const $ = id => document.getElementById(id);

// DOM refs
const textEl          = $('text');
const recordBtn       = $('recordBtn');
const stopBtn         = $('stopBtn');
const copyBtn         = $('copyBtn');
const saveBtn         = $('saveBtn');
const clearBtn        = $('clearBtn');
const statusEl        = $('status');
const historyEl       = $('history');
const exportBtn       = $('exportBtn');
const importFile      = $('importFile');
const settingsToggle  = $('settingsToggle');
const settingsPanel   = $('settingsPanel');
const apiKeyInput     = $('apiKeyInput');
const saveKeyBtn      = $('saveKeyBtn');
const keyStatus       = $('keyStatus');

// Focus overlay refs
const focusOverlay    = $('focusOverlay');
const focusPulse      = $('focusPulse');
const focusEmoji      = $('focusEmoji');
const focusLabel      = $('focusLabel');
const focusHint       = $('focusHint');
const focusTranscript = $('focusTranscript');
const focusStopBtn    = $('focusStopBtn');
const focusCancelBtn  = $('focusCancelBtn');

// Storage keys
const LS_HISTORY = 'vc_history_v1';
const LS_API_KEY = 'vc_groq_key';

// --- API Key ---
const getApiKey   = () => localStorage.getItem(LS_API_KEY) || '';
const storeApiKey = k  => localStorage.setItem(LS_API_KEY, k.trim());

// --- History helpers ---
function nowIso() { return new Date().toISOString(); }

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); }
  catch { return []; }
}
function saveHistory(items) { localStorage.setItem(LS_HISTORY, JSON.stringify(items)); }

function setStatus(msg) { statusEl.textContent = msg; }

async function copyToClipboard(str) {
  try {
    await navigator.clipboard.writeText(str);
    setStatus('Copied ✅  Switch back and paste.');
    return true;
  } catch {
    textEl.focus();
    textEl.select();
    setStatus('Tap and Copy (clipboard permission blocked).');
    return false;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[m])
  );
}

function addToHistory(text) {
  const items = loadHistory();
  items.push({ id: crypto.randomUUID(), createdAt: nowIso(), text });
  saveHistory(items);
  renderHistory();
}

function renderHistory() {
  const items = loadHistory().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  historyEl.innerHTML = '';
  if (!items.length) {
    historyEl.innerHTML = `<div class="item"><div class="text">No history yet.</div></div>`;
    return;
  }
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="meta">
        <span>${new Date(item.createdAt).toLocaleString()}</span>
        <span>${(item.text || '').length} chars</span>
      </div>
      <div class="text">${escapeHtml(item.text || '')}</div>
      <div class="actions">
        <button class="btn" data-act="copy" data-id="${item.id}">Copy</button>
        <button class="btn danger" data-act="delete" data-id="${item.id}">Delete</button>
      </div>`;
    historyEl.appendChild(div);
  }
}

// --- MediaRecorder ---
let mediaRecorder = null;
let audioChunks   = [];

async function startAudioRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
  mediaRecorder  = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  audioChunks    = [];
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start();
}

function stopAudioRecording() {
  return new Promise(resolve => {
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/mp4' });
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      resolve(blob);
    };
    mediaRecorder.stop();
  });
}

function killRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    mediaRecorder.stop();
  }
}

// --- Groq Whisper ---
async function transcribeWithGroq(blob) {
  const key = getApiKey();
  if (!key) throw new Error('no_key');

  const ext  = blob.type.includes('webm') ? 'webm'
             : blob.type.includes('ogg')  ? 'ogg'
             : 'm4a';
  const form = new FormData();
  form.append('file',  blob, `rec.${ext}`);
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'text');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}` },
    body:    form,
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${msg.slice(0, 120)}`);
  }
  return (await res.text()).trim();
}

// --- Normal record flow ---
recordBtn.addEventListener('click', async () => {
  if (!getApiKey()) {
    settingsPanel.hidden = false;
    apiKeyInput.focus();
    setStatus('Enter your Groq API key in Settings (⚙) first.');
    return;
  }
  try {
    setStatus('Starting microphone…');
    await startAudioRecording();
    recordBtn.disabled = true;
    recordBtn.classList.add('recording');
    stopBtn.disabled = false;
    setStatus('🎙 Recording… tap Stop when done.');
  } catch {
    setStatus('Microphone access denied. Check browser permissions.');
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled   = true;
  recordBtn.disabled = true;
  recordBtn.classList.remove('recording');
  setStatus('Transcribing…');
  try {
    const blob = await stopAudioRecording();
    const text = await transcribeWithGroq(blob);
    if (!text) { setStatus('Nothing detected.'); recordBtn.disabled = false; return; }
    textEl.value = text;
    await copyToClipboard(text);
    addToHistory(text);
  } catch (e) {
    if (e.message === 'no_key') {
      setStatus('No API key — open Settings (⚙) to add your Groq key.');
      settingsPanel.hidden = false;
    } else {
      setStatus('Error: ' + e.message);
    }
  } finally {
    recordBtn.disabled = false;
  }
});

// --- Focus overlay (for ?record=true mode) ---
const isFocusMode = new URLSearchParams(location.search).has('record');

function setFocusState(state, msg) {
  focusOverlay.dataset.state = state;
  focusPulse.className = 'focus-pulse' + (state === 'recording' ? ' active' : '');

  // Reset visibility
  focusStopBtn.hidden    = false;
  focusCancelBtn.hidden  = false;
  focusTranscript.hidden = true;
  focusHint.hidden       = false;

  if (state === 'ready') {
    focusEmoji.textContent    = '🎙';
    focusLabel.textContent    = 'Tap to Record';
    focusHint.textContent     = 'Opens microphone and starts listening';
    focusStopBtn.textContent  = '● Record';
    focusCancelBtn.textContent = 'Cancel';
  } else if (state === 'recording') {
    focusEmoji.textContent    = '🎙';
    focusLabel.textContent    = 'Listening…';
    focusHint.textContent     = 'Tap Stop when you\'re done speaking';
    focusStopBtn.textContent  = '■ Stop';
    focusCancelBtn.textContent = 'Cancel';
  } else if (state === 'transcribing') {
    focusEmoji.textContent = '⏳';
    focusLabel.textContent = 'Transcribing…';
    focusHint.hidden       = true;
    focusStopBtn.hidden    = true;
    focusCancelBtn.hidden  = true;
  } else if (state === 'done') {
    focusEmoji.textContent     = '✅';
    focusLabel.textContent     = 'Copied! Switch back and paste.';
    focusHint.hidden           = true;
    focusTranscript.hidden     = false;
    focusStopBtn.textContent   = 'Done';
    focusCancelBtn.hidden      = true;
  } else if (state === 'error') {
    focusEmoji.textContent     = '❌';
    focusLabel.textContent     = msg || 'Something went wrong.';
    focusHint.hidden           = true;
    focusStopBtn.hidden        = true;
    focusCancelBtn.textContent = 'Close';
  }
}

async function runFocusMode() {
  focusOverlay.hidden       = false;
  document.body.style.overflow = 'hidden';

  if (!getApiKey()) {
    setFocusState('error', 'No API key set. Open the app and add your Groq key in Settings (⚙).');
    return;
  }
  setFocusState('ready');
}

focusStopBtn.addEventListener('click', async () => {
  const state = focusOverlay.dataset.state;

  if (state === 'ready') {
    try {
      await startAudioRecording();
      setFocusState('recording');
    } catch {
      setFocusState('error', 'Microphone access denied. Check browser permissions.');
    }
    return;
  }

  if (state === 'done') {
    closeFocusOverlay();
    return;
  }

  if (state !== 'recording') return;

  setFocusState('transcribing');
  try {
    const blob = await stopAudioRecording();
    const text = await transcribeWithGroq(blob);
    if (!text) {
      setFocusState('error', 'Nothing detected. Try again.');
      return;
    }
    focusTranscript.textContent = text;
    await navigator.clipboard.writeText(text).catch(() => {});
    addToHistory(text);
    setFocusState('done');
  } catch (e) {
    setFocusState('error', e.message === 'no_key'
      ? 'No API key set. Open Settings (⚙).'
      : 'Error: ' + e.message);
  }
});

focusCancelBtn.addEventListener('click', () => {
  killRecording();
  closeFocusOverlay();
});

function closeFocusOverlay() {
  focusOverlay.hidden          = true;
  document.body.style.overflow = '';
}

// --- Settings panel ---
settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  if (!settingsPanel.hidden) {
    apiKeyInput.value = getApiKey();
    apiKeyInput.focus();
  }
});

saveKeyBtn.addEventListener('click', () => {
  const k = apiKeyInput.value.trim();
  if (!k) { keyStatus.textContent = 'Enter a key first.'; return; }
  storeApiKey(k);
  keyStatus.textContent = '✅ Saved!';
  setTimeout(() => {
    keyStatus.textContent = '';
    settingsPanel.hidden  = true;
    setStatus('Ready.');
  }, 1200);
});

apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveKeyBtn.click(); });

// --- History panel ---
copyBtn.addEventListener('click', async () => {
  const t = (textEl.value || '').trim();
  if (!t) return setStatus('Nothing to copy.');
  await copyToClipboard(t);
});

saveBtn.addEventListener('click', () => {
  const t = (textEl.value || '').trim();
  if (!t) return setStatus('Nothing to save.');
  addToHistory(t);
  setStatus('Saved to history ✅');
});

clearBtn.addEventListener('click', () => {
  textEl.value = '';
  setStatus('Cleared.');
});

historyEl.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'copy') {
    const item = loadHistory().find(x => x.id === id);
    if (item) await copyToClipboard(item.text || '');
  }
  if (act === 'delete') {
    saveHistory(loadHistory().filter(x => x.id !== id));
    renderHistory();
    setStatus('Deleted.');
  }
});

exportBtn.addEventListener('click', () => {
  const items = loadHistory();
  const blob  = new Blob(
    [JSON.stringify({ version: 1, exportedAt: nowIso(), items }, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `voice-clipboard-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Exported ✅');
});

importFile.addEventListener('change', async () => {
  const f = importFile.files?.[0];
  if (!f) return;
  try {
    const data     = JSON.parse(await f.text());
    const incoming = Array.isArray(data.items) ? data.items : [];
    const map      = new Map(loadHistory().map(x => [x.id, x]));
    for (const it of incoming) {
      if (it?.id && typeof it.text === 'string' && it.createdAt) map.set(it.id, it);
    }
    saveHistory([...map.values()]);
    renderHistory();
    setStatus('Imported ✅');
  } catch {
    setStatus('Import failed: invalid JSON.');
  } finally {
    importFile.value = '';
  }
});

// --- Init ---
renderHistory();
if (isFocusMode) {
  runFocusMode();
} else {
  setStatus(getApiKey() ? 'Ready.' : 'Tap ⚙ to add your Groq API key and get started.');
}
