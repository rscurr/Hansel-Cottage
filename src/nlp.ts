// LLM-only booking intent extraction.
// Returns { kind:'dates', from:'YYYY-MM-DD', nights:number, dogs:number } or { kind:'none' }.

export type Intent =
  | { kind: 'dates'; from: string; nights: number; dogs: number }
  | { kind: 'none' };

function todayLondonISO(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const d = parts.find(p => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

export async function interpretMessageWithLLM(message: string): Promise<Intent> {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return { kind: 'none' };

  const todayISO = todayLondonISO();
  const body = {
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
`You extract booking details for a UK holiday cottage.
Output strict JSON like:
{"from":"YYYY-MM-DD","nights":number,"dogs":number}
Rules:
- Interpret relative dates using Europe/London and today's date: ${todayISO}.
- If a week is mentioned, nights=7.
- If a date range like "from X to/until Y" is given, nights = days between start and end.
- If nights is not stated but a start date exists, assume nights=7.
- Dogs default to 0 if not stated.
- "This weekend" means Friday + 2 nights.
Only output JSON, no extra text.`
      },
      { role: 'user', content: message }
    ]
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status}`);
  const j = await res.json();
  const raw = j.choices?.[0]?.message?.content;
  if (!raw) return { kind: 'none' };

  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.from) &&
      typeof parsed.nights === 'number' && parsed.nights > 0
    ) {
      const nights = Math.min(Math.max(1, Math.round(parsed.nights)), 30);
      const dogs = Math.max(0, Math.min(4, Math.round(parsed.dogs || 0)));
      return { kind: 'dates', from: parsed.from, nights, dogs };
    }
  } catch { /* ignore */ }
  return { kind: 'none' };
}
