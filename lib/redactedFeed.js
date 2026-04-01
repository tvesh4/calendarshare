const crypto = require('crypto');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatUtcDateTime(dt) {
  return (
    dt.getUTCFullYear() +
    pad2(dt.getUTCMonth() + 1) +
    pad2(dt.getUTCDate()) +
    'T' +
    pad2(dt.getUTCHours()) +
    pad2(dt.getUTCMinutes()) +
    pad2(dt.getUTCSeconds()) +
    'Z'
  );
}

/** All-day events use floating local dates (matches Apple/Google all-day). */
function formatDateOnlyLocal(ms) {
  const d = new Date(ms);
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

function foldLine(line) {
  const max = 75;
  if (line.length <= max) return line;
  let out = '';
  let rest = line;
  while (rest.length > max) {
    out += rest.slice(0, max) + '\r\n ';
    rest = rest.slice(max);
  }
  return out + rest;
}

function uidFor(token, startMs, endMs, allDay) {
  return crypto
    .createHash('sha256')
    .update(`${token}|${startMs}|${endMs}|${allDay}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Busy-only calendar: SUMMARY and categories are generic; no DESCRIPTION, LOCATION, etc.
 */
function buildRedactedIcs(token, blocks, dtstamp = new Date()) {
  const stamp = formatUtcDateTime(dtstamp);
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CalendarShare//Busy only//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'NAME:Busy times (shared)',
    'X-WR-CALNAME:Busy times (shared)',
    'X-PUBLISHED-TTL:PT1H',
  ];

  const lines = [...header];

  for (const b of blocks) {
    const uid = uidFor(token, b.startMs, b.endMs, b.allDay);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}@calendarshare`);
    lines.push(`DTSTAMP:${stamp}`);
    if (b.allDay) {
      const start = new Date(b.startMs);
      const endExclusive = new Date(b.endMs);
      endExclusive.setDate(endExclusive.getDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${formatDateOnlyLocal(start)}`);
      lines.push(`DTEND;VALUE=DATE:${formatDateOnlyLocal(endExclusive)}`);
    } else {
      lines.push(`DTSTART:${formatUtcDateTime(new Date(b.startMs))}`);
      lines.push(`DTEND:${formatUtcDateTime(new Date(b.endMs))}`);
    }
    lines.push('SUMMARY:Busy');
    lines.push('TRANSP:OPAQUE');
    lines.push('STATUS:CONFIRMED');
    lines.push('CATEGORIES:BLOCKED');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map((l) => foldLine(l)).join('\r\n') + '\r\n';
}

module.exports = { buildRedactedIcs };
