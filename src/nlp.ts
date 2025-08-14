// Natural-language booking intent parser (no external deps).
// Tries deterministic parsing first; if OPENAI_API_KEY is present we could extend with LLM later.

type Intent =
  | { kind: 'dates'; from: string; nights: number; dogs: number }
  | { kind: 'none' };

const DOW: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6
};
const MON: Record<string, number> = {
  jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,
  jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,sept:8,september:8,
  oct:9,october:9,nov:10,november:10,dec:11,december:11
};

function today(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()); // local midnight
}
function inDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}
function z(n: number) { return n < 10 ? `0${n}` : String(n); }
function toISO(d: Date) { return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; }
function nextDow(base: Date, dow: number): Date {
  const diff = (7 - ((base.getDay() - dow + 7) % 7)) % 7 || 7;
  return inDays(base, diff);
}
function thisDow(base: Date, dow: number): Date {
  let cand = inDays(base, (dow - base.getDay() + 7) % 7);
  if (cand < base) cand = inDays(cand, 7);
  return cand;
}

export function interpretMessage(raw: string): Intent {
  const txt = raw.toLowerCase().trim();
  const base = today();

  // Dogs
  const dogsMatch = txt.match(/(?:with|and)\s+(\d+)\s+dogs?\b/);
  const dogs = dogsMatch ? Math.max(0, parseInt(dogsMatch[1], 10)) : 0;

  // Nights
  let nights: number | null = null;
  if (/\bfor (a |one )?week\b/.test(txt)) nights = 7;
  const nMatch = txt.match(/(?:for\s+)?(\d+)\s+nights?\b/);
  if (nMatch) nights = parseInt(nMatch[1], 10);

  // Start date
  let fromISO: string | null = null;

  // ISO date like 2025-11-23
  const iso = txt.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) fromISO = iso[1];

  // “next Tuesday”
  if (!fromISO) {
    const nd = txt.match(/\bnext\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (nd && DOW[nd[1]] !== undefined) fromISO = toISO(nextDow(base, DOW[nd[1]]));
  }

  // “this Tuesday”
  if (!fromISO) {
    const td = txt.match(/\bthis\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (td && DOW[td[1]] !== undefined) fromISO = toISO(thisDow(base, DOW[td[1]]));
  }

  // “in 2 weeks/days”
  if (!fromISO) {
    const ind = txt.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/);
    if (ind) {
      const count = parseInt(ind[1], 10);
      const mult = /week/.test(ind[2]) ? 7 : 1;
      fromISO = toISO(inDays(base, count * mult));
    }
  }

  // “23 Nov”
  if (!fromISO) {
    const md = txt.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/);
    if (md) {
      const day = parseInt(md[1], 10);
      const mo = MON[md[2]];
      if (mo != null) {
        let year = base.getFullYear();
        let cand = new Date(year, mo, day);
        if (cand < base) cand = new Date(year + 1, mo, day);
        fromISO = toISO(cand);
      }
    }
  }

  // “this weekend” => Friday + 2 nights
  if (!fromISO && /\bthis weekend\b/.test(txt)) {
    const fri = thisDow(base, 5);
    fromISO = toISO(fri);
    if (nights == null) nights = 2;
  }

  // Ranges: “from Monday to Friday” OR “from 19th until Sunday”
  const range = txt.match(/\bfrom\s+([\w-]+)\s+(?:to|until)\s+([\w-]+)\b/);
  if (range) {
    // start token
    let startISO: string | null = null;
    const sTok = range[1];
    if (DOW[sTok] != null) startISO = toISO(thisDow(base, DOW[sTok]));
    if (!startISO) {
      const sIso = sTok.match(/^\d{4}-\d{2}-\d{2}$/);
      if (sIso) startISO = sIso[0];
    }
    if (!startISO) {
      const sMd = sTok.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
      if (sMd) {
        const day = parseInt(sMd[1], 10);
        let cand = new Date(base.getFullYear(), base.getMonth(), day);
        if (cand < base) cand = new Date(base.getFullYear(), base.getMonth() + 1, day);
        startISO = toISO(cand);
      }
    }

    // end token
    let endDate: Date | null = null;
    const eTok = range[2];
    if (DOW[eTok] != null) {
      const start = startISO ? new Date(startISO) : base;
      endDate = thisDow(start, DOW[eTok]);
      if (endDate <= start) endDate = inDays(endDate, 7);
    }
    const eIso = eTok.match(/^\d{4}-\d{2}-\d{2}$/);
    if (!endDate && eIso) endDate = new Date(eIso[0]);

    if (startISO && endDate) {
      const start = new Date(startISO);
      const diffDays = Math.max(1, Math.round((endDate.getTime() - start.getTime()) / 86_400_000));
      fromISO = toISO(start);
      nights = nights ?? diffDays;
    }
  }

  if (fromISO && nights != null && nights > 0) {
    return { kind: 'dates', from: fromISO, nights, dogs };
  }
  return { kind: 'none' };
}
