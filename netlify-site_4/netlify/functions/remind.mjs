// 6학년 운영 데스크 — 아침 알림 (매일 자동 실행)
// 오늘 내 반 전담 시간 + 오늘/내일 마감인 미제출 수합 + 마감 지난 미제출을 휴대폰으로 알려 줍니다.
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

/* ───── 전담 ───── */

/** 그 날의 전담 배치 (없으면 null — 주말·방학 등 배치표에 없는 날) */
const specOf = (data, ds) => (data.specialist && data.specialist.days && data.specialist.days[ds]) || null;

/** 교시 목록 (급식 등은 빼고 'n교시'만) */
const specPeriods = (data) =>
  ((data.specialist && data.specialist.periods) || []).filter((p) => /교시/.test(p.name));

/**
 * 그 선생님 반의 오늘 전담을 한 줄로.
 *   '2교시 과학 · 3교시 과학'  /  '전담 없음'  /  ''(반을 안 골랐거나 배치표에 없는 날)
 */
function specSummary(data, cls, ds) {
  if (!cls) return '';
  const day = specOf(data, ds);
  if (!day) return '';
  const out = [];
  for (const p of specPeriods(data)) {
    const v = (day.slots || {})[p.name] && (day.slots || {})[p.name][String(cls)];
    if (v) out.push(p.name + ' ' + v);
  }
  return out.length ? out.join(' · ') : '전담 없음';
}

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
  const specDay = specOf(data, today);          // 오늘이 등교일(전담 배치표에 있는 날)인지

  // 전담 배치가 있는 날이면 알릴 내용이 늘 있습니다(전담 없음도 알려 줄 가치가 있음).
  if (!specDay && !soon.length && !late.length && !starToday.length) {
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

  const grade = data.grade || 6;
  let sent = 0, gone = 0;
  for (const s of subs) {
    const spec = specSummary(data, s.cls, today);           // 내 반 오늘 전담
    let body = lines(s.cls, { soon, late, starToday, today, specDay });
    if (!body && !spec) continue;                            // 그 선생님과 상관없는 날은 건너뜀
    if (!body) body = '마감이 가까운 수합은 없어요.';

    // 제목에 전담을 올려 두면 잠금화면에서 열지 않고도 보입니다.
    const title = spec
      ? grade + '-' + s.cls + ' · ' + spec
      : grade + '학년 수합 알림';

    // 앱 아이콘에 띄울 숫자 — 그 선생님 반이 아직 안 낸 수합 건수
    const mine = (it) => !s.cls || missing(it).indexOf(String(s.cls)) >= 0;
    const count = soon.filter(mine).length + late.filter(mine).length;
    const payload = JSON.stringify({
      title, body, tag: 'g6-due-' + today, url: '/', count
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

  // 전담 배치표에 적힌 그 날의 메모 (예: '3교시 - 민방위훈련')
  ((x.specDay && x.specDay.notes) || []).slice(0, 2).forEach((n) => {
    const t = String(n || '').trim();
    if (t) out.push('· ' + t.slice(0, 40));
  });

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
