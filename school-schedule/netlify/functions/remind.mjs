// 매일 07:30(한국 시간)에 구독자별 학년 일정 알림을 보냅니다.
// 월요일에 '주간 요약'을 켠 사람은 이번 주 요약 한 통으로 오늘 알림까지 대신 받습니다.
// 수합·공지 알림은 아침에 자동으로 보내지 않습니다. 담당 선생님이 사이트에서 [알림 보내기]를 누를 때만 갑니다.
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { eventsFrom, dailyDigest, weeklyDigest, kstToday } from '../../src/digest.js';
import { useVapid } from '../../src/vapid.js';

export const config = { schedule: '30 22 * * *' }; // UTC 22:30 = KST 07:30

export default async () => {
  const today = kstToday();
  const dow = today.getDay();
  if (dow === 0 || dow === 6) return new Response('weekend');

  const store = getStore({ name: 'school', consistency: 'strong' });
  const pub = await store.get('public', { type: 'json' });
  if (!pub) return new Response('no data');
  const events = eventsFrom(pub);

  await useVapid(store);

  const { blobs } = await store.list({ prefix: 'sub/' });
  let sent = 0, removed = 0;
  for (const b of blobs) {
    const rec = await store.get(b.key, { type: 'json' });
    if (!rec) continue;
    let msg = null;
    if (dow === 1 && rec.weekly) msg = weeklyDigest(events, rec.groups || [], today);
    if (!msg && rec.daily) msg = dailyDigest(events, rec.groups || [], today);
    const msgs = [msg].filter(Boolean);
    for (const m of msgs) {
      try { await webpush.sendNotification(rec.sub, JSON.stringify(m), { TTL: 6 * 3600 }); sent++; }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await store.delete(b.key); removed++; break; }
      }
    }
  }
  return new Response(`sent ${sent}, removed ${removed}`);
};
