// EMPIRE://36 backend (PRD §7): username+password auth, server-side saves,
// run recording, leaderboard stub. Hono + better-sqlite3 + argon2id.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { openDb } from './db';

const PORT = Number(process.env.PORT ?? 8136);
const DB_PATH = process.env.EMPIRE_DB ?? 'empire.db';
const SESSION_DAYS = 30;
const MAX_BLOB = 2 * 1024 * 1024; // PRD: save blob < 2MB gzipped
const SLOTS = 3;

const db = openDb(DB_PATH);
const app = new Hono();

// --- rate limiting (auth endpoints only) --------------------------------------
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, limit = 12, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}

function clientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

// --- session helpers -----------------------------------------------------------
interface SessionRow { token: string; user_id: number; expires_at: number }

function createSession(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 86_400_000);
  return token;
}

function userFromRequest(c: Context): number | null {
  const token = getCookie(c, 'session');
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as SessionRow | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return row.user_id;
}

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, 'session', token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86_400,
    path: '/',
  });
}

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

// --- auth ------------------------------------------------------------------------
app.post('/api/register', async (c) => {
  if (!rateLimit(clientIp(c), 6)) return c.json({ error: 'slow down' }, 429);
  const body = await c.req.json().catch(() => null);
  const username = String(body?.username ?? '').toLowerCase();
  const password = String(body?.password ?? '');
  if (!USERNAME_RE.test(username)) {
    return c.json({ error: 'username: 3-24 chars, a-z 0-9 _ only' }, 400);
  }
  if (password.length < 8) return c.json({ error: 'password: 8 chars minimum' }, 400);
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return c.json({ error: 'username taken' }, 409);
  const pwhash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const info = db.prepare('INSERT INTO users (username, pwhash, created_at) VALUES (?, ?, ?)')
    .run(username, pwhash, Date.now());
  setSessionCookie(c, createSession(Number(info.lastInsertRowid)));
  return c.json({ username }, 201);
});

app.post('/api/login', async (c) => {
  if (!rateLimit(clientIp(c), 10)) return c.json({ error: 'slow down' }, 429);
  const body = await c.req.json().catch(() => null);
  const username = String(body?.username ?? '').toLowerCase();
  const password = String(body?.password ?? '');
  const row = db.prepare('SELECT id, pwhash FROM users WHERE username = ?').get(username) as
    | { id: number; pwhash: string } | undefined;
  if (!row || !(await verify(row.pwhash, password))) {
    return c.json({ error: 'no such login' }, 401);
  }
  setSessionCookie(c, createSession(row.id));
  return c.json({ username });
});

app.post('/api/logout', (c) => {
  const token = getCookie(c, 'session');
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  deleteCookie(c, 'session', { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', (c) => {
  const uid = userFromRequest(c);
  if (!uid) return c.json({ user: null });
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(uid) as { username: string };
  return c.json({ user: row.username });
});

// --- saves ------------------------------------------------------------------------
app.get('/api/saves', (c) => {
  const uid = userFromRequest(c);
  if (!uid) return c.json({ error: 'login required' }, 401);
  const rows = db.prepare(
    'SELECT slot, version, char_name, networth, alive, updated_at FROM saves WHERE user_id = ? ORDER BY slot',
  ).all(uid);
  return c.json({ saves: rows });
});

app.get('/api/saves/:slot', (c) => {
  const uid = userFromRequest(c);
  if (!uid) return c.json({ error: 'login required' }, 401);
  const slot = Number(c.req.param('slot'));
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) return c.json({ error: 'bad slot' }, 400);
  const row = db.prepare('SELECT blob FROM saves WHERE user_id = ? AND slot = ?').get(uid, slot) as
    | { blob: Buffer } | undefined;
  if (!row) return c.json({ error: 'empty slot' }, 404);
  return c.body(new Uint8Array(row.blob), 200, { 'Content-Type': 'application/octet-stream' });
});

app.put('/api/saves/:slot', async (c) => {
  const uid = userFromRequest(c);
  if (!uid) return c.json({ error: 'login required' }, 401);
  const slot = Number(c.req.param('slot'));
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) return c.json({ error: 'bad slot' }, 400);
  const blob = Buffer.from(await c.req.arrayBuffer());
  if (blob.length === 0 || blob.length > MAX_BLOB) return c.json({ error: 'blob size' }, 413);
  const meta = {
    version: Number(c.req.header('x-save-version') ?? 1),
    charName: (c.req.header('x-save-char') ?? '').slice(0, 64),
    networth: Number(c.req.header('x-save-networth') ?? 0) | 0,
    alive: c.req.header('x-save-alive') === '0' ? 0 : 1,
  };
  db.prepare(`
    INSERT INTO saves (user_id, slot, version, char_name, networth, alive, blob, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, slot) DO UPDATE SET
      version = excluded.version, char_name = excluded.char_name,
      networth = excluded.networth, alive = excluded.alive,
      blob = excluded.blob, updated_at = excluded.updated_at
  `).run(uid, slot, meta.version, meta.charName, meta.networth, meta.alive, blob, Date.now());
  return c.body(null, 204);
});

// --- runs (the future leaderboard's raw material) -----------------------------------
app.post('/api/runs', async (c) => {
  const uid = userFromRequest(c);
  if (!uid) return c.json({ error: 'login required' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad body' }, 400);
  db.prepare(`
    INSERT INTO runs (user_id, seed, char_name, networth, cause_of_death, turns, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uid,
    String(body.seed ?? '').slice(0, 64),
    String(body.char_name ?? '').slice(0, 64),
    Number(body.networth ?? 0) | 0,
    String(body.cause ?? '').slice(0, 256),
    Number(body.turns ?? 0) | 0,
    Number(body.started_at ?? Date.now()),
    Date.now(),
  );
  return c.json({ ok: true }, 201);
});

app.get('/api/leaderboard', (c) =>
  c.json({ error: 'leaderboard ships after v1; runs are being recorded' }, 501));

// --- static client (production) ------------------------------------------------------
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`EMPIRE://36 server on :${info.port} (db: ${DB_PATH})`);
});
