'use strict';
// حارس النشر: يلتقط ما فشلت فيه النشر فعليًا.
//
// الاختبار الفعلي: كان star-week.js مكتوبًا في جذر المشروع بينما Dockerfile
// ينسخ قائمة صريحة (server.js db.js seed.js) + public. فبُنيت صورة بلا الملف،
// فشل الإقلاع بـCannot find module './star-week'، ووقع الموقع بالكامل.
//
// هذا الملف يمنع تكرار ذلك: أي require('./x') من الجذر يجب أن يكون في Dockerfile.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');

// ملفات جذر المشروع التي ينسخها Dockerfile فعليًا إلى /app
function copiedRootFiles(dockerfile) {
  const copies = [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)].map(m => m[1].trim());
  const out = new Set();
  for (const line of copies) {
    const tokens = line.split(/\s+/);
    const dest = tokens[tokens.length - 1];
    if (dest === './' || dest === '/app' || dest === '.') {
      // نسخ إلى الجذر: كل وسيط قبل الوجهة هو اسم ملف
      for (const t of tokens.slice(0, -1)) out.add(t);
    } else if (dest.startsWith('./')) {
      out.add(dest.replace(/^\.\//, '').replace(/\/$/, ''));   // مثل ./public
    }
  }
  return out;
}

test('كل require من جذر المشروع مُدرج في Dockerfile', () => {
  const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
  const copied = copiedRootFiles(dockerfile);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const reqs = [...new Set([...src.matchAll(/require\('\.\/([^']+)'\)/g)].map(m => m[1]))];
  assert.ok(reqs.length > 0, 'وُجدت requires في server.js');
  for (const r of reqs) {
    const file = r.endsWith('.js') ? r : r + '.js';
    assert.ok(copied.has(file),
      'server.js يطلب ./' + r + ' لكن Dockerfile لا ينسخ ' + file +
      ' — سيفشل الإقلاع على Render. سطر COPY: ' + copied.size + ' ملفًا.');
  }
});

test('كل ملفات الجذر التي يتطلبها الخادم موجودة فعلًا في المستودع', () => {
  const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
  const copied = copiedRootFiles(dockerfile);
  for (const f of copied) {
    if (f === 'public' || f.includes('/')) continue;
    assert.ok(fs.existsSync(path.join(ROOT, f)), 'Dockerfile ينسخ ' + f + ' وهو غير موجود');
  }
});

test('الملفات الجديدة مُدرجة في نسخة Docker (Database/secrets غير مسرّبة)', () => {
  const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
  const copied = [...copiedRootFiles(dockerfile)];
  // كل ملف من الجذر منقول إلى /app يجب أن يشارك server.js فعليًا
  for (const f of copied) {
    if (f === 'public' || f.includes('/')) continue;
    assert.ok(fs.existsSync(path.join(ROOT, f)), 'مُدرج لكنه غير موجود: ' + f);
  }
  // لا يجوز نسخ .env أو أي ملف أسرار
  for (const f of copied) assert.ok(!/^\.env|secret|credential/i.test(f), 'لا أسرار: ' + f);
});

test('Dockerfile يشير CMD إلى server.js وWORKDIR صحيح', () => {
  const d = fs.readFileSync(DOCKERFILE, 'utf8');
  assert.ok(/CMD\s+\[\s*"node",\s*"server\.js"\s*\]/.test(d), 'CMD صحيح');
  assert.ok(/WORKDIR\s+\/app/.test(d), 'WORKDIR صحيح');
  assert.ok(/npm ci --omit=dev/.test(d), 'تبعيات إنتاج فقط');
});