/* =============================================================================
 * شريط الأدوات: الحاسبة، المترجم، التقويم، مواقيت الصلاة، الطقس
 * -----------------------------------------------------------------------------
 * نحمّل الملف الحقيقي داخل بيئة DOM وهمية صُنعت من node:test فقط، فنتأكد
 * أن الشيفرة المُلحقة تعمل كما هي — لا نسخة مبسّطة منها.
 * ========================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'toolbar.js'), 'utf8');

/* ---------------------------------------------------------- بيئة DOM وهمية */
function makeEl(id) {
  const el = {
    id: id || '', tagName: 'DIV', className: '', innerHTML: '', textContent: '', value: '',
    attrs: {}, children: [], parentNode: null, isConnected: true, style: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    querySelector(sel) { return findBySel(this, sel); },
    querySelectorAll() { return []; },
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {},
    setAttributeNS() {}
  };
  return el;
}
/* يشغّل مستمعاً كما يفعل المتصفح، فيختبر مسار الضغط الحقيقي لا الحالة
 * الداخلية للأداة. */
function fire(el, type, ev) {
  const e = ev || {};
  e.target = e.target || el;
  e.preventDefault = e.preventDefault || function () {};
  for (const fn of (el._l[type] || [])) fn(e);
}
/* عقد DOM مبنية من نصوص innerHTML: هذه الدالة تتنقل في الأشجار المبنية
 * برمجياً، وتحتاج أن تجد أيضاً معرفات مذكورة داخل نص HTML. */
function findBySel(root, sel) {
  const m = /^#([\w-]+)$/.exec(sel);
  if (!m) return null;
  const stack = [root];
  while (stack.length) {
    const n = stack.shift();
    if (n.id === m[1]) return n;
    /* عنصر أُنشئ ضمن innerHTML: نعطيه كائناً يحمل نصه للاستخدام */
    const h = typeof n.innerHTML === 'string' ? n.innerHTML : '';
    if (h.indexOf('id="' + m[1] + '"') > -1) {
      const el = makeEl(m[1]);
      el.innerHTML = h;
      return el;
    }
    for (const c of n.children) stack.push(c);
  }
  return null;
}

function makeStore() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _dump: () => Object.fromEntries(m)
  };
}

/* يبني سجلاً يستدعي الدوال المصدّرة (__tb) عبر تشغيل الملف في سياق معزول. */
function loadToolbar(opts) {
  opts = opts || {};
  const store = makeStore();
  const doc = {
    readyState: 'complete',
    body: makeEl('body'),
    documentElement: { dataset: {}, setAttribute() {} },
    createElement: t => makeEl(''),
    addEventListener() {}, getElementById: id => (id === 'nibrasToolbarDock' && opts.dockEl) ? opts.dockEl : findBySel(doc.body, '#' + id)
  };
  const fetchCalls = [];
  const fetchImpl = opts.fetch || (() => Promise.reject(new Error('offline')));
  const ctx = {
    window: {}, document: doc, localStorage: store, navigator: {},
    Intl, Date, Math, JSON, Object, Array, String, Number, isFinite, parseFloat, parseInt, encodeURIComponent,
    setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
    console,
    fetch: function (u) { fetchCalls.push(u); return fetchImpl(u); }
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'toolbar.js' });
  return { api: ctx.window.__tb, store, fetchCalls, doc, ctx };
}

/* ================================================================= الحاسبة */
test('calculator: basic arithmetic and precedence', () => {
  const { api } = loadToolbar();
  assert.equal(api.calcEval('2+3'), 5);
  assert.equal(api.calcEval('2+3*4'), 14);
  assert.equal(api.calcEval('(2+3)*4'), 20);
  assert.equal(api.calcEval('10/4'), 2.5);
  assert.equal(api.calcEval('10%3'), 1);
});

test('calculator: power is right-associative', () => {
  const { api } = loadToolbar();
  assert.equal(api.calcEval('2^3^2'), 512); // 2^(3^2)
  assert.equal(api.calcEval('-2^2'), -4);  // unary binds tighter here
});

