const ical = require('node-ical');
const { rrulestr } = require('rrule');

const RANGE_PAST_YEARS = 1;
const RANGE_FUTURE_YEARS = 2;

function addYears(d, n) {
  const x = new Date(d);
  x.setFullYear(x.getFullYear() + n);
  return x;
}

function rangeBounds() {
  const now = new Date();
  return {
    start: addYears(now, -RANGE_PAST_YEARS),
    end: addYears(now, RANGE_FUTURE_YEARS),
  };
}

function isCancelled(ev) {
  const s = ev.status;
  return typeof s === 'string' && s.toUpperCase() === 'CANCELLED';
}

function isAllDay(ev) {
  if (ev.datetype === 'date') return true;
  const d = ev.duration || ev.start;
  if (ev.start && ev.end) {
    const ms = ev.end.getTime() - ev.start.getTime();
    if (ms >= 36 * 60 * 60 * 1000) {
      const sh = ev.start.getHours();
      const sm = ev.start.getMinutes();
      const ss = ev.start.getSeconds();
      const eh = ev.end.getHours();
      const em = ev.end.getMinutes();
      const es = ev.end.getSeconds();
      if (sh === 0 && sm === 0 && ss === 0 && eh === 0 && em === 0 && es === 0) return true;
    }
  }
  return false;
}

function normalizeEnd(ev) {
  if (ev.end && ev.end instanceof Date) return ev.end;
  if (ev.duration && ev.start) {
    const ms =
      (ev.duration.weeks || 0) * 7 * 24 * 60 * 60 * 1000 +
      (ev.duration.days || 0) * 24 * 60 * 60 * 1000 +
      (ev.duration.hours || 0) * 60 * 60 * 1000 +
      (ev.duration.minutes || 0) * 60 * 1000 +
      (ev.duration.seconds || 0) * 1000;
    return new Date(ev.start.getTime() + ms);
  }
  if (ev.start) return new Date(ev.start.getTime() + 60 * 60 * 1000);
  return null;
}

/**
 * @param {string} icsText
 * @returns {{ startMs: number, endMs: number, allDay: number }[]}
 */
function parseBusyBlocksFromIcs(icsText) {
  const parsed = ical.parseICS(icsText);
  const masters = [];
  const exceptions = new Map();

  for (const key of Object.keys(parsed)) {
    const ev = parsed[key];
    if (!ev || ev.type !== 'VEVENT') continue;
    if (isCancelled(ev)) continue;

    if (ev.recurrenceid) {
      const rid =
        ev.recurrenceid instanceof Date
          ? ev.recurrenceid.getTime()
          : new Date(ev.recurrenceid).getTime();
      exceptions.set(rid, ev);
      continue;
    }

    masters.push(ev);
  }

  const { start: rangeStart, end: rangeEnd } = rangeBounds();
  const blocks = [];

  for (const ev of masters) {
    const rruleSource = ev.rrule ? ev.rrule.toString() : null;

    if (rruleSource) {
      let rule;
      try {
        rule = rrulestr(rruleSource, { dtstart: ev.start });
      } catch {
        continue;
      }
      const dates = rule.between(rangeStart, rangeEnd, true);
      const durationMs = (() => {
        const end = normalizeEnd(ev);
        if (!end || !ev.start) return 60 * 60 * 1000;
        return Math.max(60 * 1000, end.getTime() - ev.start.getTime());
      })();

      for (const d of dates) {
        const t = d.getTime();
        const ex = exceptions.get(t);
        if (ex && isCancelled(ex)) continue;
        if (ex && !isCancelled(ex)) {
          const st = ex.start instanceof Date ? ex.start : new Date(ex.start);
          const en = normalizeEnd({ ...ev, ...ex, start: st }) || new Date(st.getTime() + durationMs);
          const ad = isAllDay({ ...ev, ...ex, start: st, end: en });
          if (ad) {
            const dayStart = new Date(st);
            dayStart.setHours(0, 0, 0, 0);
            const lastDay = new Date(st);
            lastDay.setHours(0, 0, 0, 0);
            blocks.push({
              startMs: dayStart.getTime(),
              endMs: lastDay.getTime(),
              allDay: 1,
            });
          } else {
            blocks.push({ startMs: st.getTime(), endMs: en.getTime(), allDay: 0 });
          }
          continue;
        }

        const adMaster = isAllDay(ev);
        if (adMaster) {
          const dayStart = new Date(d);
          dayStart.setHours(0, 0, 0, 0);
          const lastDay = new Date(d);
          lastDay.setHours(0, 0, 0, 0);
          blocks.push({ startMs: dayStart.getTime(), endMs: lastDay.getTime(), allDay: 1 });
        } else {
          const st = d;
          const en = new Date(d.getTime() + durationMs);
          blocks.push({ startMs: st.getTime(), endMs: en.getTime(), allDay: 0 });
        }
      }
      continue;
    }

    if (!ev.start) continue;
    const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
    let end = normalizeEnd({ ...ev, start });
    if (!end) continue;
    if (end.getTime() <= start.getTime()) continue;

    if (isAllDay({ ...ev, start, end })) {
      const dayStart = new Date(start);
      dayStart.setHours(0, 0, 0, 0);
      const endExclusive = new Date(end);
      endExclusive.setHours(0, 0, 0, 0);
      const lastDay = new Date(endExclusive);
      lastDay.setDate(lastDay.getDate() - 1);
      if (lastDay.getTime() < dayStart.getTime()) continue;
      blocks.push({ startMs: dayStart.getTime(), endMs: lastDay.getTime(), allDay: 1 });
    } else {
      blocks.push({ startMs: start.getTime(), endMs: end.getTime(), allDay: 0 });
    }
  }

  blocks.sort((a, b) => a.startMs - b.startMs);
  return blocks;
}

module.exports = { parseBusyBlocksFromIcs, rangeBounds };
