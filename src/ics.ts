import * as ical from 'node-ical';
import { addDays, parseISO } from 'date-fns';

type Booking = { start: Date; end: Date };
let bookings: Booking[] = [];
let lastRefresh = 0;

const ICS_URL = process.env.ICS_URL || '';
const REFRESH_INTERVAL_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES || '60');
const CHANGEOVER_DAY = (process.env.CHANGEOVER_DAY || '').trim(); // e.g., 'Friday'
const MIN_STAY_DEFAULT = Number(process.env.MIN_STAY_DEFAULT || '2');

function normalize(b: Booking): Booking {
  return { start: new Date(b.start), end: new Date(b.end) };
}

export async function refreshIcs(force = false) {
  const now = Date.now();
  const due = now - lastRefresh > REFRESH_INTERVAL_MINUTES * 60_000;
  if (!force && !due) return;
  if (!ICS_URL) {
    console.warn('ICS_URL not set; availability will always be true.');
    bookings = [];
    lastRefresh = now;
    return;
  }
  const res = await fetch(ICS_URL);
  if (!res.ok) throw new Error(`ICS fetch failed: ${res.status}`);
  const text = await res.text();
  const data = ical.sync.parseICS(text);
  const next: Booking[] = [];
  for (const k of Object.keys(data)) {
    const e: any = (data as any)[k];
    if (e.type === 'VEVENT' && e.start && e.end) {
      next.push(normalize({ start: new Date(e.start), end: new Date(e.end) }));
    }
  }
  next.sort((a, b) => a.start.getTime() - b.start.getTime());
  bookings = next;
  lastRefresh = now;
  console.log(`ICS refreshed: ${bookings.length} bookings`);
}

export function getIcsStats() {
  return { bookings: bookings.length, lastRefresh };
}

export function isRangeAvailable(fromISO: string, nights: number): boolean {
  const start = parseISO(fromISO);
  const end = addDays(start, nights);

  // Optional changeover rule
  if (CHANGEOVER_DAY) {
    const day = start.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/London' });
    if (day !== CHANGEOVER_DAY) return false;
  }
  // Min stay
  if (nights < MIN_STAY_DEFAULT) return false;

  for (const b of bookings) {
    if (start < b.end && end > b.start) return false; // overlap
  }
  return true;
}

export function suggestAlternatives(fromISO: string, nights: number, windowDays = 21) {
  const start = parseISO(fromISO);
  const alts: Array<{ from: string; nights: number }> = [];
  for (let delta = 1; delta <= windowDays; delta++) {
    for (const sign of [-1, 1]) {
      const candidate = new Date(start.getTime() + sign * delta * 86400000);
      const iso = candidate.toISOString().slice(0,10);
      if (isRangeAvailable(iso, nights)) alts.push({ from: iso, nights });
      if (alts.length >= 6) return alts;
    }
  }
  return alts;
}
