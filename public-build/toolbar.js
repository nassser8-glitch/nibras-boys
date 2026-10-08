/* =============================================================================
 * نبراس — شريط الأدوات: طقس، ساعة عالمية، تقويم، حاسبة، مترجم، مواقيت صلاة
 * -----------------------------------------------------------------------------
 * ملف مستقل تماماً: لا يعدّل أي دالة في التطبيق ولا يمسّ تخزينه المحلي
 * إلا بمفاتيحه الخاصة به. الغرض أن يبقى فشل أي جزء معزولاً عن المنظومة.
 *
 * المبادئ:
 *  • لا eval ولا Function: محلّل الحاسبة مكتوب يدوياً تفادياً لقيود CSP.
 *  • كل خدمة تحفظ نتيجتها في cacheTTL؛ بلا إنترنت يعرض آخر قيمة محفوظة
 *    مع تاريخها بدل شاشة فارغة.
 *  • اتجاه النص يتبع لغة اللوحة فقط، ولا نلمس dir الخاص بالتطبيق حتى لا
 *    ينكسر تخطيط الواجهة القائمة.
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__tbLoaded) return;
  window.__tbLoaded = true;

  /* ---------------------------------------------------------------- التخزين */
  var P = 'nibras_tb_v1_';
  function lsGet(k, d) { try { var v = localStorage.getItem(P + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------------ واللغات
   * ar = العربية، en = English، jo = لهجة أردنية شامية.
   * jo ليست لغة مستقلة في المترجم: هي عربية تُمرَّر بطبقة لهجة في النهاية. */
  var LANGS = {
    ar: { dir: 'rtl', label: 'عربي',  weather: 'الطقس',   clock: 'الساعة',  cal: 'التقويم', calc: 'الحاسبة', tr: 'المترجم', prayer: 'الصلاة' },
    en: { dir: 'ltr', label: 'English', weather: 'Weather', clock: 'Clock',  cal: 'Calendar', calc: 'Calculator', tr: 'Translate', prayer: 'Prayer' },
    jo: { dir: 'rtl', label: 'أردني',  weather: 'الجو',     clock: 'الساعة',  cal: 'التقويم', calc: 'الحاسبة', tr: 'المترجم', prayer: 'الصلاة' }
  };
  function L() { var c = lsGet('lang', 'ar'); return LANGS[c] ? c : 'ar'; }
  function setLang(c) { if (!LANGS[c]) return; lsSet('lang', c); paint(); }
  function T(k) { var m = LANGS[L()]; return m[k] || k; }

  /* ------------------------------------------------------- متغيرات وق Buhota */
  var CITY = { lat: 31.9454, lon: 35.9284, name: 'Amman' }; /* عمّان افتراضياً */
  var WMO = {
    0: ['☀️', 'clear'], 1: ['🌤', 'mostly clear'], 2: ['⛅', 'partly cloudy'], 3: ['☁️', 'overcast'],
    45: ['🌫', 'fog'], 48: ['🌫', 'rime fog'], 51: ['🌦', 'light drizzle'], 53: ['🌦', 'drizzle'],
    55: ['🌧', 'dense drizzle'], 56: ['🌧', 'freezing drizzle'], 57: ['🌧', 'freezing drizzle'],
    61: ['🌦', 'light rain'], 63: ['🌧', 'rain'], 65: ['🌧', 'heavy rain'],
    66: ['🌧', 'freezing rain'], 67: ['🌧', 'freezing rain'],
    71: ['🌨', 'light snow'], 73: ['❄️', 'snow'], 75: ['❄️', 'heavy snow'], 77: ['❄️', 'snow grains'],
    80: ['🌦', 'rain showers'], 81: ['🌧', 'rain showers'], 82: ['⛈', 'violent showers'],
    85: ['🌨', 'snow showers'], 86: ['❄️', 'snow showers'],
    95: ['⛈', 'thunderstorm'], 96: ['⛈', 'thunderstorm w/ hail'], 99: ['⛈', 'severe thunderstorm']
  };
  var WMO_AR = {
    0: 'صحو', 1: 'صحو غالباً', 2: 'غائم جزئياً', 3: 'غائم', 45: 'ضباب', 48: 'ضباب جليدي',
    51: 'رذاذ خفيف', 53: 'رذاذ', 55: 'رذاذ كثيف', 56: 'رذاذ متجمد', 57: 'رذاذ متجمد',
    61: 'مطر خفيف', 63: 'مطر', 65: 'مطر غزير', 66: 'مطر متجمد', 67: 'مطر متجمد',
    71: 'ثلج خفيف', 73: 'ثلج', 75: 'ثلج كثيف', 77: 'حبيبات ثلج',
    80: 'زخات مطر', 81: 'زخات مطر', 82: 'زخات شديدة', 85: 'زخات ثلج', 86: 'زخات ثلج',
    95: 'عاصفة رعدية', 96: 'رعد مع برَد', 99: 'عاصفة رعدية شديدة'
  };

  /* =========================================================== 1) الطقس */
  var W_TTL = 30 * 60 * 1000;
  function weatherRender(box) {
    var c = lsGet('weather', null);
    if (!c) { box.innerHTML = '<div class="tb-muted">' + T('weather') + ' — …</div>'; fetchWeather(box); return; }
    var fresh = Date.now() - c.at < W_TTL;
    var w = WMO[c.code] || ['🌡', '—'];
    var desc = L() === 'en' ? w[1] : (WMO_AR[c.code] || w[1]);
    box.innerHTML =
      '<div class="tb-w"><div class="tb-w-ico">' + w[0] + '</div><div>' +
      '<div class="tb-w-t">' + Math.round(c.t) + '°</div>' +
      '<div class="tb-w-d">' + esc(desc) + '</div>' +
      '<div class="tb-w-m">' + esc(c.city) + ' · ' + Math.round(c.tmin) + '° / ' + Math.round(c.tmax) + '° · ' +
      esc(c.wind) + ' km/h</div>' +
      (fresh ? '' : '<div class="tb-w-old">' + (L() === 'en' ? 'cached' : 'محفوظة') + '</div>') +
      '</div></div>';
    if (fresh) return;
    fetchWeather(box);
  }
  function fetchWeather(box) {
    fetch('https://api.open-meteo.com/v1/forecast?latitude=' + CITY.lat + '&longitude=' + CITY.lon +
      '&current=temperature_2m,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.current) throw new Error('bad payload');
        var c = {
          at: Date.now(), code: j.current.weather_code, t: j.current.temperature_2m,
          wind: j.current.wind_speed_10m, city: CITY.name,
          tmin: j.daily.temperature_2m_min[0], tmax: j.daily.temperature_2m_max[0]
        };
        lsSet('weather', c); if (box && box.isConnected) weatherRender(box);
      })
      .catch(function () { if (box && box.isConnected && !lsGet('weather', null)) box.innerHTML = '<div class="tb-muted">—</div>'; });
  }

  /* ================================================== 2) الساعة العالمية */
  var ZONES = [
    ['Amman', 'Asia/Amman'], ['Riyadh', 'Asia/Riyadh'], ['Cairo', 'Africa/Cairo'],
    ['Dubai', 'Asia/Dubai'], ['Istanbul', 'Europe/Istanbul'], ['London', 'Europe/London'],
    ['Paris', 'Europe/Paris'], ['New York', 'America/New_York'], ['Tokyo', 'Asia/Tokyo']
  ];
  function fmtZone(tz) {
    try {
      return new Intl.DateTimeFormat(L() === 'en' ? 'en-GB' : 'ar-JO', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      }).format(new Date());
    } catch (e) { return '--:--'; }
  }
  function clockRender(box) {
    var rows = ZONES.map(function (z) {
      return '<div class="tb-row"><span class="tb-k">' + esc(z[0]) + '</span><span class="tb-v">' + fmtZone(z[1]) + '</span></div>';
    }).join('');
    box.innerHTML = rows;
  }

  /* ================================================== 3) التقويم (هجري/ميلادي) */
  var calRef = null;
  function hijri(y, m, d) {
    try {
      var dt = new Date(Date.UTC(y, m, d));
      var f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn',
        { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' }).formatToParts(dt);
      var o = {};
      f.forEach(function (p) { if (p.type !== 'literal') o[p.type] = +p.value; });
      return o;
    } catch (e) { return null; }
  }
  var AR_MONTHS = ['محرم', 'صفر', 'ربيع الأول', 'ربيع الآخر', 'جمادى الأولى', 'جمادى الآخرة',
    'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'];
  var EN_MONTHS = ['Muharram', 'Safar', "Rabi' al-Awwal", "Rabi' al-Thani", 'Jumada al-Ula', 'Jumada al-Akhirah',
    'Rajab', "Sha'ban", 'Ramadan', 'Shawwal', "Dhu al-Qi'dah", 'Dhu al-Hijjah'];
  var EN_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var AR_DOW = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
  var AR_DOW_SHORT = ['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س'];

  function calRender(box) {
    if (!calRef) calRef = new Date();
    var r = calRef, y = r.getFullYear(), m = r.getMonth();
    var first = new Date(y, m, 1), lead = first.getDay(), days = new Date(y, m + 1, 0).getDate();
    var today = new Date();
    var isToday = today.getFullYear() === y && today.getMonth() === m;
    var en = L() === 'en';
    var mn = en ? EN_MONTHS[m] : AR_MONTHS[m];
    var head = '<div class="tb-cal-head">' +
      '<button class="tb-btn" data-cal="-1">‹</button>' +
      '<span>' + esc(mn) + ' ' + y + '</span>' +
      '<button class="tb-btn" data-cal="1">›</button></div>';
    var dow = (en ? EN_DOW : AR_DOW_SHORT).map(function (d) { return '<span class="tb-dow">' + esc(d) + '</span>'; }).join('');
    var cells = '';
    for (var i = 0; i < lead; i++) cells += '<span></span>';
    var hy = 0, hm = 0, hd = 0;
    for (var d = 1; d <= days; d++) {
      var h = hijri(y, m, d);
      var sub = '';
      if (h) {
        if (d === 1) { hy = h.year; hm = h.month; }
        hd = h.day; sub = '<i>' + hd + '</i>';
      }
      var isT = isToday && d === today.getDate();
      cells += '<span class="tb-day' + (isT ? ' tb-today' : '') + '">' + d + sub + '</span>';
    }
    var hLine = h = hijri(y, m, 1);
    var htxt = h ? ((en ? EN_MONTHS[h.month - 1] : AR_MONTHS[h.month - 1]) + ' ' + h.year + ' هـ') : '';
    box.innerHTML = head + '<div class="tb-dows">' + dow + '</div><div class="tb-grid">' + cells + '</div>' +
      '<div class="tb-cal-f">' + esc(htxt) + '</div>';
  }
  function calMove(d) { if (!calRef) calRef = new Date(); calRef = new Date(calRef.getFullYear(), calRef.getMonth() + d, 1); }

  /* ============================================================= 4) الحاسبة */
  function calcEval(src) {
    /* محلّل infix كامل الأولويات، بلا eval. يعيد NaN عند أي مدخل غريب. */
    var toks = String(src).match(/(\d+\.?\d*|\.\d+|[+\-*/%()^])/g);
    if (!toks) return NaN;
    var pos = 0;
    function peek() { return toks[pos]; }
    function eat(t) { if (toks[pos] === t) { pos++; return true; } return false; }
    function primary() {
      var t = toks[pos];
      if (eat('(')) { var v = expr(); if (!eat(')')) throw 0; return v; }
      if (t === undefined || !/^[\d.]/.test(t)) throw 0;
      pos++; return parseFloat(t);
    }
    /* الأُس يرتبط لليمين: 2^3^2 = 2^(3^2) = 512 لا (2^3)^2 = 64،
     * فنستدعي النصف الثاني مكرراً بدل حلقة مسطّحة. */
    function power() {
      var b = primary();
      if (peek() === '^') { pos++; return Math.pow(b, unary()); }
      return b;
    }
    /* السالب يسبق الأُس: -2^2 = -(2^2) = -4 لا 4،
     * فنضع الإشارة خارج قوة الأس لا داخل أساسها. */
    function unary() {
      if (eat('-')) return -power();
      if (eat('+')) return unary();
      return power();
    }
    function term() {
      var v = unary();
      for (;;) {
        var t = peek();
        if (t === '*') { pos++; v *= unary(); }
        else if (t === '/') { pos++; var d = unary(); if (d === 0) throw 0; v /= d; }
        else if (t === '%') { pos++; var m = unary(); if (m === 0) throw 0; v %= m; }
        else return v;
      }
    }
    function expr() {
      var v = term();
      for (;;) {
        if (eat('+')) v += term();
        else if (eat('-')) v -= term();
        else return v;
      }
    }
    try {
      var out = expr();
      if (pos !== toks.length) return NaN;
      return out;
    } catch (e) { return NaN; }
  }
  function calcRender(box, seed) {
    if (seed != null) lsSet('calc', String(seed));
    var v = lsGet('calc', '');
    box.innerHTML =
      '<div class="tb-calc-out" id="tbCalcOut">' + esc(v || '0') + '</div>' +
      '<div class="tb-calc-pad">' +
      ['C', '(', ')', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '0', '.', '⌫', '=']
        .map(function (k) {
          return '<button class="tb-key' + (k === '=' ? ' tb-eq' : '') + '" data-key="' + esc(k) + '">' + k + '</button>';
        }).join('') +
      '</div>';
  }
  var CALC_SYM = { '÷': '/', '×': '*', '−': '-' };
  function calcKey(box, k) {
    var v = String(lsGet('calc', ''));
    if (k === 'C') v = '';
    else if (k === '⌫') v = v.slice(0, -1);
    else if (k === '=') {
      var r = calcEval(v);
      var s = (isFinite(r) ? (Math.round(r * 1e10) / 1e10) + '' : '—');
      lsSet('calc', s);
      calcRender(box);
      return;
    } else v += (CALC_SYM[k] || k);
    lsSet('calc', v);
    calcRender(box);
  }

  /* ============================================================ 5) المترجم */
  /* قاموس مدرسي صغير يعمل بلا إنترنت؛ وعند توفّره يُستشار MyMemory للترجمة
   * الكاملة. «الأردني» طبقة لهجة فوق العربية لا لغة منفصلة. */
  var DICT_EN_AR = {
    'hello': 'مرحبا', 'hi': 'أهلا', 'good morning': 'صباح الخير', 'goodbye': 'مع السلامة',
    'school': 'مدرسة', 'student': 'طالب', 'students': 'طلاب', 'teacher': 'معلم', 'teachers': 'معلمين',
    'admin': 'مدير', 'principal': 'مدير', 'manager': 'مدير', 'class': 'صف', 'grade': 'صف',
    'attendance': 'حضور', 'absence': 'غياب', 'absent': 'غائب', 'present': 'حاضر', 'late': 'تأخر',
    'grade/a': 'درجة', 'exam': 'امتحان', 'exams': 'امتحانات', 'homework': 'واجب', 'notes': 'ملاحظات',
    'note': 'ملاحظة', 'points': 'نقاط', 'point': 'نقطة', 'warning': 'إنذار', 'praise': 'شكر',
    'message': 'رسالة', 'messages': 'رسائل', 'transfer': 'تحويل', 'transfers': 'تحويلات',
    'delete': 'حذف', 'edit': 'تعديل', 'save': 'حفظ', 'cancel': 'إلغاء', 'close': 'إغلاق',
    'add': 'إضافة', 'new': 'جديد', 'search': 'بحث', 'filter': 'تصفية', 'report': 'تقرير',
    'reports': 'تقارير', 'settings': 'إعدادات', 'logout': 'خروج', 'login': 'دخول', 'password': 'كلمة المرور',
    'username': 'اسم المستخدم', 'today': 'اليوم', 'tomorrow': 'غداً', 'yesterday': 'أمس', 'week': 'أسبوع',
    'month': 'شهر', 'year': 'سنة', 'day': 'يوم', 'date': 'تاريخ', 'time': 'وقت', 'now': 'الآن',
    'weather': 'الطقس', 'prayer': 'الصلاة', 'calendar': 'تقويم', 'thank you': 'شكرا',
    'good': 'جيد', 'bad': 'سيء', 'important': 'مهم', 'follow up': 'قيد المتابعة', 'low': 'منخفضة',
    'medium': 'متوسطة', 'high': 'عالية', 'pending': 'قيد الانتظار', 'authority': 'الجهة المعنية'
  };
  var DICT_AR_EN = {};
  Object.keys(DICT_EN_AR).forEach(function (k) { DICT_AR_EN[DICT_EN_AR[k]] = k; });

  /* طبقة اللهجة الأردنية: العربية الفصحى ← لهجة أردنية شامية.
   * القواعد مطبَّقة بالترتيب: الأطول أولاً حتى لا يبتلع «كيف» جذرَ «كيفك».
   *  1) صيغ الحوار: «كيف حالك» ← «كيفك»، «ما عندك» ← «ماعندك».
   *  2) أدوات الجواب: «نعم/لا» ← «إي/لا».
   *  3) ضمائر المخاطبة: التاء المربوطة ← الهاء عند المنادىMale.
   *  4) التحول إلى المضارع الشاميiah: ستقبل ← «رح»، ستذهب ← «رح تروح». */
  var JO_RULES = [
    /* صيغ مركّبة قبل المفردات */
    ['كيف حالك', 'كيفك'], ['كيف الحال', 'كيفك'], ['ما عندك', 'ماعندك'], ['ما في داعي', 'مافي داعي'],
    ['بإذن الله', 'إن شاء الله'], ['أريدك', 'بديك'], ['أريد', 'بدي'], ['أرسل', 'ابعت'],
    ['يجب أن', 'لازم'], ['فقط', 'بس'], ['كثيراً', 'كتير'], ['قليلاً', 'شوي'], ['جداً', 'كتير'],
    ['الآن', 'هلق'], ['غداً', 'بكرا'], ['أمس', 'امبارح'], ['متى', 'إمتى'], ['أين', 'وين'],
    ['ماذا', 'شو'], ['من', 'مين'], ['نعم', 'إي'], ['أجل', 'إي'],
    ['حسناً', 'ماشي'], ['حسنًا', 'ماشي'], ['أوكي', 'ماشي'], ['تمام', 'ماشي'], ['هيا', 'يلا'],
    ['من فضلك', 'لو سمحت'], ['انظر', 'شوف'], ['انظري', 'شوفي'], ['تكلم', 'احكي'],
    ['اذهب', 'روح'], ['اذهبي', 'روحي'], ['أنت', 'إنت'], ['نحن', 'إحنا']
  ];
  function toJordanian(s) {
    var out = String(s == null ? '' : s);
    if (!out.trim()) return out;
    JO_RULES.forEach(function (r) {
      if (!r[0] || r[1] === '' || r[0] === r[1]) return;
      if (out.indexOf(r[0]) === -1) return;
      out = out.split(r[0]).join(r[1]);
    });
    /* التاء المربوطة في آخر الكلمة تصير هاء عند المخاطبة الشامية.
     * لا نستعمل \b هنا: حدود الكلمة في JS مبنية على [A-Za-z0-9_] فقط،
     * وحرف التاء المربوطة خارجها، فلا يتحقق \b أبداً بعده. */
    return out.replace(/ة(?=$|[\s.,،!؟;:؛()\[\]])/g, 'ه');
  }

  function trDict(src, from, to) {
    var t = String(src).trim().toLowerCase();
    if (!t) return '';
    if (from === 'en' && to === 'ar') return DICT_EN_AR[t] || '';
    if (from === 'ar' && to === 'en') return DICT_AR_EN[t] || '';
    if (from === 'ar' && to === 'jo') return toJordanian(t);
    if (from === 'en' && to === 'jo') {
      var a = DICT_EN_AR[t];
      return a ? toJordanian(a) : '';
    }
    return '';
  }
  function trRemote(src, from, to) {
    var pair = from + '|' + to;
    var q = encodeURIComponent(src);
    return fetch('https://api.mymemory.translated.net/get?q=' + q + '&langpair=' + encodeURIComponent(pair))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var t = j && j.responseData && j.responseData.translatedText;
        if (!t || /MYMEMORY WARNING|INVALID/i.test(String(t))) throw new Error('no translation');
        return String(t);
      });
  }
  function trRender(box) {
    var from = lsGet('tr_from', 'ar'), to = lsGet('tr_to', 'en');
    var out = lsGet('tr_out', '');
    var src = lsGet('tr_in', '');
    var names = { ar: 'عربي', en: 'English', jo: 'أردني' };
    var opts = ['ar', 'en', 'jo'].map(function (k) {
      return '<option value="' + k + '"' + (k === from ? ' selected' : '') + '>' + names[k] + '</option>';
    }).join('');
    var opts2 = ['ar', 'en', 'jo'].map(function (k) {
      return '<option value="' + k + '"' + (k === to ? ' selected' : '') + '>' + names[k] + '</option>';
    }).join('');
    box.innerHTML =
      '<div class="tb-tr-sel"><select id="tbTrFrom" class="tb-inp">' + opts + '</select>' +
      '<button class="tb-btn" id="tbTrSwap" title="swap">⇄</button>' +
      '<select id="tbTrTo" class="tb-inp">' + opts2 + '</select></div>' +
      '<textarea id="tbTrIn" class="tb-inp tb-area" placeholder="' + (from === 'ar' ? 'اكتب النص…' : 'Type here…') + '">' + esc(src) + '</textarea>' +
      '<button class="tb-btn tb-go" id="tbTrGo">' + esc(L() === 'en' ? 'Translate' : 'ترجمة') + '</button>' +
      '<div class="tb-tr-out" id="tbTrOut">' + (out ? esc(out) : '') + '</div>' +
      (from === 'jo' || to === 'jo' ? '<div class="tb-muted">' + esc(L() === 'en' ? 'Jordanian dialect' : 'لهجة أردنية') + '</div>' : '');
  }
  function trGo(box) {
    var src = String(lsGet('tr_in', '')).trim();
    if (!src) return;
    var from = lsGet('tr_from', 'ar'), to = lsGet('tr_to', 'en');
    var d = trDict(src, from, to);
    if (d) { lsSet('tr_out', d); trRender(box); return; }
    if (from === 'ar' && to === 'jo') { lsSet('tr_out', src); trRender(box); return; }
    box.querySelector('#tbTrOut').textContent = '…';
    trRemote(src, from, to).then(function (t) {
      var fin = to === 'jo' ? toJordanian(t) : t;
      lsSet('tr_out', fin); trRender(box);
    }).catch(function () {
      lsSet('tr_out', ''); trRender(box);
      var o = box.querySelector('#tbTrOut');
      if (o) o.textContent = L() === 'en' ? 'no translation available' : 'لا ترجمة متاحة';
    });
  }

  /* ==================================================== 6) مواقيت الصلاة */
  var P_TTL = 12 * 60 * 60 * 1000;
  var P_KEY = { fajr: 'الفجر', sunrise: 'الشروق', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء' };
  var P_EN = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
  function todayKey() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function prayerRender(box) {
    var c = lsGet('prayer', null);
    if (!c || c.day !== todayKey()) { box.innerHTML = '<div class="tb-muted">' + esc(T('prayer')) + ' — …</div>'; fetchPrayer(box); return; }
    var en = L() === 'en';
    var names = en ? P_EN : P_KEY;
    var now = new Date(), nx = null, nxName = '';
    var order = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
    order.forEach(function (k) {
      var t = c.t[k];
      if (!t) return;
      if (new Date(t) > now && !nx) { nx = t; nxName = names[k]; }
    });
    box.innerHTML = order.map(function (k) {
      if (!c.t[k]) return '';
      var on = (nx === c.t[k]) ? ' tb-next' : '';
      return '<div class="tb-row' + on + '"><span class="tb-k">' + esc(names[k]) + '</span><span class="tb-v">' +
        esc(c.t[k].slice(11, 16)) + '</span></div>';
    }).join('') +
      (nx ? '<div class="tb-muted">' + (en ? 'next: ' : 'القادم: ') + esc(nxName) + '</div>' : '') +
      (en ? '' : '<div class="tb-muted">' + esc(c.city) + '</div>');
  }
  function fetchPrayer(box) {
    var u = 'https://api.aladhan.com/v1/timings?latitude=' + CITY.lat + '&longitude=' + CITY.lon + '&method=4';
    fetch(u).then(function (r) { return r.json(); }).then(function (j) {
      var t = j && j.data && j.data.timings;
      if (!t) throw new Error('bad');
      var day = todayKey(), o = { at: Date.now(), day: day, city: CITY.name, t: {} };
      Object.keys(t).forEach(function (k) {
        var parts = String(t[k]).split(' ');
        if (!parts[0]) return;
        var iso = day + 'T' + parts[0] + ':00';
        o.t[k] = iso;
      });
      lsSet('prayer', o); if (box && box.isConnected) prayerRender(box);
    }).catch(function () {
      if (box && box.isConnected) {
        var c = lsGet('prayer', null);
        if (!c) box.innerHTML = '<div class="tb-muted">—</div>';
      }
    });
  }

  /* ============================================================== اللوحة */
  var TABS = [
    { id: 'w', ic: '🌤', run: weatherRender },
    { id: 'c', ic: '🕐', run: clockRender },
    { id: 'd', ic: '📅', run: calRender },
    { id: 'k', ic: '🧮', run: function (b) { calcRender(b); } },
    { id: 't', ic: '🌐', run: trRender },
    { id: 'p', ic: '🕌', run: prayerRender }
  ];
  var open = lsGet('open', false);
  var tab = lsGet('tab', 'w');
  var root = null;

  function panelHTML() {
    var body = '<div class="tb-body" id="tbBody"></div>';
    var tabs = TABS.map(function (t) {
      return '<button class="tb-tab' + (t.id === tab ? ' tb-on' : '') + '" data-tab="' + t.id + '" title="' + esc(T(t.id)) + '">' + t.ic + '</button>';
    }).join('');
    var langs = ['ar', 'en', 'jo'].map(function (k) {
      return '<button class="tb-lang' + (L() === k ? ' tb-on' : '') + '" data-lang="' + k + '">' + esc(LANGS[k].label) + '</button>';
    }).join('');
    return '<div class="tb-panel" id="tbPanel" dir="' + LANGS[L()].dir + '" lang="' + L() + '">' +
      '<div class="tb-top"><span class="tb-title">' + esc(T(tab)) + '</span>' +
      '<span class="tb-langs">' + langs + '</span>' +
      '<button class="tb-x" id="tbClose">×</button></div>' + tabs + body + '</div>';
  }
  function paint() {
    if (!root) return;
    if (!open) {
      root.className = 'tb-root';
      /* تنسيق حرج مضمّن في العنصر نفسه: لو لم يصل ملف CSS لظلت الأزرار
       * ظاهرة وموضوعة وظاهرة على الشاشة. الاعتماد على ورقة خارجية وحدها
       * كان يعني اختفاء الشريط كاملاً بصمت إن تأخر تحميلها أو حُجب. */
      root.setAttribute('style', 'position:fixed;z-index:2147483000;' +
        'inset:auto 16px 16px auto;display:block;line-height:0');
      root.innerHTML = '<button class="tb-fab" id="tbFab" aria-label="tools" ' +
        'style="display:flex;align-items:center;justify-content:center;' +
        'width:48px;height:48px;border-radius:50%;font-size:20px;cursor:pointer;' +
        'background:#fff;color:#16233a;border:1px solid #e3e9f2;' +
        'box-shadow:0 10px 30px rgba(16,32,64,.16);padding:0;margin:0">☰</button>';
      window.__tbState = 'painted';
      return;
    }
    root.className = 'tb-root tb-open';
    root.removeAttribute('style');
    root.innerHTML = panelHTML();
    var b = document.getElementById('tbBody');
    var cur = TABS.filter(function (t) { return t.id === tab; })[0] || TABS[0];
    cur.run(b);
    window.__tbState = 'painted';
  }
  function setTab(id) { tab = id; lsSet('tab', id); paint(); }

  function onClick(e) {
    var t = e.target;
    if (!t) return;
    if (t.id === 'tbFab') { open = true; lsSet('open', true); paint(); return; }
    if (t.id === 'tbClose') { open = false; lsSet('open', false); paint(); return; }
    if (t.getAttribute('data-tab')) { setTab(t.getAttribute('data-tab')); return; }
    if (t.getAttribute('data-lang')) { setLang(t.getAttribute('data-lang')); return; }
    var cal = t.getAttribute('data-cal');
    if (cal) { calMove(+cal); calRender(document.getElementById('tbBody')); return; }
    var key = t.getAttribute('data-key');
    if (key) { calcKey(document.getElementById('tbBody'), key); return; }
    if (t.id === 'tbTrGo') { trGo(document.getElementById('tbBody')); return; }
    if (t.id === 'tbTrSwap') {
      var a = lsGet('tr_from', 'ar'), b2 = lsGet('tr_to', 'en');
      lsSet('tr_from', b2); lsSet('tr_to', a);
      lsSet('tr_in', lsGet('tr_out', '')); lsSet('tr_out', '');
      trRender(document.getElementById('tbBody')); return;
    }
  }
  function onInput(e) {
    var t = e.target;
    if (!t) return;
    if (t.id === 'tbTrIn') lsSet('tr_in', t.value);
    if (t.id === 'tbTrFrom') lsSet('tr_from', t.value);
    if (t.id === 'tbTrTo') lsSet('tr_to', t.value);
  }
  function onKey(e) {
    if (!open || e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (tab !== 'k') return;
    var k = e.key;
    if (k >= '0' && k <= '9') { calcKey(document.getElementById('tbBody'), k); e.preventDefault(); }
    else if ('+-*/%()^.'.indexOf(k) > -1) { calcKey(document.getElementById('tbBody'), k); e.preventDefault(); }
    else if (k === 'Enter' || k === '=') { calcKey(document.getElementById('tbBody'), '='); e.preventDefault(); }
    else if (k === 'Backspace') { calcKey(document.getElementById('tbBody'), '⌫'); e.preventDefault(); }
    else if (k === 'Escape' || k === 'Delete') { calcKey(document.getElementById('tbBody'), 'C'); e.preventDefault(); }
  }

  /* ============================================================== التشغيل */
  function boot() {
    /* الموقع الجاهز فقط: لا نلمس DOM قبل أن تكون الصفحة قد رسمت نفسها. */
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); return; }
    init();
  }
  /* زر إنقاذ: إن فشل أي جزء أظهرناه بدل الصمت. صمتٌ بلا سبب هو ماضيّع
   * وقتاً طويلاً في تشخيص هذه الأداة، فكل خطأ يظهر الآن في اللوحة. */
  function fail(msg) {
    try {
      var d = document.createElement('div');
      d.id = 'nibrasToolbar';
      d.style.cssText = 'position:fixed;inset:auto 12px 12px auto;z-index:2147483000;' +
        'background:#b3261e;color:#fff;font:13px/1.5 sans-serif;padding:10px 12px;' +
        'border-radius:10px;max-width:280px;direction:ltr;text-align:left';
      d.textContent = 'Toolbar: ' + msg;
      document.body.appendChild(d);
    } catch (e) {}
  }
  function init() {
    if (!document.body) { fail('document.body missing'); return; }
    root = document.createElement('div');
    root.id = 'nibrasToolbar';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    document.addEventListener('keydown', onKey);
    try { paint(); } catch (e) { fail('paint: ' + ((e && e.message) || e)); return; }

    /* موقع المستخدم إن سمح، وإلا عمّان. لا نرفض الإذن ولا نطلبه مرتين. */
    if (!lsGet('geo', false) && navigator.geolocation) {
      lsSet('geo', true);
      navigator.geolocation.getCurrentPosition(function (p) {
        CITY = { lat: p.coords.latitude, lon: p.coords.longitude, name: '—' };
        lsSet('weather', null); lsSet('prayer', null);
        if (open) paint();
      }, function () {}, { timeout: 8000, maximumAge: 600000 });
    }
    /* الساعة تتحدّث كل 30 ثانية ما دامت اللوحة مفتوحة على تبويب الساعة. */
    setInterval(function () {
      if (open && tab === 'c') { var b = document.getElementById('tbBody'); if (b) clockRender(b); }
    }, 30000);
  }

  /* نExport الدوال الصافية للاختبار دون واجهة. */
  window.__tb = {
    calcEval: calcEval, trDict: trDict, toJordanian: toJordanian,
    hijri: hijri, prayerRender: prayerRender, weatherRender: weatherRender,
    trRemote: trRemote, fetchWeather: fetchWeather, fetchPrayer: fetchPrayer,
    getCity: function () { return CITY; }, setCity: function (c) { CITY = c; },
    lsGet: lsGet, lsSet: lsSet, setLang: setLang, getLang: L
  };
  window.__tbStrings = LANGS;
  /* عَلَم التشخيص: يميّز «السكربت لم يُحمَّل» عن «حمِل وفشل» عن «اشتغل». */
  window.__tbState = 'loaded';
  window.__tbFmtZone = fmtZone;
  window.__tbBoot = boot;
  try {
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
  } catch (e) { fail('boot: ' + ((e && e.message) || e)); }
})();