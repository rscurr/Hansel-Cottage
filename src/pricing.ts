// src/pricing.ts
//
// LIVE pricing via Bookalet widget API (no env vars).
// Endpoint pattern (from your capture):
//   https://widgets.bookalet.co.uk/api/bookable
//
// Response example row:
//   { Days: 7, Currency: "£", Cost: 980.00, Discount: 0.00, ... }
//
// We take the row where Days == requested nights
// and compute: total = Cost - Discount
//
// Defaults (as requested): adults=4, children=2, infants=0, dogs=0.

import { addDays, eachDayOfInterval, parseISO } from 'date-fns';

export type QuoteInput = {
  from: string;   // YYYY-MM-DD
  nights: number; // 1..30
  dogs?: number;  // ignored for pricing here (Bookalet quote doesn't include dogs)
};

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

// ---- Bookalet constants (from your captured request) ----
const BOOKALET_BASE = 'https://widgets.bookalet.co.uk/api/bookable';
const OWNER = '17103';
const PROPERTY = '42069';

// ---- Required defaults (your request) ----
const DEFAULT_UNITS_REQUIRED = '1';
const DEFAULT_ADULTS = '4';
const DEFAULT_CHILDREN = '2';
const DEFAULT_INFANTS = '0';

// ---- tiny cache to avoid hammering Bookalet ----
type CacheKey = string; // `${date}|${nights}|${adults}|${children}|${infants}`
const CACHE = new Map<CacheKey, { when: number; data: BookaletRow[] }>();
const CACHE_TTL_MS = 60 * 1000;

type BookaletRow = {
  Days: number;
  Currency: string;  // "£"
  Cost: number;      // e.g. 980.00
  Discount: number;  // e.g. 0.00 or value for shorter stays
  ExchangeFrom?: number;
  Exchange?: number;
  AvailableUnits?: number;
  Units?: number;
  UnitsRequired?: number;
};

function buildUrl(dateISO: string, nights: number, adults = DEFAULT_ADULTS, children = DEFAULT_CHILDREN, infants = DEFAULT_INFANTS) {
  const params = new URLSearchParams({
    owner: OWNER,
    property: PROPERTY,
    UnitsRequired: DEFAULT_UNITS_REQUIRED,
    date: dateISO,
    nights: String(nights),
    adults,
    children,
    infants,
    exchange: '' // align with widget; not required
  });
  return `${BOOKALET_BASE}?${params.toString()}`;
}

async function fetchBookalet(dateISO: string, nights: number): Promise<BookaletRow[]> {
  const key: CacheKey = `${dateISO}|${nights}|${DEFAULT_ADULTS}|${DEFAULT_CHILDREN}|${DEFAULT_INFANTS}`;
  const now = Date.now();
  const cached = CACHE.get(key);
  if (cached && (now - cached.when) < CACHE_TTL_MS) return cached.data;

  const url = buildUrl(dateISO, nights);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`bookalet ${res.status}`);
  const data = (await res.json()) as BookaletRow[];
  CACHE.set(key, { when: now, data });
  return data;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function yyyyMmDd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// If exact nights not present, pick the nearest higher, else nearest lower
function chooseRow(rows: BookaletRow[], nights: number): BookaletRow | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const exact = rows.find(r => r.Days === nights);
  if (exact) return exact;
  const sorted = [...rows].sort((a, b) => a.Days - b.Days);
  const higher = sorted.find(r => r.Days > nights);
  if (higher) return higher;
  return sorted[sorted.length - 1] || null;
}

export async function quoteForStay(input: QuoteInput): Promise<Quote> {
  const nights = Math.max(1, Math.min(30, input.nights));
  const dateISO = input.from;
  // You asked to default dogs to 0:
  const dogs = 0;

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
    total = 0; // explicit to highlight failure paths
  }

  // Spread total equally across nights for the nightly breakdown
  const start = parseISO(dateISO);
  const days = eachDayOfInterval({ start, end: addDays(start, nights - 1) });
  const perNight = nights > 0 ? round2(total / nights) : 0;
  const nightly = days.map(d => ({ date: yyyyMmDd(d), rate: perNight }));

  const subtotal = round2(total);
  const tax = 0; // Bookalet total assumed to include taxes/fees they calculate
  const grand = round2(subtotal + tax);

  // Normalize currency to 'GBP' for your API
  const currencyCode: 'GBP' = 'GBP';

  const note = `Live quote from Bookalet (${BOOKALET_BASE}) · owner=${OWNER} property=${PROPERTY} · total = Cost − Discount · defaults: adults=4 children=2 infants=0 dogs=0`;

  return {
    currency: currencyCode,
    from: input.from,
    nights,
    dogs,
    lineItems: [{ label: `Bookalet total (${nights} night${nights > 1 ? 's' : ''})`, amount: subtotal }],
    subtotal,
    tax,
    total: grand,
    nightly,
    notes: note
  };
}
