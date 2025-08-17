// src/nlp.ts
import type { z } from 'zod';

export type DatesIntent = { kind: 'dates'; from: string; nights: number; year: number; month: number };
export type MonthIntent = { kind: 'month'; year: number; month: number; nights: number };
export type UnknownIntent = { kind: 'unknown' };
export type Intent = DatesIntent | MonthIntent | UnknownIntent;

function toMonthYearGuess(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

export async function interpretMessageWithLLM(message: string): Promise<Intent> {
  const apiKey = process.env.OPENAI_API_KEY;
  // Heuristic first: ISO date and "for N nights"
  const date = message.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  const nightsStr = message.toLowerCase().match(/\bfor\s+(\d{1,2})\s+nights?\b/)?.[1] ||
                    message.toLowerCase().match(/\b(\d{1,2})\s+nights?\b/)?.[1];
  if (date) {
    const nights = nightsStr ? Math.max(1, Math.min(30, parseInt(nightsStr, 10))) : 7;
    const d = new Date(date + 'T00:00:00Z');
    return { kind: 'dates', from: date, nights, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  }

  if (!apiKey) return { kind: 'unknown' };

  const system = `Extract intent:
- If user asks about a specific start date and length, return JSON: {"kind":"dates","from":"YYYY-MM-DD","nights":N,"year":YYYY,"month":M}
- If user asks about availability in a month, return JSON: {"kind":"month","year":YYYY,"month":M,"nights":N}
- Otherwise: {"kind":"unknown"}

Rules:
- If nights unspecified, default to 7.
- Recognize “a week” as 7 nights, “long weekend” as 3 nights.
- Months may omit year; assume this year or next if past.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message }
      ]
    })
  });

  if (!res.ok) return { kind: 'unknown' };
  const data: any = await res.json();
  const txt = String(data.choices?.[0]?.message?.content || '').trim();
  try {
    const obj = JSON.parse(txt);
    if (obj && obj.kind === 'dates' && obj.from && obj.nights) return obj;
    if (obj && obj.kind === 'month' && obj.month) return obj;
  } catch { /* ignore */ }

  return { kind: 'unknown' };
}
