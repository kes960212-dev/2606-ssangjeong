// src/app.html + src/parse.js → public/index.html (학교 사이트용)
// node build.mjs preview <data.json> <out.html> → 자료를 넣은 미리보기 한 장짜리
import fs from 'node:fs';
const app = fs.readFileSync('src/app.html', 'utf8');
const parse = fs.readFileSync('src/parse.js', 'utf8').replace(/^export /gm, '');
const inject = (boot) => app.replace('/*__PARSE__*/', () => parse).replace('/*__BOOT__*/', () => boot);
const [mode, dataPath, out] = process.argv.slice(2);
if (mode === 'preview') {
  const data = fs.readFileSync(dataPath, 'utf8').replace(/</g, '\\u003c');
  fs.writeFileSync(out, inject(`window.__DEMO__ = ${data};`));
} else {
  const head = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d6a5a">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="쌍정 일정">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
`;
  fs.writeFileSync('public/index.html', head + inject('') .replace('<title>', '<title>') + '\n</head-end>');
  // head/body 경계 정리
  let html = fs.readFileSync('public/index.html', 'utf8').replace('\n</head-end>', '');
  html = html.replace('<header class="top">', '</head><body>\n<header class="top">') + '\n</body></html>\n';
  fs.writeFileSync('public/index.html', html);
}
console.log('built', mode || 'site');
