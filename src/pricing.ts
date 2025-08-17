// src/pricing.ts
//
// Bookalet-backed pricing.
// Returns price ONLY if Bookalet confirms the exact length (Days === nights).
// Defaults: 4 adults, 2 children, 0 infants, 0 dogs (dogs not priced here).

type QuoteInput = {
  from: string;         // YYYY-MM-DD
  nights: number;
  adults?: number;
  children?: number;
  infants?: number;
  dogs?: number;        // ignored by Bookalet API; kept for interface compatibility
};

export type QuoteResult = {
  currency: 'GBP';
  total: number;            // 0 means not priceable for that start/length
  matchedNights: boolean;   // true only when Days === nights was found
};

const BOOKALET_OWNER = process.env.BOOKALET_OWNER || '17103';
const BOOKALET_PROPERTY = process.env.BOOKALET_PROPERTY || '42069';

export async function quoteForStay(input: QuoteInput): Promise<QuoteResult> {
  const {
    from,
    nights,
    adults = 4,
    children = 2,
    infants = 0,
  } = input;

  const u = new URL('https://widgets.bookalet.co.uk/api/bookable');
  u.searchParams.set('owner', BOOKALET_OWNER);
  u.searchParams.set('property', BOOKALET_PROPERTY);
  u.searchParams.set('UnitsRequired', '1');
  u.searchParams.set('date', from);
  u.searchParams.set('nights', String(nights));
  u.searchParams.set('adults', String(adults));
  u.searchParams.set('children', String(children));
  u.searchParams.set('infants', String(infants));
  u.searchParams.set('exchange', '');

  try {
    const resp = await fetch(u.toString(), { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return { currency: 'GBP', total: 0, matchedNights: false };
    const data = await resp.json();

    const row = Array.isArray(data)
      ? data.find((r: any) => Number(r?.Days) === nights)
      : null;

    if (!row) return { currency: 'GBP', total: 0, matchedNights: false };

    const cost = Number(row.Cost ?? 0);
    const disc = Number(row.Discount ?? 0);
    const total = Math.max(0, cost - disc);

    if (!isFinite(total) || total <= 0) {
      return { currency: 'GBP', total: 0, matchedNights: false };
    }

    return { currency: 'GBP', total, matchedNights: true };
  } catch {
    return { currency: 'GBP', total: 0, matchedNights: false };
  }
}
