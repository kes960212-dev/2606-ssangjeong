// 푸시 키 — Netlify 환경변수에 넣지 않아도 처음 쓸 때 한 번 만들어 Blobs에 보관합니다.
// (환경변수 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY가 있으면 그것을 씁니다.)
import webpush from 'web-push';
export async function useVapid(store) {
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    let k = await store.get('cfg/vapid', { type: 'json' });
    if (!k) { k = webpush.generateVAPIDKeys(); await store.setJSON('cfg/vapid', k); }
    pub = k.publicKey; priv = k.privateKey;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:kes960212@gmail.com', pub, priv);
  return pub;
}
