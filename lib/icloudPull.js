const { createDAVClient } = require('tsdav');
const { parseBusyBlocksFromIcs, rangeBounds } = require('./parseBusy');

function calendarDisplayName(cal) {
  const d = cal.displayName;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') {
    const inner = d._ || d.value;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

function dedupeBlocks(blocks) {
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    const k = `${b.startMs}|${b.endMs}|${b.allDay}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  out.sort((a, c) => a.startMs - c.startMs);
  return out;
}

/**
 * @param {string} appleId
 * @param {string} appPassword iCloud app-specific password
 * @param {string[]} [calendarNameFilters] lowercase substring match on calendar display name; empty = all VEVENT calendars
 */
async function pullBusyBlocksFromIcloud(appleId, appPassword, calendarNameFilters = []) {
  const client = await createDAVClient({
    serverUrl: 'https://caldav.icloud.com/',
    credentials: { username: appleId.trim(), password: appPassword },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  const calendars = await client.fetchCalendars();
  const filters = (calendarNameFilters || [])
    .map((f) => String(f).toLowerCase().trim())
    .filter(Boolean);

  const selected = calendars.filter((cal) => {
    const comps = cal.components;
    if (Array.isArray(comps) && comps.length > 0 && !comps.includes('VEVENT')) {
      return false;
    }
    const name = calendarDisplayName(cal).toLowerCase();
    if (filters.length === 0) return true;
    return filters.some((f) => name.includes(f));
  });

  if (!selected.length) {
    const hint =
      filters.length > 0
        ? 'No calendars matched your name filters. Try removing filters or use a substring of the calendar name as shown in the Apple Calendar app.'
        : 'No event calendars were returned from iCloud.';
    throw new Error(hint);
  }

  const { start, end } = rangeBounds();
  const timeRange = { start: start.toISOString(), end: end.toISOString() };
  const allBlocks = [];

  for (const cal of selected) {
    try {
      const objects = await client.fetchCalendarObjects({
        calendar: cal,
        timeRange,
        expand: true,
      });
      for (const obj of objects) {
        const raw = obj && obj.data;
        if (!raw || typeof raw !== 'string') continue;
        try {
          allBlocks.push(...parseBusyBlocksFromIcs(raw));
        } catch {
          /* ignore malformed object */
        }
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[icloud] fetch failed for "${cal.displayName || cal.url}": ${msg}`);
    }
  }

  return dedupeBlocks(allBlocks);
}

module.exports = { pullBusyBlocksFromIcloud };
