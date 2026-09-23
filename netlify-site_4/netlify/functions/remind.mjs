// 6학년 운영 데스크 — 마감 알림 (매일 아침 자동 실행)
// 오늘/내일 마감인 수합 중 아직 미제출인 것과, 마감이 지난 미제출을 휴대폰으로 알려 줍니다.
// 환경변수: VAPID_PUBLIC, VAPID_PRIVATE, (선택) VAPID_MAILTO, REMIND_DAYS
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const env = (k) => (globalThis.Netlify?.env?.get(k)) || process.env[k] || '';
const store = () => getStore({ name: 'grade6', consistency: 'strong' });

/** 서울 기준 오늘 (yyyy-mm-dd) */
function seoulToday(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}
const missing = (it) => Object.keys(it.cls || {}).filter((k) => !it.cls[k]).sort();
const clean = (s) => String(s || '').replace(/\s*\([^)]*까지\)\s*/, '').trim();

export default async () => {
  const st = store();
  const pub = env('VAPID_PUBLIC'), priv = env('VAPID_PRIVATE');
  if (!pub || !priv) return new Response('VAPID 키가 없어 보내지 않았습니다.', { status: 200 });
  webpush.setVapidDetails('mailto:' + (env('VAPID_MAILTO') || 'grade6@example.com'), pub, priv);

  const data = await st.get('data', { type: 'json' });
  if (!data) return new Response('자료가 아직 없습니다.', { status: 200 });

  const today = seoulToday();
  const days = Math.max(0, Math.min(7, Number(env('REMIND_DAYS') || 1)));   // 며칠 전부터 알릴지
  const limit = seoulToday(days);
  const rows = (data.checklist && data.checklist.rows) || [];

  const soon = rows.filter((it) => it.due && it.due >= today && it.due <= limit && missing(it).length);
  const late = rows.filter((it) => it.due && it.due < today && missing(it).length);
  const todayEvents = (data.events || []).filter((e) => e.date === today);
  const starToday = todayEvents.filter((e) => e.important);

  if (!soon.length && !late.length && !starToday.length) {
    await st.setJSON('remind/last', { date: today, sent: 0, note: '알릴 내용 없음' });
    return new Response('알릴 내용이 없습니다.', { status: 200 });
  }

  // 같은 날 두 번 보내지 않기
  const last = await st.get('remind/last', { type: 'json' });
  if (last && last.date === today && last.sent > 0) {
    return new Response('오늘은 이미 보냈습니다.', { status: 200 });
  }

  const { blobs } = await st.list({ prefix: 'sub/' });
  const subs = [];
  for (const b of (blobs || [])) {
    const v = await st.get(b.key, { type: 'json' });
    if (v && v.endpoint) subs.push(v);
  }
  if (!subs.length) {
    await st.setJSON('remind/last', { date: today, sent: 0, note: '받는 사람 없음' });
    return new Response('알림을 켠 사람이 없습니다.', { status: 200 });
  }

  let sent = 0, gone = 0;
  for (const s of subs) {
    const body = lines(s.cls, { soon, late, starToday, today });
    if (!body) continue;                                   // 그 선생님과 상관없는 날은 건너뜀
    const payload = JSON.stringify({
      title: (data.grade || 6) + '학년 수합 알림',
      body, tag: 'g6-due-' + today, url: '/'
    });
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 8 * 3600 });
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) { try { await st.delete('sub/' + s.id); } catch {} gone++; }
      else console.error('push ' + code + ': ' + (e && e.message));
    }
  }
  await st.setJSON('remind/last', { date: today, sent, gone, at: new Date().toISOString() });
  return new Response('보냄 ' + sent + '건, 만료 정리 ' + gone + '건', { status: 200 });
};

/** 그 선생님에게 보여 줄 문구 (반을 골랐으면 그 반 기준으로) */
function lines(cls, x) {
  const out = [];
  const mine = (it) => !cls || missing(it).indexOf(String(cls)) >= 0;

  const late = x.late.filter(mine);
  if (late.length) {
    out.push('⚠ 마감 지남: ' + late.slice(0, 3).map((it) => clean(it.name)).join(', ') +
      (late.length > 3 ? ' 외 ' + (late.length - 3) + '건' : ''));
  }
  const soon = x.soon.filter(mine);
  soon.slice(0, 3).forEach((it) => {
    const d = it.due === x.today ? '오늘까지' : md(it.due) + '까지';
    out.push('· ' + clean(it.name) + ' — ' + d + (cls ? '' : ' (미제출 ' + missing(it).join(',') + '반)'));
  });
  if (soon.length > 3) out.push('· 외 ' + (soon.length - 3) + '건');
  x.starToday.slice(0, 2).forEach((e) => out.push('★ 오늘 ' + String(e.text).slice(0, 40)));

  return out.length ? out.join('\n') : '';
}
function md(s) { const [, m, d] = String(s).split('-'); return Number(m) + '/' + Number(d); }

export const config = { schedule: '30 22 * * *' };   // 매일 07:30 (한국 시간)
