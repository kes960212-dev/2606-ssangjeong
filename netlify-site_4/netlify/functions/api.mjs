// 6학년 운영 데스크 — Netlify 함수 (/api)
// 앱스스크립트가 보내 둔 자료를 그대로 꺼내 주기 때문에 빠릅니다.
// 사이트에서 저장한 내용은 여기 잠깐 쌓아 두고, 시트 쪽 자동 실행이 1분마다 가져가 저장합니다.
// 환경변수: SYNC_SECRET(시트 설정의 동기화키), SESSION_SECRET(아무 긴 문자열)
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const env = (k) => (globalThis.Netlify?.env?.get(k)) || process.env[k] || '';
const store = () => getStore({ name: 'grade6', consistency: 'strong' });
const mem = new Map();

async function get(key, ttl = 15000) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await store().get(key, { type: 'json' });
  mem.set(key, { t: Date.now(), v });
  return v;
}
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// 시트에 저장해야 하는 요청 (큐에 쌓아 두고 앱스스크립트가 가져감)
const WRITE = new Set(['check', 'addItem', 'save', 'addEvent', 'addMemo', 'addSupply', 'setSupply', 'setEvent', 'setSpec', 'addGroup', 'delGroup', 'addRecord', 'delRow', 'saveRecords']);
const QMAX = 300;
const reply = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default async (req, context) => {
  if (req.method !== 'POST') return reply({ ok: false, error: 'POST only' });
  let p;
  try {
    const t = await req.text();
    if (t.length > 8_000_000) return reply({ ok: false, error: '요청이 너무 큽니다.' });
    p = JSON.parse(t);
  } catch { return reply({ ok: false, error: '잘못된 요청입니다.' }); }

  try {
    const a = String(p.action || '');
    const bySecret = p.secret !== undefined && safeEq(env('SYNC_SECRET'), String(p.secret || ''));

    // ── 앱스스크립트가 부르는 것들 ──
    if (a === 'sync') {
      if (!bySecret) throw new Error('동기화 키가 맞지 않아요.');
      const st = store();
      if (Array.isArray(p.ack) && p.ack.length) await drop(st, p.ack);   // 처리 끝난 요청 지우기
      if (p.data) { await st.setJSON('data', p.data); mem.set('data', { t: Date.now(), v: p.data }); }
      if (p.auth) { await st.setJSON('auth', p.auth); mem.delete('auth'); }
      // 학교 자료는 본 자료와 다른 자리에 둡니다. 코드가 맞아야만 내려갑니다.
      if (p.school !== undefined) {
        if (p.school) { await st.setJSON('school', p.school); mem.delete('school'); }
        else { try { await st.delete('school'); } catch {} mem.delete('school'); }
      }
      return reply({ ok: true, data: { saved: true } });
    }
    if (a === 'pull') {
      if (!bySecret) throw new Error('동기화 키가 맞지 않아요.');
      return reply({ ok: true, data: { jobs: await jobs() } });
    }

    if (a === 'login') return reply({ ok: true, data: await login(p, context) });
    if (a === 'logout' || a === 'ping') return reply({ ok: true, data: true });

    // ── 휴대폰 알림 ──
    if (a === 'vapid') return reply({ ok: true, data: { key: env('VAPID_PUBLIC') || '' } });
    if (a === 'subscribe') {
      const sub = p.sub;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('알림 정보를 받지 못했어요.');
      if (String(sub.endpoint).length > 800) throw new Error('알림 정보가 너무 깁니다.');
      const id = crypto.createHash('sha256').update(String(sub.endpoint)).digest('hex').slice(0, 32);
      await store().setJSON('sub/' + id, {
        id, endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
        who: String(p.who || '').slice(0, 20), cls: String(p.cls || '').slice(0, 4),
        at: new Date().toISOString()
      });
      return reply({ ok: true, data: { id } });
    }
    if (a === 'unsubscribe') {
      if (!p.endpoint) throw new Error('알림 정보를 받지 못했어요.');
      const id = crypto.createHash('sha256').update(String(p.endpoint)).digest('hex').slice(0, 32);
      try { await store().delete('sub/' + id); } catch {}
      return reply({ ok: true, data: { off: true } });
    }

    const auth = await get('auth', 10000);
    if (!auth?.open) await session(p.token);          // 접속코드가 없으면 로그인 없이 열림
    if (a === 'data') {
      const d = await get('data');
      if (!d) throw new Error('아직 자료가 준비되지 않았어요. 시트에서 [지금 동기화]를 눌러 주세요.');
      return reply({ ok: true, data: d });
    }
    if (a === 'school') {
      const au = await get('auth', 10000);
      if (!au?.schoolCode) throw new Error('학교 자료가 준비되지 않았어요.');
      const ip = crypto.createHash('sha256').update(String(context?.ip || 'x')).digest('hex').slice(0, 20);
      const rec = (await store().get('sfail/' + ip, { type: 'json' })) || { n: 0, t: Date.now() };
      const fresh = Date.now() - rec.t > 10 * 60 * 1000 ? { n: 0, t: Date.now() } : rec;
      if (fresh.n >= 10) throw new Error('코드를 여러 번 틀렸어요. 10분 뒤에 다시 해 주세요.');
      if (!safeEq(au.schoolCode, hmac(env('SYNC_SECRET'), String(p.code || '')))) {
        await store().setJSON('sfail/' + ip, { n: fresh.n + 1, t: fresh.t });
        await new Promise((r) => setTimeout(r, 700));
        throw new Error('코드가 맞지 않습니다.');
      }
      const sc = await get('school', 30000);
      if (!sc) throw new Error('학교 자료가 아직 동기화되지 않았어요.');
      return reply({ ok: true, data: sc });
    }
    if (WRITE.has(a)) {
      const st = store();
      const body = { ...p };
      delete body.token; delete body.secret;
      if (JSON.stringify(body).length > 200_000) throw new Error('보낸 내용이 너무 깁니다.');
      const waiting = await jobs(true);
      if (waiting.length >= QMAX) throw new Error('저장 대기가 밀려 있어요. 잠시 뒤에 다시 해 주세요.');
      const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
      await st.setJSON('q/' + id, { id, at: Date.now(), action: a, p: body });
      const n = await preview(st, a, body, waiting.length + 1);   // 화면에 먼저 반영
      return reply({ ok: true, data: { queued: true, id: id, pending: n } });
    }
    throw new Error('알 수 없는 요청');
  } catch (e) {
    const m = String(e?.message || e);
    if (m !== 'AUTH') console.error(m);
    return reply({ ok: false, error: m });
  }
};

