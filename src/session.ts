// src/session.ts
import type express from 'express';

export type PendingNearbyMonths = {
  kind: 'ask-nearby-months';
  year: number;
  month: number; // 1-12
  nights: number;
};

export type SessionMem = {
  updatedAt: number;
  pending?: PendingNearbyMonths;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
};

const SESSIONS = new Map<string, SessionMem>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function initSessionSweeper() {
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of SESSIONS) {
      if (now - v.updatedAt > SESSION_TTL_MS) SESSIONS.delete(k);
    }
  }, 60 * 1000);
}

// If you're behind a proxy (Render), set in index.ts: app.set('trust proxy', 1)
export function getSessionKey(req: express.Request): string {
  const hdr = (req.headers['x-session-id'] || '') as string;
  if (hdr) return `hdr:${hdr}`;
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'ip?';
  const ua = (req.headers['user-agent'] as string) || 'ua?';
  return `ipua:${ip}::${ua}`;
}

export function getSession(req: express.Request): SessionMem {
  const key = getSessionKey(req);
  let s = SESSIONS.get(key);
  const now = Date.now();
  if (!s) {
    s = { updatedAt: now, messages: [] };
    SESSIONS.set(key, s);
  } else {
    s.updatedAt = now;
  }
  return s;
}

// Keep last N messages (both user + assistant)
export function pushMessage(s: SessionMem, role: 'user' | 'assistant', content: string, maxTurns = 16) {
  s.messages.push({ role, content });
  // Cap conversation length (turns ≈ pairs; here we cap at ~16*2 messages)
  const maxMsgs = Math.max(4, maxTurns * 2);
  if (s.messages.length > maxMsgs) {
    s.messages.splice(0, s.messages.length - maxMsgs);
  }
}

// Returns a shallow copy of the last N messages for prompts
export function getRecentMessages(s: SessionMem, n = 10) {
  return s.messages.slice(-Math.max(1, n));
}
