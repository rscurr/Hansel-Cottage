// src/ics.ts
//
// Hybrid model support: fast availability scanning from ICS.
// Set ICS_URL in your environment to your Bookalet calendar .ics feed.
// This parser is intentionally simple and optimized for all-day bookings.

import { addDays, eachDayOfInterval, endOfMonth, formatISO, isBefore, isEqual, isWithinInterval, parseISO, startOfMonth } from 'date-fns';

type Booking = { start: string; end: string }; // [start, end) ISO dates YYYY-MM-DD
let BOOKINGS: Booking[] = [];
let LAST_REFRESH = 0;
const REFRESH_MS = 15 * 60 * 1000; // 15 minutes

function toIsoDate(s: string): string {
  // Accept YYYYMMDD or YYYY-MM-DD; return YYYY-MM-DD
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // last resort: Date parse
  const d = new Date(s);
  return formatISO(d, { representation: 'date' });
}

// Very small .ics parser for all-day DTSTART/DTEND lines.
// We assume bookings are VEVENT with DTSTART/DTEND and no overlaps within a single event.
function parseIcs(text: string): Booking[] {
  const lines = text.split(/\r?\n/);
  let cur: Record<string,string> = {};
  const events: Record<string,string>[] = [];

  const flush = () => {
    if (Object.keys(cur).length) {
      events.push(cur);
      cur = {};
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { flush(); continue; }
    if (!line || line.startsWith('BEGIN:') || line.startsWith('END:')) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const keyPart = line.slice(0, idx); // e.g. "DTSTART;VALUE=DATE" or "DTEND"
    const val = line.slice(idx + 1);

    const key = keyPart.split(';')[0].toUpperCase(); // "DTSTART" / "DTEND"
    if (key === 'DTSTART' || key === 'DTEND') {
      // VALUE=DATE case like 20250814 or date-time like 20250814T120000Z
      const m = val.match(/^(\d{8})(T\d{6}Z)?$/);
      if (m) {
        cur[key] = toIsoDate(m[1]);
      } else {
        // fallback for other formats
        cur[key] = toIsoDate(val);
      }
    }
  }

  // Map VEVENTs to [start, end) bookings
  const bookings: Booking[] = [];
  for (const e of events) {
    if (!e.DTSTART || !e.DTEND) continue;
    // ICS DTEND is exclusive; we keep it exclusive but store ISO-date strings
    bookings.push({ start: e.DTSTART, end: e.DTEND });
  }
  // Normalize & sort
  bookings.sort((a, b) => a.start.localeCompare(b.start));
  return bookings;
}

export async function refreshIcs(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - LAST_REFRESH < REFRESH_MS) return;
  const url = process.env.ICS_URL;
  if (!url) {
    BOOKINGS = [];
    LAST_REFRESH = now;
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ICS fetch ${res.status}`);
  const text = await res.text();
  BOOKINGS = parseIcs(text);
  LAST_REFRESH = now;
}

export function getIcsStats() {
  return {
    bookings: BOOKINGS.length,
    lastRefresh: LAST_REFRESH ? new Date(LAST_REFRESH).toISOString() : null
  };
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  // intervals [aStart, aEnd) and [bStart, bEnd) overlap if aStart < bEnd && bStart < aEnd
  return aStart < bEnd && bStart < aEnd;
}

export function isRangeAvailable(fromIso: string, nights: number): boolean {
  if (nights <= 0) return false;
  const start = fromIso;
  const end = formatISO(addDays(parseISO(fromIso), nights), { representation: 'date' });
  for (const b of BOOKINGS) {
    if (overlaps(start, end, b.start, b.end)) return false;
  }
  return true;
}

export function suggestAlternatives(fromIso: string, nights: number, max = 10): Array<{ from: string; nights: number }> {
  const startDate = parseISO(fromIso);
  const forward: Array<{ from: string; nights: number }> = [];
  // scan up to ~120 days ahead
  for (let i = 1; i <= 120 && forward.length < max; i++) {
    const d = addDays(startDate, i);
    const iso = formatISO(d, { representation: 'date' });
    if (isRangeAvailable(iso, nights)) forward.push({ from: iso, nights });
  }
  return forward;
}

export function findAvailabilityInMonth(year: number, month1to12: number, nights: number, max = 100): Array<{ from: string; nights: number }> {
  const first = startOfMonth(new Date(Date.UTC(year, month1to12 - 1, 1)));
  const last = endOfMonth(first);
  const days = eachDayOfInterval({ start: first, end: last });
  const out: Array<{ from: string; nights: number }> = [];

  for (const d of days) {
    const iso = formatISO(d, { representation: 'date' });
    if (isRangeAvailable(iso, nights)) {
      out.push({ from: iso, nights });
      if (out.length >= max) break;
    }
  }
  return out;
}