export const config = { path: '/api' };

/** 대기 중인 요청 */
async function jobs(keysOnly) {
  const st = store();
  const { blobs } = await st.list({ prefix: 'q/' });
  const keys = (blobs || []).map((b) => b.key).sort();
  if (keysOnly) return keys;
  const out = [];
  for (const k of keys.slice(0, 60)) {
    const j = await st.get(k, { type: 'json' });
    if (j) out.push(j);
  }
  return out;
}
async function drop(st, ids) {
  for (const id of ids.slice(0, 200)) {
    try { await st.delete('q/' + String(id)); } catch {}
  }
}

/**
 * 시트에 저장되기 전이라도 다른 선생님 화면에 바로 보이도록,
 * 보관해 둔 자료에 같은 변화를 미리 적용해 둡니다.
 * 1분 뒤 시트에서 진짜 자료가 오면 그것으로 덮여요.
 */
async function preview(st, a, p, pending) {
  try {
    const d = await st.get('data', { type: 'json' });
    if (!d) return pending;
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const who = String(p.who || '').slice(0, 20);
    if (a === 'check') {
      const it = (d.checklist?.rows || []).find((x) => x.row === Number(p.row));
      if (it) it.cls[String(p.cls)] = !!p.value;
    } else if (a === 'addItem') {
      const cls = {}; (d.classes || ['1', '2', '3', '4']).forEach((c) => { cls[c] = false; });
      (d.checklist?.rows || []).push({ row: 0, name: String(p.name || ''), due: String(p.due || ''), cls, link: String(p.link || ''), pending: true });
    } else if (a === 'addEvent') {
      d.events = (d.events || []).concat([{ date: String(p.date || ''), text: String(p.text || ''), who, important: !!p.important, pending: true }])
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    } else if (a === 'addMemo') {
      d.memos = [{ row: 0, at: now, who, text: String(p.text || ''), color: String(p.color || ''), pending: true }].concat(d.memos || []);
    } else if (a === 'addSupply') {
      if (!d.supplies) d.supplies = { head: [], rows: [], groups: [] };
      const g = String(p.group || '기타');
      if (!d.supplies.groups?.includes(g)) (d.supplies.groups ||= []).push(g);
      d.supplies.rows = [{
        row: 0, group: g, at: now.slice(0, 10), who, name: String(p.name || ''),
        spec: String(p.spec || ''), qty: String(p.qty || ''), unit: String(p.unit || ''),
        price: String(p.price || ''), use: String(p.use || ''), note: String(p.note || ''),
        status: '요청', pending: true
      }].concat(d.supplies.rows || []);
    } else if (a === 'setSupply') {
      const x = (d.supplies?.rows || []).find((s) => s.row === Number(p.row));
      if (x) { x.status = String(p.status || '요청'); x.pending = true; }
    } else if (a === 'setEvent') {
      const e = (d.events || []).find((x) => x.row === Number(p.row));
      if (e) { e.important = !!p.important; e.pending = true; }
    } else if (a === 'addGroup') {
      if (!d.supplies) d.supplies = { head: [], rows: [], groups: [] };
      if (!d.supplies.groups?.includes(String(p.name))) (d.supplies.groups ||= []).push(String(p.name));
    } else if (a === 'delGroup') {
      if (d.supplies?.groups) d.supplies.groups = d.supplies.groups.filter((g) => g !== String(p.name));
    } else if (a === 'addRecord') {
      (d.records ||= []).push({ row: 0, date: String(p.date || ''), event: String(p.event || ''),
        subject: String(p.subject || '창체'), text: String(p.text || ''), pending: true });
    } else if (a === 'setSpec') {
      const day = d.specialist?.days?.[String(p.date)];
      if (day) {
        const slot = day.slots[String(p.period)] || (day.slots[String(p.period)] = {});
        if (p.subject) slot[String(p.cls)] = String(p.subject);
        else delete slot[String(p.cls)];
      }
    } else if (a === 'delRow') {
      if (String(p.tab) === 'supply') {
        if (d.supplies?.rows) d.supplies.rows = d.supplies.rows.filter((x) => x.row !== Number(p.row));
      } else {
        const key = { memo: 'memos', event: 'events' }[String(p.tab)];
        if (key && Array.isArray(d[key])) d[key] = d[key].filter((x) => x.row !== Number(p.row));
      }
    } else if (a === 'save') {
      const rows = d.raw?.[String(p.tab)] || [];
      const r = rows.find((x) => x[0] === Number(p.row));
      if (r) r[1][Number(p.col) - 1] = String(p.value == null ? '' : p.value);
    }
    d.pending = pending;
    await st.setJSON('data', d);
    mem.set('data', { t: Date.now(), v: d });
  } catch (e) { console.error('preview: ' + e.message); }
  return pending;
}

