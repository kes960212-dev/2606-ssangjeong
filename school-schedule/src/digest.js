// 알림 문구 만들기 — 아침 알림(remind.mjs)과 테스트 알림(api.mjs)이 함께 씁니다.
import { parseSchedule, matchGroups, ymd, fmtDate, WEEK } from './parse.js';

// 서버는 UTC로 돌기 때문에 한국 시간 기준 '오늘'을 따로 구합니다.
export function kstToday() {
  const k = new Date(Date.now() + 9 * 3600e3);
  return new Date(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate());
}

const short = t => t.replace(/\s+/g, ' ').trim();
const LABEL = { staff: '교직원', parent: '학부모', special: '통합', common: '공통' };
function tag(ev, groups) {
  const g = ev.groups.filter(x => groups.includes(x));
  const nums = g.filter(x => /^\d$/.test(x));
  if (nums.length === 6) return '전교';
  if (nums.length) return nums.join('·') + '학년';
  return LABEL[g[0]] || '';
}

export function eventsFrom(pub) {
  return parseSchedule(pub.schedule, pub.year || new Date().getFullYear()).events;
}

export function dailyDigest(events, groups, today = kstToday()) {
  const key = ymd(today);
  const list = events.filter(e => e.date === key && !e.holiday && matchGroups(e, groups));
  if (!list.length) return null;
  const lines = list.slice(0, 8).map(e => `· [${tag(e, groups)}] ${short(e.text)}`);
  if (list.length > 8) lines.push(`외 ${list.length - 8}건`);
  return {
    title: `오늘 ${fmtDate(key)} 일정 ${list.length}건`,
    body: lines.join('\n'),
    url: `/?d=${key}`, tag: `daily-${key}`,
  };
}

export function weeklyDigest(events, groups, today = kstToday()) {
  const mon = new Date(today); mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const days = [...Array(5)].map((_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return ymd(d); });
  const list = events.filter(e => days.includes(e.date) && !e.holiday && matchGroups(e, groups));
  if (!list.length) return null;
  const todayKey = ymd(today);
  const todayCount = list.filter(e => e.date === todayKey).length;
  const lines = list.slice(0, 10).map(e => {
    const [y, m, d] = e.date.split('-').map(Number);
    return `${WEEK[new Date(y, m - 1, d).getDay()]} · ${short(e.text)}`;
  });
  if (list.length > 10) lines.push(`외 ${list.length - 10}건`);
  return {
    title: `이번 주 일정 ${list.length}건` + (todayCount ? ` · 오늘 ${todayCount}건` : ''),
    body: lines.join('\n'),
    url: `/?d=${days[0]}`, tag: `weekly-${days[0]}`,
  };
}

// 수합·공지 알림 문구 — 담당 선생님이 [알림 보내기]를 눌렀을 때
import { classesFrom, targetsOf } from './parse.js';
const md = d => `${+d.slice(5, 7)}.${+d.slice(8)}`;
export function collectPushMsg(item, cls, today = kstToday()) {
  const t = ymd(today);
  const when = item.due === t ? '오늘 마감' : item.due < t ? `마감 지남(${md(item.due)})` : `마감 ${fmtDate(item.due)}`;
  return {
    title: `[수합] ${item.title}`,
    body: `${cls} 아직 체크 전 · ${when}${item.by ? ' · ' + item.by : ''}\n제출하셨으면 사이트에서 우리 반을 체크해 주세요.`,
    url: `/?tab=collect#c-${item.id}`, tag: `collect-${item.id}`,
  };
}
export function noticePushMsg(n) {
  return {
    title: `[공지] ${n.title}`,
    body: `${md(n.date)}${n.by ? ' · ' + n.by : ''}${n.body ? '\n' + n.body.replace(/\s+/g, ' ').slice(0, 120) : ''}`,
    url: `/?tab=notice#n-${n.id}`, tag: `notice-${n.id}`,
  };
}
export { classesFrom, targetsOf };
