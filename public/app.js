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

function showResult(data, { isUpdate, icloudSync }) {
  result.classList.remove('hidden');
  document.getElementById('out-subscribe').textContent = data.subscribeUrl || '';
  document.getElementById('out-webcal').textContent = data.webcalUrl || '';

  if (!isUpdate && data.manageKey) {
    document.getElementById('out-manage').textContent = data.manageKey;
  } else if (isUpdate) {
    document.getElementById('out-manage').textContent = '(unchanged — use saved key)';
  } else {
    document.getElementById('out-manage').textContent = data.manageKey || '';
  }

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
    const code = document.getElementById(id);
    if (!code) return;
    const text = code.textContent.trim();
    if (!text || text.startsWith('(')) {
      toast('Nothing to copy');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Could not copy');
    }
  });
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