async function login(p, context) {
  const code = String(p.code || '').trim();
  const st = store();
  const ip = crypto.createHash('sha256').update(String(context?.ip || 'x')).digest('hex').slice(0, 20);
  const rec = (await st.get('fail/' + ip, { type: 'json' })) || { n: 0, t: Date.now() };
  const fresh = Date.now() - rec.t > 10 * 60 * 1000 ? { n: 0, t: Date.now() } : rec;
  if (fresh.n >= 30) throw new Error('입력 오류가 많아 10분 동안 잠겼어요.');

  const auth = await get('auth', 10000);
  if (!auth) throw new Error('아직 자료가 준비되지 않았어요.');
  if (auth.open) return { token: 'open' };
  if (!code) throw new Error('접속코드를 입력하세요.');
  if (!safeEq(auth.code, hmac(env('SYNC_SECRET'), code))) {
    await st.setJSON('fail/' + ip, { n: fresh.n + 1, t: fresh.t });
    await new Promise((r) => setTimeout(r, 600));
    throw new Error('접속코드가 맞지 않습니다.');
  }
  const days = p.remember ? 30 : 0.5;
  const payload = b64(JSON.stringify({ e: Date.now() + days * 86400000 }));
  return { token: payload + '.' + hmac(env('SESSION_SECRET'), payload) };
}

async function session(token) {
  const t = String(token || ''), i = t.indexOf('.');
  if (i < 1 || !env('SESSION_SECRET')) throw new Error('AUTH');
  const payload = t.slice(0, i);
  if (!safeEq(t.slice(i + 1), hmac(env('SESSION_SECRET'), payload))) throw new Error('AUTH');
  let d;
  try { d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('AUTH'); }
  if (!d || Date.now() > d.e) throw new Error('AUTH');
  return true;
}
