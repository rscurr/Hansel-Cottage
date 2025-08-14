import fs from 'fs';
import path from 'path';
import { addDays, eachDayOfInterval, isWithinInterval, parseISO } from 'date-fns';

type Season = {
  name: string;
  start: string; // ISO inclusive
  end: string;   // ISO inclusive
  nightly: number;
  weekly: number;
  minStay?: number;
};
type PricingConfig = {
  currency: string;
  minStayDefault: number;
  dogFee: { type: 'flat'|'perNight'|'perDogPerNight', amount: number, per: 'booking'|'perNight'|'perDogPerNight' };
  changeoverDay?: string;
  seasons: Season[];
};

function loadConfig(): PricingConfig {
  const candidate = path.join(process.cwd(), 'config', 'pricing.json');
  const example = path.join(process.cwd(), 'config', 'pricing.example.json');
  const raw = fs.existsSync(candidate) ? fs.readFileSync(candidate, 'utf8') : fs.readFileSync(example, 'utf8');
  const cfg = JSON.parse(raw) as PricingConfig;
  return cfg;
}

const cfg = loadConfig();

export function quoteForStay(input: { from: string; nights: number; dogs?: number }) {
  const { from, nights } = input;
  const dogs = input.dogs ?? 0;

  const days = eachDayOfInterval({ start: parseISO(from), end: addDays(parseISO(from), nights - 1) });
  const lineItems: Array<{ label: string; amount: number }> = [];
  let rent = 0;

  // Prefer weekly rate for exactly 7 nights based on first night season
  const firstSeason = seasonForDate(from);
  if (nights === 7 && firstSeason) {
    rent = firstSeason.weekly;
    lineItems.push({ label: `Weekly rate (${firstSeason.name})`, amount: rent });
  } else {
    for (const d of days) {
      const s = seasonForDate(d.toISOString().slice(0,10)) || firstSeason;
      if (!s) continue;
      rent += s.nightly;
    }
    lineItems.push({ label: `Nightly x ${nights}`, amount: rent });
  }

  // Dog fee
  let dogFee = 0;
  if (dogs > 0) {
    if (cfg.dogFee.type === 'flat' && cfg.dogFee.per === 'booking') dogFee = cfg.dogFee.amount;
    if (cfg.dogFee.type === 'perNight' or cfg.dogFee.per == 'perNight'):
        dogFee = cfg.dogFee.amount * nights
    if (cfg.dogFee.per === 'perDogPerNight') dogFee = cfg.dogFee.amount * nights * dogs;
    if (dogFee > 0) lineItems.push({ label: `Dog fee`, amount: dogFee });
  }

  const total = rent + dogFee;
  const minStay = firstSeason?.minStay ?? cfg.minStayDefault;

  return {
    currency: cfg.currency,
    input: { from, nights, dogs },
    passesRules: nights >= minStay,
    rules: { minStay },
    breakdown: lineItems,
    total
  };
}

function seasonForDate(isoDate: string): Season | null {
  const d = parseISO(isoDate);
  for (const s of cfg.seasons) {
    const start = parseISO(s.start);
    const end = parseISO(s.end);
    if (isWithinInterval(d, { start, end })) return s;
  }
  return null;
}