test('calculator: unary minus and parentheses', () => {
  const { api } = loadToolbar();
  assert.equal(api.calcEval('-5+3'), -2);
  assert.equal(api.calcEval('-(4+1)'), -5);
  assert.equal(api.calcEval('3*-2'), -6);
});

test('calculator: rejects garbage instead of returning a number', () => {
  const { api } = loadToolbar();
  assert.ok(Number.isNaN(api.calcEval('')));
  assert.ok(Number.isNaN(api.calcEval('2+')));
  assert.ok(Number.isNaN(api.calcEval('(2+3')));
  assert.ok(Number.isNaN(api.calcEval('abc')));
  assert.ok(Number.isNaN(api.calcEval('2++')));
});

test('calculator: division and modulo by zero are errors, not Infinity', () => {
  const { api } = loadToolbar();
  assert.ok(Number.isNaN(api.calcEval('5/0')));
  assert.ok(Number.isNaN(api.calcEval('5%0')));
});

test('calculator: floating point noise is not amplified', () => {
  const { api } = loadToolbar();
  assert.equal(api.calcEval('0.1+0.2'), 0.30000000000000004);
});

/* ================================================================== المترجم */
test('translator: english to arabic school vocabulary', () => {
  const { api } = loadToolbar();
  assert.equal(api.trDict('student', 'en', 'ar'), 'طالب');
  assert.equal(api.trDict('attendance', 'en', 'ar'), 'حضور');
  assert.equal(api.trDict('school', 'en', 'ar'), 'مدرسة');
});

test('translator: lookup is case and whitespace insensitive', () => {
  const { api } = loadToolbar();
  assert.equal(api.trDict('  STUDENT ', 'en', 'ar'), 'طالب');
  assert.equal(api.trDict('Good Morning', 'en', 'ar'), 'صباح الخير');
});

test('translator: arabic to english round-trips a known word', () => {
  const { api } = loadToolbar();
  assert.equal(api.trDict('طالب', 'ar', 'en'), 'student');
});

test('translator: unknown phrase yields empty string, never a wrong guess', () => {
  const { api } = loadToolbar();
  assert.equal(api.trDict('zzz qqq', 'en', 'ar'), '');
  assert.equal(api.trDict('xyz', 'ar', 'en'), '');
});

