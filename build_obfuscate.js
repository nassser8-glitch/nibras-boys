'use strict';
// نبراس — بناء نسخة الرفع المغلّفة (obfuscated) إلى public-build/
// الاستخدام: node build_obfuscate.js
// الناتج: server/public-build/index.html (نسخة كاملة من public/ مع تغليف السكربت الرئيسي)
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC = path.join(__dirname, 'public');
const DST = path.join(__dirname, 'public-build');

// 1) انسخ مجلد public بالكامل
if (fs.existsSync(DST)) fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
function copyDir(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); }
    else fs.copyFileSync(s, d);
  }
}
copyDir(SRC, DST);

// 2) غلّف السكربتات المضمنة الكبيرة (السكربت الرئيسي فقط)
const htmlPath = path.join(DST, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g;
let m, changed = false, scriptNo = 0;
while ((m = re.exec(html))) {
  const code = m[1];
  if (code.length < 10000) continue; // اترك سكربت الـ service worker الصغير كما هو
  scriptNo++;
  console.log('obfuscating inline script #' + scriptNo + ' (' + code.length + ' bytes)...');
  const obf = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    disableConsoleOutput: false,
    stringArray: true,
    stringArrayThreshold: 0.6,
    stringArrayEncoding: ['base64'],
    stringArrayWrappersCount: 1,
    renameGlobals: false,
    identifierNamesGenerator: 'hexadecimal',
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    numbersToExpressions: false,
    simplify: true,
    ignoreImports: true,
    optionsPreset: 'default'
  }).getObfuscatedCode();
  html = html.slice(0, m.index) + '<script>' + obf + '</script>' + html.slice(m.index + m[0].length);
  changed = true;
  re.lastIndex = m.index + obf.length + 16; // تجاوز النص الجديد
}
fs.writeFileSync(htmlPath, html, 'utf8');
console.log('done: ' + (changed ? 'obfuscated; ' : 'no large script found; ') + 'output=' + DST + ' (' + html.length + ' bytes)');
