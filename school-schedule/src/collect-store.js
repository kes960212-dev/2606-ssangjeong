// 수합·공지 저장
// 수합은 c/<id>, 학급 체크는 cd/<id>/<반>, 공지는 n/<id> 로 따로 저장해
// 여러 선생님이 동시에 체크해도 서로 덮어쓰지 않습니다.
const strip = it => { const { tokenHash, ...rest } = it; return rest; };

export async function loadCollect(store) {
  const [{ blobs: cs }, { blobs: ds }] = await Promise.all([store.list({ prefix: 'c/' }), store.list({ prefix: 'cd/' })]);
  const items = (await Promise.all(cs.map(b => store.get(b.key, { type: 'json' })))).filter(Boolean);
  const byId = Object.fromEntries(items.map(it => [it.id, { ...strip(it), done: {} }]));
  const checks = await Promise.all(ds.map(d => store.get(d.key, { type: 'json' }).then(v => [d.key, v])));
  for (const [key, v] of checks) {
    const [, id, cls] = key.split('/');
    if (byId[id]) byId[id].done[cls] = (v && v.at) || true;
  }
  return Object.values(byId).sort((a, b) => a.due.localeCompare(b.due) || a.createdAt.localeCompare(b.createdAt));
}

export async function loadNotices(store) {
  const { blobs } = await store.list({ prefix: 'n/' });
  const items = (await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })))).filter(Boolean).map(strip);
  return items.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}
