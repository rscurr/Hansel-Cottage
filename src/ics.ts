// src/ics.ts
import ical from 'node-ical';
import { addDays, isBefore, isAfter, parseISO, startOfMonth, endOfMonth } from 'date-fns';

type Booking = { start: string; end: string; summary?: string };

let bookings: Booking[] = [];
let lastRefresh: string | null = null;

const ICS_URL = process.env.ICS_URL || ''; // e.g., "https://example.com/calendar.ics"

export function getIcsStats() {
  return { count: bookings.length, lastRefresh, hasUrl: !!ICS_URL };
}

export async function refreshIcs(force = false) {
  if (!ICS_URL) {
    console.warn('[ics] No ICS_URL set; skipping refresh.');
    return;
  }
  try {
    let data: Record<string, any> | null = null;

    // Preferred: built-in fetcher (when available)
    try {
      // @ts-ignore - .async may not be typed
      if (ical?.async?.fromURL) {
        // @ts-ignore
        data = await ical.async.fromURL(ICS_URL);
      }
    } catch (e) {
      console.warn('[ics] async.fromURL failed, will fetch manually:', (e as any)?.message || e);
    }

    // Fallback: fetch text, then parse
    if (!data) {
      const res = await fetch(ICS_URL);
      if (!res.ok) throw new Error(`ICS fetch failed: ${res.status} ${res.statusText}`);
      const text = await res.text();
      // node-ical exposes parseICS synchronously on default export
      // @ts-ignore
      data = ical.parseICS(text);
    }

    const out: Booking[] = [];
    for (const k of Object.keys(data)) {
      const ev = (data as any)[k];
      if (!ev || ev.type !== 'VEVENT') continue;
      if (!ev.start || !ev.end) continue;
      const startISO = toIso(ev.start);
      const endISO = toIso(ev.end);
      out.push({ start: startISO, end: endISO, summary: ev.summary });
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    bookings = out;
    lastRefresh = new Date().toISOString();
    console.log('[ics] refreshed', bookings.length, 'events');
  } catch (e) {
    console.error('[ics] refresh failed:', e);
    if (!force) throw e;
  }
}

function toIso(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

export function isRangeAvailable(fromISO: string, nights: number): boolean {
  const start = parseISO(fromISO);
  const end = addDays(start, nights);

  for (const b of bookings) {
    const bStart = parseISO(b.start);
    const bEnd = parseISO(b.end);
    // Overlap if start < bEnd AND end > bStart
    const overlaps = isBefore(start, bEnd) && isAfter(end, bStart);
    if (overlaps) return false;
  }
  return true;
}

export function suggestAlternatives(fromISO: string, nights: number, max = 10) {
  const suggestions: Array<{ from: string; nights: number }> = [];
  const start = parseISO(fromISO);

  // Try the next 60 days for an open stretch
  for (let i = 1; i <= 60 && suggestions.length < max; i++) {
    const candStart = addDays(start, i);
    const candISO = toIso(candStart as any);
    if (isRangeAvailable(candISO, nights)) {
      suggestions.push({ from: candISO, nights });
    }
  }
  return suggestions;
}

/**
 * Find all available start dates between rangeStartISO and rangeEndISO (inclusive) that fit `nights`.
 * Scans day-by-day and returns up to `max` options.
 */
export function findAvailabilityInRange(rangeStartISO: string, rangeEndISO: string, nights: number, max = 20) {
  const out: Array<{ from: string; nights: number }> = [];
  let d = parseISO(rangeStartISO);
  const last = parseISO(rangeEndISO);
  // We can start no later than (last - nights)
  while (isBefore(d, addDays(last, 1)) && out.length < max) {
    const iso = toIso(d);
    if (isRangeAvailable(iso, nights)) out.push({ from: iso, nights });
    d = addDays(d, 1);
  }
  return out;
}

/**
 * Convenience: find availability within a given month (1-12) of a year for `nights`.
 */
export function findAvailabilityInMonth(year: number, month1to12: number, nights: number, max = 20) {
  const first = startOfMonth(new Date(Date.UTC(year, month1to12 - 1, 1)));
  const last = endOfMonth(first);
  const startISO = toIso(first);
  const endISO = toIso(last);
  return findAvailabilityInRange(startISO, endISO, nights, max);
}
