// =====================================================================
// dev-api — ตัวจำลอง Supabase API (Auth + REST + Storage) สำหรับ "ทดสอบหน้าจอบนเครื่อง" เท่านั้น
//   * ต่อ Postgres จริง (ผ่าน RLS จริง + RPC จริงจาก supabase/migrations)
//   * ไม่ใช่ Supabase / PostgREST ตัวจริง: รองรับเฉพาะ query ที่แอปนี้ใช้ (select/filter/order/limit, PATCH, rpc)
//   * Realtime: จำลองโปรโตคอล Phoenix v2 เฉพาะ postgres_changes (ผ่าน LISTEN/NOTIFY) และกรองแถวตาม RLS ของผู้ฟังแต่ละคน
//     เพื่อให้ทดสอบ "หน้าจออัปเดตเองโดยไม่รีโหลด" ได้ — ไม่ใช่ Supabase Realtime ตัวจริง (ต้องทดสอบกับของจริงอีกครั้ง)
//   * รหัสผ่านทุกบัญชี = demo1234 ; JWT secret ฝังในโค้ด → ห้ามใช้กับข้อมูลจริง/ห้ามเปิดสู่อินเทอร์เน็ต
// รัน: node tools/dev-api/server.mjs   (ค่าเริ่มต้นพอร์ต 54330, ฐานข้อมูล namchok_demo)
// =====================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 54330);
const DB = process.env.DEMO_DB ?? 'namchok_demo';
const SECRET = 'dev-only-secret-never-use-in-production';
const PASSWORD = 'demo1234';
const FILES = path.resolve(process.env.DEV_FILES ?? path.join(here, '.data/files'));
fs.mkdirSync(FILES, { recursive: true });

const pool = new pg.Pool({
  host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? 'postgres', password: process.env.PGPASSWORD, database: DB, max: 8,
});

// ---------- JWT (HS256) ----------
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (payload) => {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
};
function verify(token) {
  const [h, p, s] = String(token ?? '').split('.');
  if (!h || !p || !s) return null;
  const good = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp && d.exp < Date.now() / 1000 ? null : d;
  } catch { return null; }
}
const bearer = (req) => /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
const userIdOf = (req) => { const d = verify(bearer(req)); return d && d.typ !== 'refresh' && d.role === 'authenticated' ? d.sub : null; };

function session(user) {
  const now = Math.floor(Date.now() / 1000);
  const access = sign({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 });
  const refresh = sign({ sub: user.id, typ: 'refresh', iat: now, exp: now + 86400 * 7 });
  return {
    access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh,
    user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}

// ---------- helpers ----------
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version, accept-profile, content-profile, prefer, x-upsert, cache-control, range',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range',
};
function send(res, status, body, extra = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = body === undefined ? '' : isBuf ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, ...(isBuf ? {} : { 'content-type': 'application/json' }), ...extra });
  res.end(payload);
}
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
});
const readJson = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString()) : {}; };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (id) => { if (!IDENT.test(id)) throw httpErr(400, 'PGRST100', `identifier ไม่ถูกต้อง: ${id}`); return `"${id}"`; };
function httpErr(status, code, message) { const e = new Error(message); e.status = status; e.pgCode = code; return e; }

