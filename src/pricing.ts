// src/pricing.ts
//
// Live pricing via Bookalet widget API.
// Endpoint: https://widgets.bookalet.co.uk/api/bookable
// Defaults: adults=4, children=2, infants=0, dogs=0

import { addDays, eachDayOfInterval, parseISO } from 'date-fns';

export type QuoteInput = { from: string; nights: number; dogs?: number };
export type Quote = {
  currency: 'GBP';
  from: string;
  nights: number;
  dogs: number;
  lineItems: Array<{ label: string; amount: number }>;
  subtotal: number;
  tax: number;
  total: number;
  nightly: Array<{ date: string; rate: number }>;
  notes?: string;
};

const BOOKALET_BASE = 'https://widgets.bookalet.co.uk/api/bookable';
const OWNER = '17103';
const PROPERTY = '42069';
const DEFAULT_UNITS_REQUIRED = '1';
const DEFAULT_ADULTS = '4';
const DEFAULT_CHILDREN = '2';
const DEFAULT_INFANTS = '0';

type BookaletRow = {
  Days: number;
  Currency: string;  // "£"
  Cost: number;      // e.g. 980.00
  Discount: number;  // e.g. 0.00 or value for shorter stays
};

const CACHE = new Map<string, { when: number; data: BookaletRow[] }>();
const CACHE_TTL_MS = 60 * 1000;

function round2(n: number) { return Math.round(n * 100) / 100; }
function yyyyMmDd(d: Date) { return d.toISOString().slice(0, 10); }

function buildUrl(dateISO: string, nights: number) {
  const params = new URLSearchParams({
    owner: OWNER,
    property: PROPERTY,
    UnitsRequired: DEFAULT_UNITS_REQUIRED,
    date: dateISO,
    nights: String(nights),
    adults: DEFAULT_ADULTS,
    children: DEFAULT_CHILDREN,
    infants: DEFAULT_INFANTS,
    exchange: ''
  });
  return `${BOOKALET_BASE}?${params.toString()}`;
}

async function fetchBookalet(dateISO: string, nights: number): Promise<BookaletRow[]> {
  const key = `${dateISO}|${nights}`;
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && (now - hit.when) < CACHE_TTL_MS) return hit.data;

  const res = await fetch(buildUrl(dateISO, nights));
  if (!res.ok) throw new Error(`bookalet ${res.status}`);
  const data = await res.json() as BookaletRow[];
  CACHE.set(key, { when: now, data });
  return data;
}

function chooseRow(rows: BookaletRow[], nights: number): BookaletRow | null {
  const exact = rows.find(r => r.Days === nights);
  if (exact) return exact;
  const sorted = [...rows].sort((a, b) => a.Days - b.Days);
  const higher = sorted.find(r => r.Days > nights);
  return higher ?? sorted[sorted.length - 1] ?? null;
}

export async function quoteForStay(input: QuoteInput): Promise<Quote> {
  const nights = Math.max(1, Math.min(30, input.nights));
  const dateISO = input.from;
  const dogs = 0; // per your request

  let total = 0;
  let currency = '£';

  try {
    const rows = await fetchBookalet(dateISO, nights);
    const row = chooseRow(rows, nights);
    if (row) {
      currency = row.Currency || '£';
      total = Math.max(0, (row.Cost || 0) - (row.Discount || 0));
    }
  } catch (e) {
    console.warn('[pricing] Bookalet fetch failed:', (e as any)?.message || e);
  }

  const start = parseISO(dateISO);
  const days = eachDayOfInterval({ start, end: addDays(start, nights - 1) });
  const perNight = nights > 0 ? round2(total / nights) : 0;
  const nightly = days.map(d => ({ date: yyyyMmDd(d), rate: perNight }));

  const subtotal = round2(total);
  const tax = 0;
  const grand = round2(subtotal + tax);

  return {
    currency: 'GBP',
    from: input.from,
    nights,
    dogs,
    lineItems: [{ label: `Bookalet total (${nights} night${nights>1?'s':''})`, amount: subtotal }],
    subtotal,
    tax,
    total: grand,
    nightly,
    notes: `Live quote from Bookalet · owner=${OWNER} property=${PROPERTY} · defaults: adults=4 children=2 infants=0 dogs=0`
  };
}
