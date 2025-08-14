// src/ics.ts
import ical from 'node-ical';
import { addDays, isBefore, isAfter, parseISO } from 'date-fns';

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
    // overlap if start < bEnd AND end > bStart
    if (isBefore(start, bEnd) && isAfter(end, bStart)) return false;
  }
  return true;
}

export function suggestAlternatives(fromISO: string, nights: number, max = 10) {
  const suggestions: Array<{ from: string; nights: number }> = [];
  const base = parseISO(fromISO);
  for (let i = 1; i <= 60 && suggestions.length < max; i++) {
    const cand = addDays(base, i);
    const candISO = cand.toISOString().slice(0, 10);
    if (isRangeAvailable(candISO, nights)) suggestions.push({ from: candISO, nights });
  }
  return suggestions;
}
