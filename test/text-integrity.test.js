/* حارس سلامة النصوص: لا سَرْبٌ من كتابات أخرى داخل العربية.
 *
 * إلهام هذا الحارس حادثٌ حقيقي: حين كتبتُ تعليقاً داخل index.html خرجت فيه
 * كلمةٌ من لغةٍ أخرى مكان كلمةٍ عربية. ولم تكن حرفاً تالفاً بل حروفاً
 * صحيحةً لا خطأ فيها، لذلك لم يلتقطها فحص المحارف التالفة ولا فحص الحروف
 * الصينية: كلاهما ينظر إلى مدىً محدَّد دون هذا المدى. وقد وقعت في تعليق
 * أو اسم اختبار فلم تُرَ في الواجهة، لكنها تجعل كل ما نكتبه في الشيفرة غير
 * موثوق للقراءة.
 *
 * القاعدة: كل حرف من خارج العربية في أي ملف مصدر أو اختبار خطأ. فنقيس الصفر.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* المدى الذي يُسمح به في المشروع: العربية، واللاتينية المقبولة في
 * الشيفرة والأرقام وعلامات الترقيم والرموز التعبيرية. وكل ما عداه خطأ. */
const FOREIGN = [
  ['السيريلية',        /[\u0400-\u04FF\u0500-\u052F]/],
  ['الصينية',          /[\u4E00-\u9FFF\u3400-\u4DBF]/],
  ['الهيراغانا',       /[\u3040-\u309F]/],
  ['الكاتاكانا',       /[\u30A0-\u30FF]/],
  ['الكورية',          /[\uAC00-\uD7AF\u1100-\u11FF]/],
  ['الديفاناغاري',     /[\u0900-\u097F]/],
  ['التايلاندية',      /[\u0E00-\u0E7F]/],
  ['محرف تالف',        /\uFFFD/],
  ['منطقة الاستخدام الخاص', /[\uE000-\uF8FF]/],
];

function sourceFiles(){
  const out = [];
  for(const dir of ['public', 'test']){
    const full = path.join(ROOT, dir);
    if(!fs.existsSync(full)) continue;
    for(const f of fs.readdirSync(full)){
      if(/\.(js|html|css|mjs|cjs)$/.test(f)) out.push(path.join(dir, f));
    }
  }
  out.push('server.js');
  return out;
}

test('لا حرف غريب اللغة في أي ملف مصدر أو اختبار', () => {
  const bad = [];
  for(const rel of sourceFiles()){
    if(!fs.existsSync(path.join(ROOT, rel))) continue;
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((ln, i) => {
      for(const [name, re] of FOREIGN){
        if(re.test(ln)){
          const chars = [...new Set(ln.match(new RegExp(re.source, 'g')) || [])]
            .map(c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));
          bad.push(rel + ':' + (i + 1) + ' [' + name + '] ' + chars.join('') +
            '\n    ' + ln.trim().slice(0, 100));
        }
      }
    });
  }
  assert.equal(bad.length, 0,
    'حروف من خارج العربية تسرّبت إلى ' + bad.length + ' موضع:\n' + bad.join('\n'));
});

test('لا محرف تالف (U+FFFD) في أي ملف', () => {
  const bad = [];
  for(const rel of sourceFiles()){
    const p = path.join(ROOT, rel);
    if(!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    const n = t.split('\uFFFD').length - 1;
    if(n) bad.push(rel + ' → ' + n);
  }
  assert.equal(bad.join(' | '), '', 'محارف تالفة: ' + bad.join(' | '));
});

test('الملفات المقروءة UTF-8 صالحة بلا علامة متمامة (BOM) قبل <html>', () => {
  /* ملف الترويسة يبدأ بـ <!DOCTYPE html>؛ وجود BOM يجعله بايتاً زائداً
   * قد يفسّر interpret المتصفح، فلا نسمح به في index.html. */
  const t = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.notEqual(t.charCodeAt(0), 0xFEFF, 'لا علامة متمامة (BOM) في أول الملف');
  assert.ok(t.startsWith('<!DOCTYPE html>') || t.startsWith('<!doctype html>'),
    'يبدأ بـ DOCTYPE — أول محرف هو ' + JSON.stringify(t.slice(0, 15)));
});

test('تسميات الأزرار الجديدة نظيفة وناضجة', () => {
  const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const btn = HTML.match(/onclick="rejectSuggestion\('\$\{s\.id\}'\)">([^<]*)</);
  assert.ok(btn, 'زر الحفظ موجود');
  assert.equal(btn[1].trim(), '\u2715 \u062d\u0641\u0638', 'النصّ «✕ حفظ»');
  assert.ok(!/\u2716\s*\u0631\u0641\u0636/.test(btn[1]), 'لا يعود نصّ «رفض»');

  /* لونٌ هادئ لا أحمر: فعلٌ عادي لا عقاب */
  assert.ok(HTML.includes('btn-secondary soft-dismiss'), 'الصنف الهادئ مستعمل');
  const approve = HTML.match(/onclick="approveSuggestion\('\$\{s\.id\}'\)">([^<]*)</);
  assert.ok(approve, 'زر الاعتماد ما زال كما هو');
  assert.ok(approve[1].includes('\u0627\u0639\u062a\u0645\u0627\u062f'), 'نصّ الاعتماد «اعتماد»');
});

test('نافذة التأكيد لا تخالف نصّ الزرّ', () => {
  const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const i = HTML.indexOf('function rejectSuggestion(');
  const j = HTML.indexOf('function fmtTime(', i);
  const body = HTML.slice(i, j);
  const conf = body.match(/confirm\('([^']*)'\)/);
  assert.ok(conf, 'توجد رسالة تأكيد');
  assert.ok(conf[1].includes('\u062d\u0641\u0638'), 'تبدأ بكلمة «حفظ» لتوافق الزرّ');
  assert.ok(!conf[1].includes('\u0631\u0641\u0636'), 'لا تقول «رفض» — نافذةٌ تخالف زرّها ليست مريحة');
  /* القرار الداخلي يبقى رفضاً نهائياً كما كان — الدالة لا تتغيّر مع التسمية */
  assert.ok(/t\.status = 'REJECTED'/.test(body), 'الحالة المخزَّنة REJECTED');
  assert.ok(/t\.decidedAt\s*=/.test(body), 'ويُسجَّل decidedAt');
});
