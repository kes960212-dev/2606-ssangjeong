/**
 * 쌍정 일정함 — 학교 업무 시트 → 사이트 동기화
 *
 * 이 스크립트는 선생님 본인 드라이브에 따로 만든 앱스스크립트에 붙여 넣습니다.
 * (학교 시트의 [확장 프로그램]에 넣으면 시트 편집자 모두가 동기화 키를 볼 수 있으니 따로 만듭니다.)
 *
 * 처음 한 번: 아래 두 값을 채우고 → syncNow 실행(권한 허용) → installTrigger 실행
 * 그다음부터는 10분마다 시트가 바뀌었을 때만 사이트로 보냅니다.
 */
const SITE_URL = 'https://여기에-사이트-주소.netlify.app';   // 끝에 / 없이
const SYNC_KEY = '여기에-동기화-키';                         // Netlify 환경변수 SYNC_KEY와 같은 값

const SHEET_ID = '1nxZJFVJEoSOL2QjpxH0EJzwScv0WzkVTtXNptQMrBDU';

// 탭 이름이 해마다 조금 바뀌어도 찾도록 앞부분·포함 글자로 찾습니다.
const PUBLIC_TABS = [
  { label: '학사일정', find: n => n.indexOf('학사일정') === 0 },
  { label: '행사 일정', find: n => n.replace(/\s/g, '') === '행사일정' },
  { label: '특별실 시간표', find: n => n.indexOf('특별실') === 0, cols: [0, 12] },   // 오른쪽 PC 비밀번호 칸은 보안으로
  { label: '내선번호', find: n => n.indexOf('인터폰') >= 0 },
  { label: '필수 연수', find: n => n.indexOf('필수 연수') === 0 },
  { label: '기기 대장', find: n => n.indexOf('기기') === 0 },
  { label: '교육과정 편제', find: n => n.indexOf('교육과정 편제') === 0 },
];
const SECURE_TABS = [
  { label: '아이디·비번', find: n => n.indexOf('아이디') === 0 },
  { label: '도어락', find: n => n.indexOf('도어락') === 0 },
  { label: '와이파이', find: n => n.indexOf('학내망') === 0 },
  { label: '비상연락망', find: n => n.indexOf('비상연락망') >= 0 },
  { label: '공용 PC 비밀번호', find: n => n.indexOf('특별실') === 0, cols: [13, 99] },
];

function syncNow() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();
  const byFind = f => sheets.filter(s => !s.isSheetHidden()).find(s => f(s.getName()));

  // 학교일정(2026) — A~Q열
  const sched = sheets.find(s => /^학교일정/.test(s.getName()));
  if (!sched) throw new Error('학교일정 탭을 찾지 못했습니다.');
  const ym = sched.getName().match(/(\d{4})/);
  const year = ym ? Number(ym[1]) : new Date().getFullYear();
  const schedule = trimRows_(sched.getRange(1, 1, sched.getLastRow(), 17).getDisplayValues());

  const tables = tabs_(PUBLIC_TABS, byFind);
  const secure = { tables: tabs_(SECURE_TABS, byFind) };

  // 링크 모음 — 셀에 걸린 하이퍼링크를 그대로 가져옵니다.
  const links = [];
  const linkSheet = sheets.find(s => s.getName().indexOf('링크') === 0);
  if (linkSheet) {
    const rng = linkSheet.getDataRange();
    const rich = rng.getRichTextValues(), vals = rng.getDisplayValues();
    rich.forEach((row, r) => row.forEach((cell, c) => {
      const url = cell && (cell.getLinkUrl() || (cell.getRuns().find(x => x.getLinkUrl()) || { getLinkUrl: () => null }).getLinkUrl());
      if (!url) return;
      const note = vals[r].filter((v, i) => i !== c && v && !/^\d+$/.test(v)).join(' ').replace(/^<-\s*/, '');
      links.push({ title: vals[r][c].trim(), url: url, note: note.trim() });
    }));
  }

  const pub = { year: year, schedule: schedule, tables: tables, links: links };
  const sig = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify([pub, secure])));
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('lastSig') === sig) { console.log('바뀐 내용 없음'); return; }

  pub.updatedAt = new Date().toISOString();
  const res = UrlFetchApp.fetch(SITE_URL + '/api/sync', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-sync-key': SYNC_KEY },
    payload: JSON.stringify({ public: pub, secure: secure }),
  });
  if (res.getResponseCode() !== 200) throw new Error('사이트로 보내지 못했습니다: ' + res.getResponseCode() + ' ' + res.getContentText());
  props.setProperty('lastSig', sig);
  console.log('보냄: 일정 ' + schedule.length + '행, 표 ' + tables.length + '개, 링크 ' + links.length + '개');
}

function tabs_(defs, byFind) {
  const out = [];
  defs.forEach(d => {
    const s = byFind(d.find);
    if (!s || s.getLastRow() === 0) return;
    let rows = s.getRange(1, 1, s.getLastRow(), s.getLastColumn()).getDisplayValues();
    if (d.cols) rows = rows.map(r => r.slice(d.cols[0], d.cols[1]));
    rows = trimRows_(rows);
    if (rows.length) out.push({ name: d.label, rows: rows });
  });
  return out;
}

// 뒤쪽 빈 칸·빈 행을 잘라 보낼 양을 줄입니다.
function trimRows_(rows) {
  rows = rows.map(r => { let n = r.length; while (n > 0 && String(r[n - 1]).trim() === '') n--; return r.slice(0, n); });
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

// 10분마다 자동 동기화 (한 번만 실행)
function installTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncNow').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(10).create();
  console.log('10분마다 동기화하도록 설정했습니다.');
}

// 내용이 같아도 강제로 다시 보내기
function forceSync() {
  PropertiesService.getScriptProperties().deleteProperty('lastSig');
  syncNow();
}