function sendError(res, e) {
  const code = e.pgCode ?? e.code ?? 'XX000';
  const status = e.status ?? (code === '42501' ? 403 : code === '23505' ? 409 : code === '42883' || code === '42P01' ? 404 : 400);
  send(res, status, { code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
}

async function withUser(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [uid ?? '', JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' })]);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// ---------- PostgREST (เฉพาะส่วนที่แอปใช้) ----------
function splitList(s) { // "a,b,\"c,d\"" -> [a,b,c,d]
  const out = []; let cur = ''; let inQ = false;
  for (const ch of s) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function whereOf(params, args) {
  const clauses = [];
  for (const [k, v] of params.entries()) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
    const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/s.exec(v);
    if (!m) throw httpErr(400, 'PGRST100', `ตัวกรองไม่รองรับ: ${k}=${v}`);
    const [, not, op, val] = m;
    const col = q(k);
    let sql;
    if (op === 'is') sql = `${col} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`;
    else if (op === 'in') { args.push(splitList(val.replace(/^\(|\)$/g, ''))); sql = `${col} = any($${args.length})`; }
    else if (op === 'like' || op === 'ilike') { args.push(val.replace(/\*/g, '%')); sql = `${col}::text ${op} $${args.length}`; }
    else { args.push(val); sql = `${col} ${{ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]} $${args.length}`; }
    clauses.push(not ? `not (${sql})` : sql);
  }
  return clauses.length ? `where ${clauses.join(' and ')}` : '';
}

async function restSelect(req, res, rel, params, uid) {
  const sel = params.get('select') ?? '*';
  if (/[()]/.test(sel)) throw httpErr(400, 'PGRST100', 'dev-api ไม่รองรับการ embed ในพารามิเตอร์ select');
  const cols = sel === '*' ? '*' : splitList(sel).map(q).join(', ');
  const args = [];
  const where = whereOf(params, args);
  const order = params.get('order')
    ? 'order by ' + splitList(params.get('order')).map((o) => { const [c, d] = o.split('.'); return `${q(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ') : '';
  const limit = params.get('limit') ? `limit ${Number(params.get('limit')) | 0}` : '';
  const offset = params.get('offset') ? `offset ${Number(params.get('offset')) | 0}` : '';
  const rows = await withUser(uid, async (c) => (await c.query(
    `select coalesce(json_agg(t), '[]'::json) as j from (select ${cols} from ${q(rel)} ${where} ${order} ${limit} ${offset}) t`, args)).rows[0].j);
  if ((req.headers.accept ?? '').includes('vnd.pgrst.object+json')) {
    if (rows.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null });
    return send(res, 200, rows[0]);
  }
  send(res, 200, rows);
}

async function restPatch(req, res, rel, params, uid) {
  const body = await readJson(req);
  const keys = Object.keys(body);
  if (!keys.length) return send(res, 204);
  const args = keys.map((k) => body[k]);
  const sets = keys.map((k, i) => `${q(k)} = $${i + 1}`).join(', ');
  const where = whereOf(params, args);
  const rows = await withUser(uid, async (c) => (await c.query(`update ${q(rel)} set ${sets} ${where} returning *`, args)).rows);
  if ((req.headers.prefer ?? '').includes('return=representation')) return send(res, 200, rows);
  send(res, 204);
}

async function rpcCall(res, fn, body, uid) {
  const meta = (await pool.query("select proretset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace limit 1", [fn])).rows[0];
  if (!meta) throw httpErr(404, 'PGRST202', `ไม่พบฟังก์ชัน ${fn}`);
  const keys = Object.keys(body ?? {});
  const args = keys.map((k) => { const v = body[k]; return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v; });
  const call = `${q(fn)}(${keys.map((k, i) => `${q(k)} => $${i + 1}`).join(', ')})`;
  const result = await withUser(uid, async (c) => {
    if (meta.proretset) return (await c.query(`select coalesce(json_agg(t), '[]'::json) as j from (select * from ${call}) t`, args)).rows[0].j;
    return (await c.query(`select to_json(${call}) as j`, args)).rows[0].j;
  });
  if (result === null) return send(res, 204);
  send(res, 200, result);
}

// ---------- Storage ----------
const fileOn = (bucket, name) => {
  const p = path.resolve(FILES, bucket, name);
  if (!p.startsWith(path.resolve(FILES, bucket) + path.sep)) throw httpErr(400, 'storage', 'path ไม่ถูกต้อง');
  return p;
};
const token = (bucket, name, exp) => crypto.createHmac('sha256', SECRET).update(`${bucket}/${name}/${exp}`).digest('base64url');
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

async function storageUpload(req, res, bucket, name, uid) {
  const buf = await readBody(req);
  const form = await new Request('http://dev/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: buf }).formData();
  const file = [...form.values()].find((v) => typeof v !== 'string');
  if (!file) throw httpErr(400, 'storage', 'ไม่พบไฟล์ในคำขอ');
  try {
    await withUser(uid, (c) => c.query('insert into storage.objects(bucket_id, name) values ($1, $2)', [bucket, name]));
  } catch (e) {
    if (e.code === '42501' || /row-level security/.test(e.message)) return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    if (e.code === '23505') return send(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
    throw e;
  }
  const dest = fileOn(bucket, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
  send(res, 200, { Key: `${bucket}/${name}`, Id: crypto.randomUUID() });
}

async function storageSign(res, bucket, names, uid, single) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const out = [];
  for (const name of names) {
    const ok = (await withUser(uid, (c) => c.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, name]))).rowCount > 0
      && fs.existsSync(fileOn(bucket, name));
    out.push(ok
      ? { error: null, path: name, signedURL: `/object/sign/${bucket}/${name.split('/').map(encodeURIComponent).join('/')}?token=${exp}.${token(bucket, name, exp)}` }
      : { error: 'Object not found', path: name, signedURL: null });
  }
  if (single) return out[0].signedURL ? send(res, 200, { signedURL: out[0].signedURL }) : send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
  send(res, 200, out);
}

function storageServe(res, bucket, name, tok) {
  const [exp, sig] = String(tok ?? '').split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000 || sig !== token(bucket, name, exp)) return send(res, 401, { message: 'token ไม่ถูกต้องหรือหมดอายุ' });
  const f = fileOn(bucket, name);
  if (!fs.existsSync(f)) return send(res, 404, { message: 'ไม่พบไฟล์' });
  send(res, 200, fs.readFileSync(f), { 'content-type': MIME[path.extname(f).slice(1).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'private, max-age=60' });
}

// ---------- Realtime (จำลอง) ----------
// เหตุการณ์มาจาก trigger ที่ติดตั้งเฉพาะ "ฐานข้อมูลสาธิต" บนตารางที่อยู่ใน publication supabase_realtime (เหมือนของจริงที่ส่งเฉพาะตารางใน publication)
const subs = new Set(); // { ws, topic, uid, filters: [{ id, event, schema, table, filter }] }
let filterSeq = 1000;
const WS_OPEN = 1;

async function installNotify() {
  const tables = (await pool.query("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'")).rows.map((r) => r.tablename);
  await pool.query('create schema if not exists dev');
  await pool.query(`create or replace function dev.notify_change() returns trigger language plpgsql security definer set search_path = pg_catalog as $$
    begin
      perform pg_notify('dev_changes', json_build_object('table', tg_table_name, 'op', tg_op, 'id', coalesce(new.id, old.id))::text);
      return null;
    end $$`);
  for (const t of tables) {
    await pool.query(`drop trigger if exists dev_notify on public.${q(t)}`);
    await pool.query(`create trigger dev_notify after insert or update or delete on public.${q(t)} for each row execute function dev.notify_change()`);
  }
  return tables;
}

const wsSend = (ws, msg) => { if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg)); };
const wsReply = (ws, joinRef, ref, topic, status, response = {}) => wsSend(ws, [joinRef, ref, topic, 'phx_reply', { status, response }]);
const uidOfToken = (t) => { const d = verify(t); return d && d.typ !== 'refresh' && d.role === 'authenticated' ? d.sub : null; };

function onRealtimeConnection(ws) {
  const conn = { token: null, channels: new Map() };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const [joinRef, ref, topic, event, payload] = m;
    if (topic === 'phoenix' && event === 'heartbeat') return wsReply(ws, null, ref, 'phoenix', 'ok');
    if (event === 'phx_join') {
      const cfg = payload?.config ?? {};
      const filters = (cfg.postgres_changes ?? []).map((f) => ({ id: ++filterSeq, event: f.event, schema: f.schema, table: f.table, filter: f.filter }));
      if (payload?.access_token) conn.token = payload.access_token;
      const sub = { ws, topic, uid: uidOfToken(conn.token), filters, conn };
      const old = conn.channels.get(topic);
      if (old) subs.delete(old);
      conn.channels.set(topic, sub); subs.add(sub);
      wsReply(ws, joinRef, ref, topic, 'ok', { postgres_changes: filters.map(({ id, event: ev, schema, table, filter }) => ({ id, event: ev, schema, table, ...(filter ? { filter } : {}) })) });
      if (filters.length) wsSend(ws, [joinRef, null, topic, 'system', { message: 'Subscribed to PostgreSQL', status: 'ok', extension: 'postgres_changes', channel: topic.replace(/^realtime:/, '') }]);
      return;
    }
    if (event === 'access_token') {
      conn.token = payload?.access_token ?? null;
      for (const sub of conn.channels.values()) sub.uid = uidOfToken(conn.token);
      return wsReply(ws, joinRef, ref, topic, 'ok');
    }
    if (event === 'phx_leave') {
      const sub = conn.channels.get(topic);
      if (sub) { subs.delete(sub); conn.channels.delete(topic); }
      wsReply(ws, joinRef, ref, topic, 'ok');
      return wsSend(ws, [joinRef, null, topic, 'phx_close', {}]);
    }
    wsReply(ws, joinRef, ref, topic, 'ok');   // broadcast / presence ฯลฯ — ไม่ใช้ในแอปนี้
  });
  ws.on('close', () => { for (const sub of conn.channels.values()) subs.delete(sub); });
  ws.on('error', () => {});
}

/** ส่งเหตุการณ์ให้ผู้ฟังที่ "อ่านแถวนั้นได้ตาม RLS" เท่านั้น (ถ้ามองไม่เห็นแถวก็ไม่ส่ง — พฤติกรรมเดียวกับ Supabase Realtime) */
async function fanout({ table, op, id }) {
  const targets = [...subs].filter((s) => s.filters.some((f) => f.table === table && (f.event === '*' || f.event === op)));
  await Promise.all(targets.map(async (s) => {
    try {
      let row = null;
      if (op !== 'DELETE') {
        row = await withUser(s.uid, async (c) => (await c.query(`select to_jsonb(t) as r from public.${q(table)} t where id = $1`, [id])).rows[0]?.r ?? null);
        if (!row) return;
      }
      const ids = s.filters.filter((f) => f.table === table && (f.event === '*' || f.event === op)).map((f) => f.id);
      wsSend(s.ws, [null, null, s.topic, 'postgres_changes', {
        ids,
        data: {
          schema: 'public', table, commit_timestamp: new Date().toISOString(), type: op, columns: [],
          record: op === 'DELETE' ? {} : row, old_record: op === 'INSERT' ? {} : { id }, errors: null,
        },
      }]);
    } catch { /* ผู้ฟังหลุดหรือสิทธิ์ผิด → ข้ามเหตุการณ์นี้ */ }
  }));
}

async function startRealtime(server) {
  const tables = await installNotify();
  const listener = new pg.Client({
    host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 54329),
    user: process.env.PGUSER ?? 'postgres', password: process.env.PGPASSWORD, database: DB,
  });
  await listener.connect();
  await listener.query('listen dev_changes');
  listener.on('notification', (msg) => { try { void fanout(JSON.parse(msg.payload)); } catch { /* ignore */ } });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', onRealtimeConnection);
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://dev');
    if (u.pathname !== '/realtime/v1/websocket') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  console.log(`realtime (จำลอง) พร้อม: ${tables.join(', ')}`);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://dev');
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    const uid = userIdOf(req);

    // ----- Auth -----
    if (p === '/auth/v1/token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      const body = await readJson(req);
      if (grant === 'password') {
        const u = (await pool.query('select id, email from auth.users where lower(email) = lower($1)', [body.email ?? ''])).rows[0];
        if (!u || body.password !== PASSWORD) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 400, msg: 'Invalid login credentials' });
        return send(res, 200, session(u));
      }
      if (grant === 'refresh_token') {
        const d = verify(body.refresh_token);
        const u = d?.typ === 'refresh' ? (await pool.query('select id, email from auth.users where id = $1', [d.sub])).rows[0] : null;
        return u ? send(res, 200, session(u)) : send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token', code: 400, msg: 'Invalid Refresh Token' });
      }
      return send(res, 400, { msg: 'grant_type ไม่รองรับ' });
    }
    if (p === '/auth/v1/user' && req.method === 'GET') {
      if (!uid) return send(res, 401, { msg: 'invalid JWT', code: 401 });
      const u = (await pool.query('select id, email from auth.users where id = $1', [uid])).rows[0];
      return send(res, 200, { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {} });
    }
    if (p === '/auth/v1/logout') return send(res, 204);

    // ----- REST -----
    let m;
    if ((m = /^\/rest\/v1\/rpc\/([^/]+)$/.exec(p)) && req.method === 'POST') return await rpcCall(res, m[1], await readJson(req), uid);
    if ((m = /^\/rest\/v1\/([^/]+)$/.exec(p))) {
      if (req.method === 'GET') return await restSelect(req, res, m[1], url.searchParams, uid);
      if (req.method === 'PATCH') return await restPatch(req, res, m[1], url.searchParams, uid);
      return send(res, 405, { message: `dev-api ไม่รองรับ ${req.method} ที่ตาราง` });
    }

    // ----- Storage -----
    if ((m = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(p))) {
      if (req.method === 'POST') return await storageSign(res, m[1], [m[2]], uid, true);
      if (req.method === 'GET') return storageServe(res, m[1], m[2], url.searchParams.get('token'));
    }
    if ((m = /^\/storage\/v1\/object\/sign\/([^/]+)$/.exec(p)) && req.method === 'POST') {
      const b = await readJson(req);
      return await storageSign(res, m[1], b.paths ?? [], uid, false);
    }
    if ((m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(p)) && (req.method === 'POST' || req.method === 'PUT')) return await storageUpload(req, res, m[1], m[2], uid);

    send(res, 404, { message: `ไม่พบเส้นทาง ${req.method} ${p}` });
  } catch (e) { sendError(res, e); }
});
await startRealtime(server);
server.listen(PORT, '127.0.0.1', () => console.log(`dev-api พร้อมที่ http://127.0.0.1:${PORT}  (db=${DB})`));
