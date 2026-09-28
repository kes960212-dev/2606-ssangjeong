// 6학년 운영 데스크 — 일정 알림 (10분마다 자동 실행)
// 공지에 날짜·시각을 적어 두면, 그 시각 1시간 전에 한 번 휴대폰으로 알려 줍니다.
// 환경변수: VAPID_PUBLIC, VAPID_PRIVATE, (선택) VAPID_MAILTO, NOTICE_LEAD_MIN(기본 60)
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const env = (k) => (globalThis.Netlify?.env?.get(k)) || process.env[k] || '';
const store = () => getStore({ name: 'grade6', consistency: 'strong' });

/** 지금 시각을 서울 기준 분 단위 숫자로 (2026-10-17 15:00 → 비교하기 쉬운 값) */
const nowSeoul = () => new Date(Date.now() + 9 * 3600 * 1000);
/** 「2026-10-17 15:00」 → 분 단위 숫자. 알아볼 수 없으면 null */
function mins(when) {
  const m = String(when || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
}
const nowMins = () => Math.floor(nowSeoul().getTime() / 60000);
function label(when) {
  const m = String(when).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return when;
  const wd = ['일', '월', '화', '수', '목', '금', '토'][new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return Number(m[2]) + '/' + Number(m[3]) + '(' + wd + ') ' + m[4] + ':' + m[5];
}
/** 같은 공지를 두 번 보내지 않으려고 쓰는 이름표 (시트 줄 번호가 바뀌어도 그대로) */
const keyOf = (m) => String(m.when) + '|' + String(m.text || '').slice(0, 60);

export default async () => {
  const st = store();
  const pub = env('VAPID_PUBLIC'), priv = env('VAPID_PRIVATE');
  if (!pub || !priv) return new Response('VAPID 키가 없어 보내지 않았습니다.', { status: 200 });
  webpush.setVapidDetails('mailto:' + (env('VAPID_MAILTO') || 'grade6@example.com'), pub, priv);

  const data = await st.get('data', { type: 'json' });
  if (!data) return new Response('자료가 아직 없습니다.', { status: 200 });

  const lead = Math.max(5, Math.min(24 * 60, Number(env('NOTICE_LEAD_MIN') || 60)));
  const now = nowMins();

  // 보낸 기록 (지난 것은 이틀 뒤에 정리합니다)
  const sent = (await st.get('notice/sent', { type: 'json' })) || {};

  // 알릴 때가 된 공지 고르기
  const due = [];
  for (const m of (data.memos || [])) {
    const at = mins(m.when);
    if (at == null) continue;
    if (now < at - lead) continue;      // 아직 이르고
    if (now >= at) continue;            // 시각이 지났으면 안 보냅니다
    const k = keyOf(m);
    if (sent[k]) continue;
    due.push({ m, k, at });
  }

  // 오래된 기록 정리
  let pruned = 0;
  for (const k of Object.keys(sent)) {
    const at = mins(k.split('|')[0]);
    if (at == null || at < now - 2 * 24 * 60) { delete sent[k]; pruned++; }
  }

  if (!due.length) {
    if (pruned) await st.setJSON('notice/sent', sent);
    return new Response('알릴 일정이 없습니다.', { status: 200 });
  }

  const { blobs } = await st.list({ prefix: 'sub/' });
  const subs = [];
  for (const b of (blobs || [])) {
    const v = await st.get(b.key, { type: 'json' });
    if (v && v.endpoint) subs.push(v);
  }
  if (!subs.length) {
    due.forEach((d) => { sent[d.k] = now; });
    await st.setJSON('notice/sent', sent);
    return new Response('알림을 켠 사람이 없습니다.', { status: 200 });
  }

  let pushes = 0, gone = 0;
  for (const d of due) {
    const left = Math.round(d.at - now);
    const body = label(d.m.when) + ' (' + left + '분 뒤)\n' + String(d.m.text || '').slice(0, 160) +
      (d.m.who ? '\n— ' + d.m.who : '');
    // 아이콘 숫자(배지)는 건드리지 않습니다 — 미제출 건수와 상관없는 알림이라서요
    const payload = JSON.stringify({
      title: (data.grade || 6) + '학년 ' + (d.m.kind === '부장회의' ? '부장회의' : '공지'),
      body, tag: 'g6-notice-' + d.k.slice(0, 24), url: '/'
    });
    for (const s of subs) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 3600 }); pushes++; }
      catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) { await st.delete('sub/' + s.id); gone++; }
      }
    }
    sent[d.k] = now;
  }
  await st.setJSON('notice/sent', sent);
  return new Response('일정 ' + due.length + '건 · 알림 ' + pushes + '건' + (gone ? ' · 만료 ' + gone : ''), { status: 200 });
};

export const config = { schedule: '*/10 * * * *' };   // 10분마다
