// 사이트용 API — 자료 제공, 시트 동기화 수신, 보안 탭 잠금 해제, 알림 구독
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import crypto from 'node:crypto';
import { eventsFrom, dailyDigest, weeklyDigest, collectPushMsg, noticePushMsg, classesFrom, targetsOf } from '../../src/digest.js';
import { loadCollect, loadNotices } from '../../src/collect-store.js';
import { useVapid } from '../../src/vapid.js';

export const config = { path: '/api/*' };

const env = k => process.env[k] || '';
const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const store = getStore({ name: 'school', consistency: 'strong' });
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  // 1) 공개 자료 (일정·업무 참고)
  if (route === 'data' && req.method === 'GET') {
    const pub = await store.get('public', { type: 'json' });
    if (!pub) return json({ error: '아직 시트에서 자료를 받지 않았습니다. 앱스스크립트의 syncNow를 한 번 실행해 주세요.' }, 404);
    return json(pub);
  }

  // 2) 앱스스크립트가 보내는 시트 자료
  if (route === 'sync' && req.method === 'POST') {
    if (!env('SYNC_KEY') || !safeEq(req.headers.get('x-sync-key') || '', env('SYNC_KEY'))) return json({ error: 'unauthorized' }, 401);
    if (!body.public || !Array.isArray(body.public.schedule)) return json({ error: 'bad payload' }, 400);
    await store.setJSON('public', body.public);
    if (body.secure) await store.setJSON('secure', body.secure);
    return json({ ok: true, at: body.public.updatedAt });
  }

  // 3) 보안 탭 — 코드가 맞을 때만 내려보냄 (같은 기기에서 10분에 5번 틀리면 잠금)
  if (route === 'secure' && req.method === 'POST') {
    const rlKey = 'rl/' + hash(context.ip || 'unknown');
    const rl = (await store.get(rlKey, { type: 'json' })) || { n: 0, t: Date.now() };
    if (Date.now() - rl.t > 10 * 60e3) { rl.n = 0; rl.t = Date.now(); }
    if (rl.n >= 5) return json({ error: '여러 번 틀려서 10분 동안 잠겼습니다.' }, 429);
    if (!safeEq(String(body.code || ''), env('SECURE_CODE') || '0000')) {
      rl.n += 1; await store.setJSON(rlKey, rl);
      return json({ error: '코드가 맞지 않습니다.' }, 403);
    }
    await store.delete(rlKey);
    const sec = await store.get('secure', { type: 'json' });
    return json(sec || { tables: [] });
  }

  // 5) 수합 · 공지
  // 올리기·체크는 누구나(사이트 주소는 우리 학교 선생님에게만 공유), 지우기·알림 보내기는
  // 올린 기기(token) 또는 보안 코드가 있어야 합니다.
  const canManage = (it) => (body.token && it.tokenHash && safeEq(hash(String(body.token)), it.tokenHash))
    || (body.code && safeEq(String(body.code), env('SECURE_CODE') || '0000'));
  const cleanLink = v => { let l = String(v || '').trim().slice(0, 500); if (l && !/^https?:\/\//.test(l)) l = 'https://' + l; return l; };
  const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const COOLDOWN = 3 * 60e3;
  async function pushTo(filter, makeMsg) {
    await useVapid(store);
    const { blobs } = await store.list({ prefix: 'sub/' });
    let sent = 0;
    await Promise.all(blobs.map(async b => {
      const rec = await store.get(b.key, { type: 'json' });
      if (!rec || rec.collect === false || !filter(rec)) return;
      try { await webpush.sendNotification(rec.sub, JSON.stringify(makeMsg(rec)), { TTL: 12 * 3600 }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await store.delete(b.key); }
    }));
    return { sent };
  }

  if (route === 'board' && req.method === 'GET') {
    const pub = await store.get('public', { type: 'json' });
    const [items, notices] = await Promise.all([loadCollect(store), loadNotices(store)]);
    return json({ classes: classesFrom(pub), items, notices });
  }
  if (route === 'collect' && req.method === 'POST') {
    const title = String(body.title || '').trim().slice(0, 80);
    const due = String(body.due || '');
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json({ error: '수합 주제와 마감일을 적어 주세요.' }, 400);
    const id = newId(), token = crypto.randomBytes(12).toString('base64url');
    await store.setJSON('c/' + id, {
      id, title, due, body: String(body.body || '').trim().slice(0, 1000), link: cleanLink(body.link), by: String(body.by || '').trim().slice(0, 20),
      grades: (Array.isArray(body.grades) ? body.grades : []).map(String).filter(g => /^[1-6]$/.test(g)),
      createdAt: new Date().toISOString(), tokenHash: hash(token), pushedAt: null,
    });
    return json({ ok: true, id, token });
  }
  if (route === 'collect/check' && req.method === 'POST') {
    const { id, cls } = body;
    if (!id || !/^[1-6]-[1-9]$/.test(String(cls))) return json({ error: 'bad request' }, 400);
    if (!(await store.get('c/' + id, { type: 'json' }))) return json({ error: '없는 수합입니다.' }, 404);
    const key = `cd/${id}/${cls}`;
    if (body.done) await store.setJSON(key, { at: new Date().toISOString() });
    else await store.delete(key);
    return json({ ok: true });
  }
  if (route === 'collect/push' && req.method === 'POST') {
    const it = body.id && await store.get('c/' + body.id, { type: 'json' });
    if (!it) return json({ error: '없는 수합입니다.' }, 404);
    if (!canManage(it)) return json({ error: '올린 기기에서 보내거나 보안 코드를 입력해 주세요.' }, 403);
    if (it.pushedAt && Date.now() - Date.parse(it.pushedAt) < COOLDOWN) return json({ error: '방금 보냈습니다. 3분 뒤에 다시 보낼 수 있습니다.' }, 429);
    const pub = await store.get('public', { type: 'json' });
    const targets = targetsOf(it, classesFrom(pub));
    const { blobs } = await store.list({ prefix: `cd/${it.id}/` });
    const done = new Set(blobs.map(b => b.key.split('/')[2]));
    const left = targets.filter(c => !done.has(c));
    if (!left.length) return json({ error: '모든 반이 체크해서 보낼 곳이 없습니다.' }, 400);
    const r = await pushTo(rec => rec.cls && left.includes(rec.cls), rec => collectPushMsg(it, rec.cls));
    it.pushedAt = new Date().toISOString(); it.pushCount = (it.pushCount || 0) + 1;
    await store.setJSON('c/' + it.id, it);
    return json({ ok: true, sent: r.sent, left: left.length, error: r.error });
  }
  if (route === 'collect/delete' && req.method === 'POST') {
    const it = body.id && await store.get('c/' + body.id, { type: 'json' });
    if (!it) return json({ ok: true });
    if (!canManage(it)) return json({ error: '올린 기기이거나 보안 코드가 있어야 지울 수 있습니다.' }, 403);
    await store.delete('c/' + it.id);
    const { blobs } = await store.list({ prefix: `cd/${it.id}/` });
    await Promise.all(blobs.map(b => store.delete(b.key)));
    return json({ ok: true });
  }

  if (route === 'notice' && req.method === 'POST') {
    const title = String(body.title || '').trim().slice(0, 80);
    const date = String(body.date || '');
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: '날짜와 공지 제목을 적어 주세요.' }, 400);
    const id = newId(), token = crypto.randomBytes(12).toString('base64url');
    await store.setJSON('n/' + id, {
      id, title, date, body: String(body.body || '').trim().slice(0, 1000), link: cleanLink(body.link),
      by: String(body.by || '').trim().slice(0, 20), createdAt: new Date().toISOString(), tokenHash: hash(token), pushedAt: null,
    });
    return json({ ok: true, id, token });
  }
  if (route === 'notice/push' && req.method === 'POST') {
    const n = body.id && await store.get('n/' + body.id, { type: 'json' });
    if (!n) return json({ error: '없는 공지입니다.' }, 404);
    if (!canManage(n)) return json({ error: '올린 기기에서 보내거나 보안 코드를 입력해 주세요.' }, 403);
    if (n.pushedAt && Date.now() - Date.parse(n.pushedAt) < COOLDOWN) return json({ error: '방금 보냈습니다. 3분 뒤에 다시 보낼 수 있습니다.' }, 429);
    const r = await pushTo(() => true, () => noticePushMsg(n));
    n.pushedAt = new Date().toISOString(); n.pushCount = (n.pushCount || 0) + 1;
    await store.setJSON('n/' + n.id, n);
    return json({ ok: true, sent: r.sent, error: r.error });
  }
  if (route === 'notice/delete' && req.method === 'POST') {
    const n = body.id && await store.get('n/' + body.id, { type: 'json' });
    if (!n) return json({ ok: true });
    if (!canManage(n)) return json({ error: '올린 기기이거나 보안 코드가 있어야 지울 수 있습니다.' }, 403);
    await store.delete('n/' + n.id);
    return json({ ok: true });
  }

  // 6) 쿨메신저 캡처 → 수합·공지 초안 (Gemini). 이미지는 읽기에만 쓰고 저장하지 않습니다.
  if (route === 'ai/read' && req.method === 'POST') {
    if (!env('GEMINI_API_KEY')) return json({ error: 'Gemini API 키가 설정되지 않았습니다. Netlify 환경변수 GEMINI_API_KEY를 넣어 주세요.' }, 501);
    const img = String(body.image || ''), mime = String(body.mime || 'image/jpeg');
    if (!img || img.length > 5_500_000 || !/^image\/(png|jpe?g|webp)$/.test(mime)) return json({ error: '이미지를 읽지 못했습니다. PNG나 JPG 캡처를 넣어 주세요.' }, 400);
    // 같은 기기에서 1시간에 30번까지
    const rk = 'airl/' + hash(context.ip || 'unknown');
    const rl = (await store.get(rk, { type: 'json' })) || { n: 0, t: Date.now() };
    if (Date.now() - rl.t > 3600e3) { rl.n = 0; rl.t = Date.now(); }
    if (rl.n >= 30) return json({ error: '1시간에 30번까지 쓸 수 있습니다. 잠시 뒤에 다시 해 주세요.' }, 429);
    rl.n++; await store.setJSON(rk, rl);

    const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const prompt = `이 이미지는 초등학교 교사들이 쓰는 업무 메신저(쿨메신저) 쪽지나 공지 화면을 캡처한 것입니다.
오늘은 ${today} 입니다. 내용을 읽고 아래 JSON 하나만 답하세요. 설명이나 코드 블록 없이 JSON만 씁니다.
{
  "kind": "collect" 또는 "notice",   // 선생님들에게 무언가를 제출·회신·입력·작성하라고 요청하면 collect, 단순 안내·알림이면 notice
  "title": "짧은 제목 (40자 이내, 무엇을 내는지/무슨 공지인지가 드러나게, '[수합]' 같은 머리말은 빼기)",
  "due": "YYYY-MM-DD 또는 빈 문자열",   // collect의 제출 마감일. '다음 주 수요일까지'처럼 상대 날짜면 오늘 기준으로 계산
  "date": "YYYY-MM-DD",                // notice가 가리키는 행사·연수 날짜. 없으면 오늘
  "body": "핵심 내용 요약 (300자 이내, 시간·장소·준비물·제출 방법을 빠뜨리지 말 것, 줄바꿈 가능)",
  "link": "이미지에 보이는 URL 또는 빈 문자열",
  "by": "보낸 부서나 담당자 (예: 교무부, 보건실) 또는 빈 문자열",
  "grades": ["1"~"6"]                  // 특정 학년만 대상이면 그 학년 숫자들, 전체 학급이면 빈 배열
}
이미지에 보이지 않는 내용은 지어내지 말고 빈 문자열로 둡니다.`;
    const model = env('GEMINI_MODEL') || 'gemini-3.6-flash';
    let out;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: img } }, { text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: 'Gemini 오류: ' + ((d.error && d.error.message) || res.status) }, 502);
      const text = (((d.candidates || [])[0] || {}).content || {}).parts?.map(x => x.text || '').join('') || '';
      out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch (e) {
      return json({ error: '이미지에서 내용을 읽지 못했습니다. 글자가 잘 보이게 다시 캡처해 주세요.' }, 502);
    }
    const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
    return json({
      kind: out.kind === 'collect' ? 'collect' : 'notice',
      title: String(out.title || '').trim().slice(0, 80),
      due: ok(out.due), date: ok(out.date) || today,
      body: String(out.body || '').trim().slice(0, 1000),
      link: /^https?:\/\/\S+$/.test(String(out.link || '').trim()) ? String(out.link).trim() : '',
      by: String(out.by || '').trim().slice(0, 20),
      grades: (Array.isArray(out.grades) ? out.grades : []).map(String).filter(g => /^[1-6]$/.test(g)),
    });
  }

  // 4) 알림
  if (route === 'vapid') return new Response(await useVapid(store), { headers: { 'content-type': 'text/plain' } });

  if (route === 'subscribe' && req.method === 'POST') {
    const sub = body.sub;
    if (!sub || !sub.endpoint) return json({ error: 'no subscription' }, 400);
    const groups = (Array.isArray(body.groups) ? body.groups : []).map(String).slice(0, 12);
    await store.setJSON('sub/' + hash(sub.endpoint), {
      sub, groups, daily: body.daily !== false, weekly: !!body.weekly,
      cls: /^[1-6]-[1-9]$/.test(String(body.cls)) ? String(body.cls) : '', collect: body.collect !== false, at: new Date().toISOString(),
    });
    return json({ ok: true });
  }

  if (route === 'unsubscribe' && req.method === 'POST') {
    if (body.endpoint) await store.delete('sub/' + hash(body.endpoint));
    return json({ ok: true });
  }

  if (route === 'test' && req.method === 'POST') {
    const rec = body.endpoint && await store.get('sub/' + hash(body.endpoint), { type: 'json' });
    if (!rec) return json({ error: '구독 정보가 없습니다. 알림을 다시 켜 주세요.' }, 404);
    await useVapid(store);
    const pub = await store.get('public', { type: 'json' });
    const events = pub ? eventsFrom(pub) : [];
    const msg = (rec.weekly && weeklyDigest(events, rec.groups)) || dailyDigest(events, rec.groups)
      || { title: '알림이 연결되었습니다', body: '선택한 학년의 일정이 있는 날 아침 7시 30분에 알려 드립니다.', url: '/', tag: 'test' };
    try { await webpush.sendNotification(rec.sub, JSON.stringify(msg)); return json({ ok: true }); }
    catch (e) { return json({ error: '보내지 못했습니다: ' + (e.statusCode || e.message) }, 500); }
  }

  return json({ error: 'not found' }, 404);
};
