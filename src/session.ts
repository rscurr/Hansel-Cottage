// src/session.ts
import type express from 'express';

export type PendingNearbyMonths = {
  kind: 'ask-nearby-months';
  year: number;
  month: number; // 1-12
  nights: number;
};

export type PendingDatePick = {
  kind: 'awaiting-date-pick';
  nights: number; // nights the options were listed for
};

export type SessionMem = {
  updatedAt: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  pending?: PendingNearbyMonths | PendingDatePick;
  prefs?: {
    lastRequestedNights?: number; // remember latest nights the guest asked for
  };
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
    s = { updatedAt: now, messages: [], prefs: {} };
    SESSIONS.set(key, s);
  } else {
    s.updatedAt = now;
  }
  return s;
}

export function pushMessage(s: SessionMem, role: 'user' | 'assistant', content: string, maxTurns = 16) {
  s.messages.push({ role, content });
  const maxMsgs = Math.max(4, maxTurns * 2);
  if (s.messages.length > maxMsgs) {
    s.messages.splice(0, s.messages.length - maxMsgs);
  }
}

export function getRecentMessages(s: SessionMem, n = 10) {
  return s.messages.slice(-Math.max(1, n));
}
