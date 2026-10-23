// 학교일정 시트 → 구조화된 일정 목록
// 브라우저(index.html)와 Netlify 함수(remind.mjs)가 함께 사용합니다.

export const GROUPS = [
  { id: '1', label: '1학년' }, { id: '2', label: '2학년' }, { id: '3', label: '3학년' },
  { id: '4', label: '4학년' }, { id: '5', label: '5학년' }, { id: '6', label: '6학년' },
  { id: 'staff', label: '교직원' }, { id: 'parent', label: '학부모' },
  { id: 'special', label: '통합지원반' }, { id: 'common', label: '학교 공통' },
];

const HOLIDAYS = /^(삼일절|노동절|어린이날|대체\s?공휴일|학교장\s?재량휴업일|부처님\s?오신\s?날|현충일|광복절|추석|추석연휴|개천절|한글날|성탄절|신정|설날|제헌절|.*지방선거|.*선거일)$/;
const DAY_NOTE = /(의 날|기념일|추념일|전쟁일|추모식|탄신일|식목일|단오|날)$/;
const STAFF = /(교원|교직원|전직원|직원 협의회|교사\)|담임교사|협의회|연수|위원회|평가회|종합일람표|생활통지표|출결마감|상담마감|나이스|전문적 학습 공동체|동료장학|사이버보안진단|학습지원대상|기재요령|결핵검진|자율연수|입력·점검)/;
const PARENT = /학부모|보호자/;

function lines(s) { return String(s || '').split('\n').map(x => x.replace(/\s+$/, '')); }

// 괄호가 덜 닫힌 줄은 다음 줄과 합칩니다.
function joinBroken(arr) {
  const out = [];
  for (const l of arr) {
    if (!l.trim()) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && (prev.split('(').length > prev.split(')').length)) out[out.length - 1] = prev + ' ' + l.trim();
    else out.push(l.trim());
  }
  return out;
}

function isNameLike(s) {
  const t = s.trim();
  if (!t) return true;
  if (DAY_NOTE.test(t)) return false;
  return t.split(/[,，]/).filter(p => p.trim()).every(p => /^[가-힣\s]{2,6}(\([^)]*\))?$|담임|통합|보건|영양|체육|과학/.test(p.trim()));
}

export function gradesOf(text) {
  const g = new Set();
  let t = text.replace(/\d{1,2}:\d{2}/g, ' ');
  if (/전교생|전학년|전 ?학급|전교\s|전교학생|1\s*~\s*6\s*학년|전체 교직원 및 학생|전교직원 및 전교생/.test(t)) ['1', '2', '3', '4', '5', '6'].forEach(x => g.add(x));
  const lowHigh = /고학년|저학년/.test(t);
  if (/고학년/.test(t)) ['4', '5', '6'].forEach(x => g.add(x));
  if (/저학년/.test(t)) ['1', '2', '3'].forEach(x => g.add(x));
  for (const m of t.matchAll(/(?<![\d.~\/-])([1-6])\s*~\s*([1-6])\s*학년(?!\s*연구실)/g)) for (let i = +m[1]; i <= +m[2]; i++) g.add(String(i));
  for (const m of t.matchAll(/(?<![\d.~\/-])((?:[1-6]\s*,\s*)*[1-6])\s*학년(?!\s*연구실)/g)) m[1].split(',').forEach(x => g.add(x.trim()));
  const venue = new Set();
  if (!lowHigh) {
    for (const m of t.matchAll(/(?<![\d.])([1-6])\s*-\s*([1-6])(?!\d)(\s*교실)?/g)) (m[3] ? venue : g).add(m[1]);
  }
  if (![...g].some(x => /^\d$/.test(x))) venue.forEach(x => g.add(x));
  if (/통합지원반|특수학급|통합\d|통합학급|개별화교육/.test(t)) g.add('special');
  if (PARENT.test(t)) g.add('parent');
  if (STAFF.test(t)) g.add('staff');
  if (![...g].some(x => x !== 'special')) {
    if (!g.has('special')) g.add('common');
  }
  return [...g];
}

function parseEnd(text, start) {
  // (~3.13.) / 8.31~9.4 / ~22일 / 7.23.~7.29
  let m = text.match(/~\s*(\d{1,2})\s*[./]\s*(\d{1,2})(?!\d)/);
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const y = start.getFullYear() + (mo < start.getMonth() + 1 - 6 ? 1 : 0);
      const e = new Date(y, mo - 1, d);
      if (e > start && (e - start) / 864e5 < 90) return e;
    }
  }
  m = text.match(/~\s*(\d{1,2})\s*일/);
  if (m) {
    const e = new Date(start.getFullYear(), start.getMonth(), +m[1]);
    if (e > start) return e;
  }
  return null;
}

export const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function parseSchedule(rows, year) {
  const events = [], notes = [];
  for (const r of rows || []) {
    const dm = String(r[0] || '').match(/^\s*(\d{1,2})\.\s*(\d{1,2})\s*$/);
    if (!dm) continue;
    const mo = +dm[1], d = +dm[2];
    const date = new Date(mo >= 3 ? year : year + 1, mo - 1, d);
    const dateStr = ymd(date);
    const main = String(r[2] || '');
    let p = String(r[15] || ''), q = String(r[16] || '');
    if (p.trim() === main.trim()) p = '';
    if (q.trim() === main.trim()) q = '';
    // 담당자 칸과 기념일 칸이 뒤바뀐 행 보정
    let owner = '', note = '';
    for (const v of [p, q]) {
      if (!v.trim()) continue;
      if (!owner && lines(v).every(isNameLike)) owner = v; else note = note ? note + '\n' + v : v;
    }
    if (note.trim()) notes.push({ date: dateStr, text: note.replace(/\n/g, ' ').trim() });
    const items = joinBroken(lines(main));
    if (!items.length) continue;
    let ol = lines(owner);
    if (ol.length !== items.length) ol = ol.filter(x => x.trim());
    const ownerFor = i => (ol.length === items.length ? ol[i] : (ol.length === 1 ? ol[0] : '')) || '';
    items.forEach((text, i) => {
      const holiday = HOLIDAYS.test(text.trim());
      const end = holiday ? null : parseEnd(text, date);
      events.push({
        id: `${dateStr}-${i}`, date: dateStr, end: end ? ymd(end) : null,
        text, owner: ownerFor(i).trim().replace(/[,\s]+$/, ''), holiday,
        groups: holiday ? ['common'] : gradesOf(text),
      });
    });
  }
  return { events, notes };
}

export function matchGroups(ev, sel) {
  if (!sel || !sel.length) return true;
  return ev.groups.some(g => sel.includes(g));
}

export const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export function fmtDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}.${d}(${WEEK[dt.getDay()]})`;
}

// 학급 목록 — 내선번호 탭의 "6 - 1" 같은 칸에서 자동으로 만듭니다. (시트에 반이 늘면 따라서 늘어남)
export function classesFrom(pub) {
  const set = new Set();
  for (const t of pub?.tables || []) {
    if (!/내선|인터폰/.test(t.name)) continue;
    for (const r of t.rows) for (const c of r) {
      const m = String(c).match(/^\s*([1-6])\s*-\s*([1-9])\s*$/);
      if (m) set.add(`${m[1]}-${m[2]}`);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
}

// 이 수합의 대상 학급
export function targetsOf(item, classes) {
  const g = item.grades || [];
  return g.length ? classes.filter(c => g.includes(c.split('-')[0])) : classes;
}
