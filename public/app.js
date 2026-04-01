const form = document.getElementById('upload-form');
const icloudForm = document.getElementById('icloud-form');
const result = document.getElementById('result');
const manageRow = document.getElementById('manage-row');
const updateMode = document.getElementById('update-mode');
const submitBtn = document.getElementById('submit-btn');
const icloudSubmit = document.getElementById('icloud-submit');
const icloudActions = document.getElementById('icloud-actions');
const syncNowBtn = document.getElementById('sync-now-btn');

updateMode.addEventListener('change', () => {
  manageRow.classList.toggle('hidden', !updateMode.checked);
  submitBtn.textContent = updateMode.checked ? 'Upload & update share' : 'Upload & create link';
});

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

/** Read value from an input/textarea or text from other nodes. */
function getCopyValue(el) {
  if (!el) return '';
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.trim();
  }
  return el.textContent.trim();
}

/**
 * Clipboard API when available; fallback for http / file / strict browsers.
 */
async function copyTextToClipboard(text) {
  if (text == null || text === '') return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* try fallback */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '0';
  ta.style.top = '0';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
  return ok;
}

function buildPlainTextSummary(subscribeUrl, webcalUrl, manageLine) {
  const lines = [
    'Subscribe (HTTPS):',
    subscribeUrl || '',
    '',
    'Webcal:',
    webcalUrl || '',
    '',
    'Manage key (private — keep secret):',
    manageLine || '',
  ];
  return lines.join('\n');
}

function showResult(data, { isUpdate, icloudSync }) {
  result.classList.remove('hidden');
  const sub = data.subscribeUrl || '';
  const web = data.webcalUrl || '';
  let manageLine;
  if (!isUpdate && data.manageKey) {
    manageLine = data.manageKey;
  } else if (isUpdate) {
    manageLine = '(unchanged — use the manage key you saved earlier)';
  } else {
    manageLine = data.manageKey || '';
  }

  document.getElementById('out-subscribe').value = sub;
  document.getElementById('out-webcal').value = web;
  document.getElementById('out-manage').value = manageLine;

  document.getElementById('printable-links').value = buildPlainTextSummary(sub, web, manageLine);

  let meta = '';
  if (typeof data.eventCount === 'number') {
    meta = `${data.eventCount} busy block(s) published (repeating events expanded ~1 year back / 2 years forward).`;
  }
  if (icloudSync) {
    meta += ' iCloud sync is enabled; the feed refreshes automatically.';
  }
  document.getElementById('out-meta').textContent = meta;

  if (icloudSync && data.manageKey) {
    icloudActions.classList.remove('hidden');
    icloudActions.dataset.manageKey = data.manageKey;
  } else {
    icloudActions.classList.add('hidden');
    delete icloudActions.dataset.manageKey;
  }
}

document.querySelectorAll('button.copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-copy');
    const el = document.getElementById(id);
    const text = getCopyValue(el);
    if (!text || text.startsWith('(')) {
      toast('Nothing to copy');
      return;
    }
    const ok = await copyTextToClipboard(text);
    toast(ok ? 'Copied' : 'Select the field and press ⌘C / Ctrl+C');
  });
});

document.getElementById('copy-all-btn').addEventListener('click', async () => {
  const ta = document.getElementById('printable-links');
  const text = ta.value.trim();
  if (!text) {
    toast('Nothing to copy');
    return;
  }
  const ok = await copyTextToClipboard(text);
  toast(ok ? 'Copied all' : 'Select the box below and press ⌘C / Ctrl+C');
});

syncNowBtn.addEventListener('click', async () => {
  const mk = icloudActions.dataset.manageKey;
  if (!mk) {
    toast('Manage key missing');
    return;
  }
  syncNowBtn.disabled = true;
  try {
    const r = await fetch('/api/sync/icloud/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manageKey: mk }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(data.error || 'Sync failed');
      return;
    }
    if (data.skipped) {
      toast('Sync already running');
    } else {
      toast(data.eventCount != null ? `Synced (${data.eventCount} blocks)` : 'Synced');
    }
  } catch {
    toast('Network error');
  } finally {
    syncNowBtn.disabled = false;
  }
});

icloudForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(icloudForm);
  const appleId = String(fd.get('appleId') || '').trim();
  const appPassword = String(fd.get('appPassword') || '');
  const calendarNamesRaw = String(fd.get('calendarNames') || '').trim();
  const manageKey = String(fd.get('manageKey') || '').trim();

  if (!appleId || !appPassword) {
    toast('Apple ID and app password are required');
    return;
  }

  const calendarNames = calendarNamesRaw
    ? calendarNamesRaw
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const body = { appleId, appPassword, calendarNames };
  if (manageKey) body.manageKey = manageKey;

  icloudSubmit.disabled = true;
  try {
    const r = await fetch('/api/shares/icloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(data.error || 'Request failed');
      return;
    }

    showResult(data, { isUpdate: Boolean(manageKey), icloudSync: true });
    toast(manageKey ? 'iCloud updated for this share' : 'iCloud connected');
    icloudForm.reset();
  } catch {
    toast('Network error');
  } finally {
    icloudSubmit.disabled = false;
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const file = fd.get('calendar');
  if (!(file instanceof File) || file.size === 0) {
    toast('Choose a calendar file');
    return;
  }

  const isUpdate = updateMode.checked;
  const method = isUpdate ? 'PUT' : 'POST';

  if (isUpdate) {
    const mk = fd.get('manageKey');
    if (!mk || String(mk).trim() === '') {
      toast('Paste your manage key to update');
      return;
    }
  }

  const body = new FormData();
  body.append('calendar', file);
  if (isUpdate) body.append('manageKey', String(fd.get('manageKey')).trim());

  submitBtn.disabled = true;
  try {
    const r = await fetch('/api/shares', { method, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(data.error || 'Request failed');
      return;
    }

    showResult(data, { isUpdate, icloudSync: false });
    toast(isUpdate ? 'Updated' : 'Created');
  } catch {
    toast('Network error');
  } finally {
    submitBtn.disabled = false;
  }
});