test('translator: urdu (ur) replaces the jordanian dialect; no jo layer remains', () => {
  const { api } = loadToolbar();
  assert.equal(api.trDict('طالب', 'ar', 'ur'), '', 'urdu has no offline dialect dict');
  assert.equal(api.trDict('student', 'en', 'ur'), '', 'urdu goes to remote, not a dialect guess');
  assert.ok(/ur: \{ dir: 'rtl', label: 'الأردية'/.test(SRC), 'urdu entry is rtl with label الأردية');
  assert.ok(!/toJordanian/.test(SRC), 'jordanian converter removed');
  assert.ok(!/jo: \{/.test(SRC), 'no jo language entry remains');
  assert.ok(/var langs = \['ar', 'en', 'ur'\]/.test(SRC), 'toolbar language buttons offer ar/en/ur');
});

test('translator: ar/en offline school dictionary still resolves', () => {
  const { api } = loadToolbar();
  assert.equal(api.trDict('student', 'en', 'ar'), 'طالب');
  assert.equal(api.trDict('طالب', 'ar', 'en'), 'student');
  assert.equal(api.trDict('zzz qqq', 'en', 'ar'), '');
});

/* ================================================================== التقويم */
test('calendar: hijri conversion matches known dates', () => {
  const { api } = loadToolbar();
  /* 2026-10-04 */
  const h = api.hijri(2026, 9, 4);
  assert.ok(h, 'hijri must resolve');
  assert.equal(h.year, 1448);
  assert.ok(h.month >= 1 && h.month <= 12);
  assert.ok(h.day >= 1 && h.day <= 30);
});

test('calendar: every gregorian date converts to a distinct hijri day', () => {
  const { api } = loadToolbar();
  const seen = new Set();
  let count = 0;
  for (let m = 0; m < 12; m++) {
    const days = new Date(2026, m + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const h = api.hijri(2026, m, d);
      assert.ok(h, 'every date must convert: ' + m + '/' + d);
      const key = h.year + ':' + h.month + ':' + h.day;
      assert.ok(!seen.has(key), 'no two gregorian days share a hijri day: ' + key);
      seen.add(key);
      count++;
    }
  }
  assert.equal(count, 365);
  assert.equal(seen.size, 365);
});

test('calendar: header shows the gregorian month name, not the hijri one', () => {
  const { api } = loadToolbar();
  /* رأس الشبكة ميلادي (أكتوبر 2026) بينما سطر هجري أسفل يعرض الشهر الهجري الحقيقي */
  const h = api.hijri(2026, 9, 4);
  assert.ok(h, 'hijri still resolves');
  assert.ok(/AR_GREG = \[/.test(SRC), 'gregorian month table exists');
  assert.ok(/EN_GREG = \[/.test(SRC), 'english gregorian month table exists');
  assert.ok(/var mn = en \? EN_GREG\[m\] : AR_GREG\[m\]/.test(SRC), 'header indexes the gregorian names');
  assert.ok(/AR_MONTHS\[m\]/.test(SRC) === false, 'header must not index hijri names by gregorian month');
  assert.ok(h.month !== 10, 'october 2026 is not shawwal (10)');
});

/* ============================================================ مواقيت الصلاة */
test('prayer: renders all six times and flags the next one', () => {
  const { api } = loadToolbar();
  const day = new Date();
  const key = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
  const future = new Date(Date.now() + 3600e3).toISOString();
  api.lsSet('prayer', {
    at: Date.now(), day: key, city: 'Amman',
    t: {
      fajr: new Date(Date.now() - 3600e3).toISOString(),
      sunrise: new Date(Date.now() - 1800e3).toISOString(),
      dhuhr: future, asr: future, maghrib: future, isha: future
    }
  });
  const box = makeEl('tbBody');
  api.prayerRender(box);
  assert.ok(box.innerHTML.length > 0, 'must render something');
  assert.ok(/tb-next/.test(box.innerHTML), 'next prayer must be highlighted');
});

test('prayer: cached data for today renders without network', () => {
  const { api, fetchCalls } = loadToolbar();
  const day = new Date();
  const key = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
  api.lsSet('prayer', { at: Date.now(), day: key, city: 'Amman', t: { fajr: new Date().toISOString() } });
  const box = makeEl('tbBody');
  api.prayerRender(box);
  assert.equal(fetchCalls.length, 0, 'no refetch when data is current');
});

test('prayer: fetch goes through the same-origin proxy with islamabad coords', () => {
  const { api, fetchCalls } = loadToolbar({
    fetch: async () => ({ json: async () => ({ tz: 'Asia/Karachi', t: { fajr: Date.now() } }) })
  });
  api.fetchPrayer(makeEl('tbBody'));
  assert.equal(fetchCalls.length, 1, 'exactly one request when the proxy answers');
  assert.ok(/\/api\/prayer/.test(fetchCalls[0]), 'uses the same-origin proxy route');
  assert.ok(/lat=33\.6844/.test(fetchCalls[0]), 'islamabad latitude');
  assert.ok(/lon=73\.0479/.test(fetchCalls[0]), 'islamabad longitude');
});

test('prayer: direct aladhan fallback normalizes capitalized keys to lowercase', async () => {
  const { api } = loadToolbar({
    fetch: async (u) => {
      if (/\/api\/prayer/.test(u)) throw new Error('proxy down');
      return { json: async () => ({ data: { meta: { timezone: 'Asia/Karachi' }, timings: { Fajr: '05:14', Sunrise: '06:30', Dhuhr: '12:00', Asr: '15:00', Maghrib: '17:45', Isha: '18:59' } } }) };
    }
  });
  api.prayerRender(makeEl('tbBody'));
  await new Promise(r => setTimeout(r, 30));
  const c = api.lsGet('prayer', null);
  assert.ok(c && c.t, 'prayer stored after fallback');
  assert.ok(c.t.fajr, 'fajr stored lowercase (not Fajr)');
  assert.ok(c.t.maghrib, 'maghrib stored lowercase');
  const box = makeEl('tbBody');
  api.prayerRender(box);
  assert.ok(/الفجر/.test(box.innerHTML), 'fajr row rendered from lowercase key');
});

test('city: default is islamabad for weather and prayers', () => {
  const { api } = loadToolbar();
  assert.equal(api.getCity().lat, 33.6844);
  assert.equal(api.getCity().lon, 73.0479);
  assert.ok(/إسلام آباد/.test(api.getCity().name), 'name is arabic islamabad');
});

/* ==================================================================== الطقس */
test('weather: renders cached readings and marks them stale', () => {
  const { api } = loadToolbar();
  api.lsSet('weather', {
    at: Date.now() - 40 * 60 * 1000, /* أقدم من TTL */
    code: 61, t: 18, wind: 12, city: 'Amman', tmin: 11, tmax: 20
  });
  const box = makeEl('tbBody');
  api.weatherRender(box);
  assert.ok(/18°/.test(box.innerHTML), 'temperature shown');
  assert.ok(/Amman/.test(box.innerHTML), 'city shown');
});

test('weather: no cached data triggers exactly one fetch', () => {
  const { api, fetchCalls } = loadToolbar();
  const box = makeEl('tbBody');
  api.weatherRender(box);
  assert.equal(fetchCalls.length, 1);
  assert.ok(/open-meteo/.test(fetchCalls[0]), 'uses open-meteo');
});

test('weather: geolocation override changes the coordinates used', () => {
  const { api, fetchCalls } = loadToolbar();
  api.setCity({ lat: 31.9, lon: 35.9, name: 'Test' });
  api.fetchWeather(makeEl('tbBody'));
  assert.ok(/latitude=31\.9/.test(fetchCalls[0]));
  assert.ok(/longitude=35\.9/.test(fetchCalls[0]));
});

/* ================================================================ اللغات */
test('languages: three locales, each with its own direction', () => {
  const { api } = loadToolbar();
  const s = loadToolbar().ctx.window.__tbStrings;
  assert.deepEqual(Object.keys(s).sort(), ['ar', 'en', 'ur']);
  assert.equal(s.ar.dir, 'rtl');
  assert.equal(s.ur.dir, 'rtl');
  assert.equal(s.en.dir, 'ltr');
  for (const k of Object.keys(s)) {
    for (const t of ['weather', 'clock', 'cal', 'calc', 'tr', 'prayer']) {
      assert.ok(s[k][t], k + '.' + t + ' must exist');
    }
  }
});

test('languages: preference persists and rejects unknown codes', () => {
  const { api } = loadToolbar();
  api.setLang('en');
  assert.equal(api.getLang(), 'en');
  api.setLang('xx');
  assert.equal(api.getLang(), 'en', 'unknown code must not change language');
});

/* ================================================================ العزل */
test('isolation: toolbar never touches the app database keys', () => {
  const { store } = loadToolbar();
  api_setLang(store);
  function api_setLang(s) {
    const w = {};
    const ctx = { window: {}, document: { readyState: 'loading', addEventListener() {} },
      localStorage: s, Intl, Date, Math, JSON, console, setTimeout() {}, setInterval() {},
      fetch: () => Promise.reject(new Error('x')), navigator: {} };
    ctx.window = ctx; vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    ctx.window.__tb.setLang('en');
  }
  const keys = Object.keys(store._dump());
  assert.ok(keys.length > 0, 'it does write its own state');
  for (const k of keys) {
    assert.ok(k.indexOf('nibras_tb_v1_') === 0, 'all keys namespaced, found: ' + k);
    assert.ok(k.indexOf('nibras_boys_db_v1') === -1, 'must not touch app db: ' + k);
  }
});

/* ============================================================== الملفات */
test('files: toolbar is wired into index.html (نظام البنين بلا Service Worker)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/<link rel="stylesheet" href="toolbar\.css\?v=\d+">/.test(html), 'css linked with a version');
  assert.ok(/<script src="toolbar\.js\?v=\d+"><\/script>/.test(html),
    'js must NOT be deferred: defer races the app render and can leave it unstyled');
  assert.ok(!fs.existsSync(path.join(ROOT, 'public', 'sw.js')),
    'no sw.js in boys — التحديثات تصل مباشرة ولا كاش قديم');
  assert.ok(!/serviceWorker\.register/.test(html),
    'no service worker registration in the app html (التنظيف أعلى الصفحة لا يسجّل شيئاً)');
  assert.ok(!/sw\.js/.test(html),
    'html must not reference the removed service worker');
});

test('boot: the icon strip is actually mounted on a live DOM, not just on paper', () => {
  const t = loadToolbar();
  assert.ok(t.ctx.window.__tbState, 'state flag must exist: loaded / painted / error');
  assert.equal(t.ctx.window.__tbState, 'painted', 'must reach painted state');
  const root = t.doc.body.children.find(c => c.id === 'nibrasToolbar');
  assert.ok(root, 'root must be appended to body');
  assert.ok(/tb-side/.test(root.innerHTML), 'the icon strip must be rendered');
  assert.equal((root.innerHTML.match(/tb-side-i/g) || []).length, 6,
    'all six tool icons must be shown on the strip');
  for (const id of ['w', 'c', 'd', 'k', 't', 'p']) {
    assert.ok(root.innerHTML.indexOf('data-tab="' + id + '"') > -1, 'icon missing tab: ' + id);
  }
  /* critical styles must be inline: the strip has to be visible even if the
   * stylesheet never loads, which is how it silently disappeared before. */
  const inline = root.getAttribute('style') || '';
  assert.ok(/position:fixed/.test(inline),
    'root must carry inline positioning, not rely on the stylesheet');
  assert.ok(/z-index/.test(inline), 'root must raise itself inline');
  assert.ok(/width:46px/.test(root.innerHTML), 'icons must size themselves inline');
  assert.ok(/border-radius:10px/.test(root.innerHTML), 'icons must stay shaped inline');
});

test('boot: clicking an icon opens the panel with its body', () => {
  const t = loadToolbar();
  const root = t.doc.body.children.find(c => c.id === 'nibrasToolbar');
  fire(root, 'click', { target: { getAttribute: k => (k === 'data-tab' ? 'c' : null) } });
  const root2 = t.doc.body.children.filter(c => c.id === 'nibrasToolbar').pop();
  assert.ok(/tbPanel/.test(root2.innerHTML), 'panel must be rendered after clicking an icon');
  assert.ok(/tbBody/.test(root2.innerHTML), 'panel must have a body container');
  assert.ok(/tb-side/.test(root2.innerHTML), 'the icon strip must stay mounted next to the panel');
  assert.equal((root2.innerHTML.match(/tb-side-i/g) || []).length, 6,
    'all six icons remain visible while the panel is open');
});

test('boot: icons are laid out in two rows of three (3x2 grid)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'toolbar.css'), 'utf8');
  assert.ok(/\.tb-side\{/.test(css), 'the strip must have its own class');
  assert.ok(/grid-template-columns:repeat\(3,1fr\)/.test(css),
    'css must arrange the six icons in two rows of three');
  assert.ok(/repeat\(3,1fr\)/.test(css.split('\n').find(l => l.indexOf('.tb-side') > -1) || ''),
    'the 3-column grid belongs to the strip rule');
});

test('boot: docks under the presence widget when it appears, returns to floating when gone', () => {
  const dock = makeEl('nibrasToolbarDock');
  const { api, doc } = loadToolbar({ dockEl: dock });
  const root = doc.body.children.find(c => c.id === 'nibrasToolbar');
  assert.ok(root, 'boots floating on body');
  assert.ok(!/tb-docked/.test(root.className), 'no docked class before the widget exists');
  assert.ok(/position:fixed/.test(root.getAttribute('style') || ''), 'floating uses fixed inline');

  /* الصفحة رُسمت، بطاقة المتواجدون ظهرت، فأرست page الشريط تحتها */
  api.redock();
  assert.ok(dock.children.some(c => c.id === 'nibrasToolbar'), 'strip moved under the widget');
  assert.ok(/tb-docked/.test(root.className), 'docked class applied');
  assert.ok(!/position:fixed/.test(root.getAttribute('style') || ''), 'fixed inline removed when docked');

  /* الإطالة: بقي المرسى نفسه فلا نعيد الرسم (لا تُصفّر لوحة المترجم) */
  dock.children.length = 0; dock.appendChild(root);
  const before = root.innerHTML;
  api.redock();
  assert.equal(root.innerHTML, before, 'no repaint when the dock is already in place');
});

test('boot: docked strip is themed to the navy sidebar, not stark white', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'toolbar.css'), 'utf8');
  const i = css.indexOf('.tb-root.tb-docked{');
  assert.ok(i >= 0, 'docked rule must exist');
  const blk = css.slice(i);
  assert.ok(/--tb-bg:#122f52/.test(blk), 'docked palette is navy');
  assert.ok(/--tb-fg:#eef4fd/.test(blk), 'docked text is light');
  assert.ok(/rgba\(255,255,255,\.07\)/.test(blk), 'strip bg is translucent, not solid white');
  assert.ok(/border-top:2px solid var\(--blue/.test(blk), 'strip shares the navy accent line');
});

test('boot: switching to each service tab renders its content', () => {
  const t = loadToolbar();
  const root = t.doc.body.children.find(c => c.id === 'nibrasToolbar');
  for (const id of ['w', 'c', 'd', 'k', 't', 'p']) {
    fire(root, 'click', { target: { getAttribute: k => (k === 'data-tab' ? id : null) } });
    const cur = t.doc.body.children.filter(c => c.id === 'nibrasToolbar').pop();
    assert.ok(cur.innerHTML.length > 0, 'tab ' + id + ' rendered nothing');
  }
});

test('boot: the six services are all registered with a renderer', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'toolbar.js'), 'utf8');
  const m = /var TABS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, 'TABS array must exist');
  const rows = m[1].match(/\{\s*id:\s*'([a-z])'[^}]*run:/g) || [];
  assert.equal(rows.length, 6, 'six services registered');
  assert.deepEqual(rows.map(r => /id:\s*'([a-z])'/.exec(r)[1]).sort(), ['c', 'd', 'k', 'p', 't', 'w']);
});

test('boot: failures surface instead of failing silently', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'toolbar.js'), 'utf8');
  assert.ok(/function fail\(/.test(src), 'a fail() reporter must exist');
  /* init must be guarded, and boot must be wrapped */
  assert.ok(/if\s*\(!document\.body\)/.test(src), 'missing body must be reported');
  assert.ok(/try\s*\{\s*paint\(\);/.test(src), 'paint must be wrapped in try/catch');
  assert.ok(/catch\s*\(e\)\s*\{\s*fail\('boot:/.test(src), 'boot must report its own failure');
});

test('files: toolbar.js contains no eval or Function constructor', () => {
  const hits = SRC.match(/\beval\s*\(|new\s+Function\s*\(/g);
  assert.equal(hits, null, 'CSP-safe: ' + (hits || []).join(','));
});

test('files: encoding is clean (no CJK, no replacement chars)', () => {
  const bad = SRC.match(/[\u4e00-\u9fff\uFFFD]/g);
  assert.equal(bad, null, 'mojibake: ' + (bad || []).join(''));
});