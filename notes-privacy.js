'use strict';
/* =============================================================================
 * خصوصية ملاحظات الطلاب — ملكية على مستوى الخادم
 * -----------------------------------------------------------------------------
 * لماذا هذا الملف:
 * الملاحظات لم تكن جدولاً ولا لها API خاص؛ هي قسم 'notes' ضمن الكتلة JSON
 * الواحدة لكل مدرسة، تُقرأ عبر GET /api/db/:school كاملةً بلا أي فلترة سطرية.
 * فكل معلم كانت تنزّل كل ملاحظات زميلاتها (نصّها وأسماء كاتباتها)، وواجهة
 * renderNotes كانت تعرضها كلها لأن شرطها الوحيد «الطالب في قائمتي».
 *
 * المبدأ المعتمد:
 *   1) المالك يُقرأ من معرّف المستخدم الثابت (createdBy) لا من الاسم.
 *      تغيير اسم المعلم أو حذف حسابها لا ينقل ملكية الملاحظة ولا يُخفيها.
 *   2) الخادم هو مصدر الحقيقة: لا يُثق بـ ownerId القادم من العميل إطلاقاً.
 *      المالك يُفرض من sessions.user_id (مصدر موثوق، db.sessionByTokenHash).
 *   3) الصلاحية تُطبَّق على مستوى الاستجابة (لا يُرجع السجل أصلاً) لا في الواجهة.
 *   4) المحتوى منفصل عن المجموع: الخادم يحسب أرصدة النقاط من كل الملاحظات
 *      ويرسلها، حتى تبقى أرقام النقاط مطابقة تماماً لجهاز المدير رغم أن نص
 *      الملاحظات الخاصة بالغير لا يصل. النقاط محسوبة أصلاً في المتصفح من
 *      pointItems() — وهذا الملف منفذ مطابق لقواعده حرفيةً.
 *
 * الملاحظات القديمة بلا createdBy صالح: لا تُحذف ولا تُنسب لأحد. تُقرأ
 * «غير مملوكة» => تراها الأدوار الإدارية فقط (canReadAllNotes).
 * ========================================================================== */

// ===== الأدوار التي ترى كل الملاحظات irrespective of المالك =====
const ALL_NOTES_ROLES = new Set(['ADMIN', 'AGENT']);
// الأدوار التي قد تكون مالكة: من يحق له كتابة الملاحظات (SECTION_RULES.notes).
const OWNER_ROLES = new Set(['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'ADMINISTRATIVE', 'SCHOOL_AGENT']);

function isPrivilegedNotesRole(role) { return ALL_NOTES_ROLES.has(String(role || '')); }

// ===== المالك: معرّف ثابت فقط، ولا استدلال بالاسم ولا بالطالب =====
/**
 * معرّف المالك الصالح للملاحظة.
 * - createdBy هو الحقل المعتمد في المشروع (وليس ownerId) — نقرأه كما هو.
 * - لا نقارن اسماً أبداً: الأسماء تتكرر وتتغير.
 * - ملاحظة بلا createdBy أو بمعرّف فارغ => null (غير مملوكة).
 */
function noteOwnerId(note) {
  if (!note || typeof note !== 'object') return null;
  const v = note.createdBy != null ? note.createdBy : note.ownerId;
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** هل يستطيع هذا المستخدم قراءة هذه الملاحظة؟ */
function canReadNote(note, session) {
  if (!session) return false;
  if (isPrivilegedNotesRole(session.role)) return true;
  // الطالب ترى ملاحظاتها هي: نقطُها وُضعت باسمها (studentId = معرّف حسابها).
  // بلا هذا الشرط لا يصلها من الخادم أي ملاحظة (لا تملك غيرا منها) فتظهر
  // نقاطُها الإيجابية صفراً على شاشة «نقاطي» رغم أن رصيدها يحتسبها كلها.
  if (String(session.role || '') === 'STUDENT') {
    return !!(note && note.studentId != null
      && String(note.studentId).trim() === String(session.user_id || ''));
  }
  const owner = noteOwnerId(note);
  // غير مملوكة: للإدارة فقط (وليس لكل معلم، ولا حتى للمالكة المحتملة المجهولة)
  if (!owner) return false;
  return owner === String(session.user_id || '');
}

/**
 * فلترة قائمة ملاحظات لمشاهد معيّن. الأدوار الإدارية ترى الكل (بما فيها
 * غير المملوكة حرفياً — لا حذف ولا إسناد)، وكل دور آخر يرى ملاحظاته فقط،
 * والطالب ترى ملاحظاتها هي (المرجوحة باسمها) دون ملاحظات زميلاتها.
 */
function filterNotesForViewer(notes, session) {
  if (!Array.isArray(notes)) return [];
  if (session && isPrivilegedNotesRole(session.role)) return notes;
  return notes.filter(n => canReadNote(n, session));
}

// ===== فرض المالك عند الكتابة (لا يُثق بقيمة العميل) =====
/**
 * تُستدعى على الملاحظات الواصلة في PUT قبل الدمج.
 *  - ملاحظة جديدة (معرّفها غير موجود على الخادم): يُفرض createdBy من الجلسة،
 *    أي قيمة أرسلها العميل تُتجاهل — حتى لو ادّعى كاتِبُها أنها لزميلته.
 *  - ملاحظة موجودة على الخادم: يُفرض مالكُ نسخة الخادم دائماً، فلا يستطيع أي
 *    عميل نقل ملكية ملاحظة أو انتحالها.
 * المستخدمون الإداريون ينشئون ملاحظات باسمهم أيضاً (يسري القانون عليهم)؛
 * شرط «لا يُعدّ الوكيل مالكاً لمجرد قدرته على القراءة» محفوظ لأن الدفع نفسه
 * هو ما يولّد createdBy.
 */
function enforceNoteOwners(incomingNotes, session, serverNotes) {
  if (!Array.isArray(incomingNotes)) return incomingNotes;
  if (!session || !session.user_id) return incomingNotes;
  const me = String(session.user_id);
  const privileged = isPrivilegedNotesRole(session.role);
  const serverById = new Map();
  for (const n of (Array.isArray(serverNotes) ? serverNotes : [])) {
    if (n && n.id != null) serverById.set(String(n.id), n);
  }
  const out = [];
  for (const n of incomingNotes) {
    if (!n || typeof n !== 'object') { out.push(n); continue; }
    const server = n.id != null ? serverById.get(String(n.id)) : null;
    if (!server) {
      // ملاحظة جديدة: المالك من الجلسة، وأي ownerId/createdBy من العميل يُتجاهل.
      const fresh = Object.assign({}, n);
      fresh.createdBy = me;
      delete fresh.ownerId;
      // ownershipClaims لا تُكتب من أي جهاز: المطالب مسار خاص يُسجّلها الخادم
      // في requestNoteClaim. لو تركناها تصل من العميل لسجّل عميلٌ طلباً باسم
      // نفسه باسم غيره أو ادّعى approving بلا صلاحية.
      delete fresh.ownershipClaims;
      out.push(fresh);
      continue;
    }
    // ملاحظة موجودة على الخادم: نسخة الخادم هي المرجع في كل شيء.
    const owner = noteOwnerId(server);
    // سجلّ المطالبات يُنقل من الخادم دائماً (سبب الاستدعاء أعلاه).
    const serverClaims = server.ownershipClaims;
    if (privileged) {
      // الإدارة تستطيع تعديل نصها، لكن لا تنقل ملكيتها.
      const p = Object.assign({}, n);
      if (owner) p.createdBy = owner; else delete p.createdBy;
      delete p.ownerId;
      if (serverClaims !== undefined) p.ownershipClaims = serverClaims; else delete p.ownershipClaims;
      out.push(p);
      continue;
    }
    if (owner && owner === me) {
      const mine = Object.assign({}, n);
      mine.createdBy = owner;
      delete mine.ownerId;
      if (serverClaims !== undefined) mine.ownershipClaims = serverClaims; else delete mine.ownershipClaims;
      out.push(mine);
      continue;
    }
    // ===== هنا الأهم أمنياً =====
    // غير المالك (بما فيه غير المالك من ملاحظة قديمة بلا createdBy): تُعاد نسخة
    // الخادم كما هي، ولا يُطبَّق منه شيء — لا تعديل النص ولا deleted. قبل هذا
    // كان فرضُ المالك وحده كافياً، فيكفي أن تعرف زميلةٌ مُعرّف ملاحظة أن تحذفها
    // أو تغيّر نصّها بإرسال السجل القديم: المالك يُستعاد ولا يتغيّر، لكن التعديل
    // كان يمرّ. فنعيد نسخة الخادم كاملةً — لا نصّ ولا deleted ولا أي حقل.
    out.push(Object.assign({}, server));
  }
  return out;
}

// ===== استرداد ملكية الملاحظات غير المملوكة: مطالب + موافقة =====
// الملاحظات القديمة بلا createdBy لا نعرف صاحبتها، فلا نحذفها ولا نخمن. لكنها
// تبقى غير مرئية لصاحبتها. الحل: مطالب مُصرَّح بها من صاحبتها المحتملة، ثم
// موافقة الإدارة. خطوتان لأن خطوة واحدة تكفي لسرقة ملاحظة زميلة بمجرد
// معرّفها — وهي بيانات سرّ.
// قاعدة أساسية: المطالب لا تنقل الملكية. createdBy لا يُكتب إلا بموافقة
// إدارية صريحة، وهو نفس المبدأ القائم في كل دالة أعلاه.
const MAX_CLAIMS_PER_NOTE = 3;
const CLAIM_WINDOW_DAYS = 30;

/** هل يمكن لهذا المستخدم أن يطالب بملكية هذه الملاحظة؟ */
function canClaimNote(note, session) {
  if (!note || !session || !session.user_id) return false;
  // المملوكة أصلاً لا تُطالب: 소유ها محسوم ولا حاجة للمطالب.
  if (noteOwnerId(note)) return false;
  if (note.deleted) return false;
  // الإدارة لا «تطالب» — تنسب مباشرة عبر decideClaim.
  if (isPrivilegedNotesRole(session.role)) return false;
  if (!OWNER_ROLES.has(String(session.role || ''))) return false;
  const claims = Array.isArray(note.ownershipClaims) ? note.ownershipClaims : [];
  const open = claims.find(c => c && c.status === 'PENDING');
  // طلب مفتوح واحد فقط: ننتظر قرار الإدارة بدل تكديس الطلبات.
  if (open) return false;
  return true;
}

/**
 * تسجيل مطالب بملكية ملاحظة. لا تُغيّر createdBy ولا تحذف شيئاً.
 * ملاحظة مملوكة أو محذوفة أو دور غير مؤهّل => ترجع reason، ولا تعديل.
 */
function requestNoteClaim(notes, session, noteId, nowIso) {
  if (!Array.isArray(notes)) return { ok: false, reason: 'invalid_notes' };
  if (!session || !session.user_id) return { ok: false, reason: 'unauthenticated' };
  const idx = notes.findIndex(n => n && String(n.id) === String(noteId));
  if (idx < 0) return { ok: false, reason: 'not_found' };
  if (!canClaimNote(notes[idx], session)) return { ok: false, reason: 'not_claimable' };
  const now = nowIso || new Date().toISOString();
  const claims = Array.isArray(notes[idx].ownershipClaims) ? notes[idx].ownershipClaims.slice() : [];
  // سقفHistory: يمنع تضخّم السجل بطلبات متكررة من نفس الشخص على نفس الملاحظة.
  if (claims.filter(c => c && c.requestedBy === String(session.user_id)).length >= MAX_CLAIMS_PER_NOTE)
    return { ok: false, reason: 'too_many_claims' };
  claims.push({
    requestedBy: String(session.user_id),
    requestedByName: String(session.name || ''),   // للعرض الإداري فقط، لا للملكية
    requestedByRole: String(session.role || ''),
    requestedAt: now,
    status: 'PENDING',
  });
  const out = notes.slice();
  out[idx] = Object.assign({}, notes[idx], { ownershipClaims: claims });
  return { ok: true, changed: true, notes: out, note: out[idx] };
}

/** هلPending يُ{max} antiquity — نفرض مهلة حتى لا تتقادم الطلبات للأبد؟ */
function _claimTooOld(claim) {
  if (!claim || !claim.requestedAt) return false;
  const t = Date.parse(claim.requestedAt);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) > CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * قرار الإدارة: اعتماد أو رفض مطالب. عند الاعتماد فقط يُكتب createdBy —
 * من sessions.user_id بصيغة_sequence واحدة، ولا يُقبل أي معرّف من العميل.
 * - من يدّعي ID ملاحظة لا يطابق requester الطلب => يُرفض الطلب (400).
 * - طلب منتهٍ أو ملاحظة صارت مملوكة => reason، بلا تعديل.
 */
function decideNoteClaim(notes, session, noteId, approve, nowIso) {
  if (!Array.isArray(notes)) return { ok: false, reason: 'invalid_notes' };
  if (!session || !session.user_id) return { ok: false, reason: 'unauthenticated' };
  if (!isPrivilegedNotesRole(session.role)) return { ok: false, reason: 'forbidden' };
  const idx = notes.findIndex(n => n && String(n.id) === String(noteId));
  if (idx < 0) return { ok: false, reason: 'not_found' };
  const note = notes[idx];
  if (noteOwnerId(note)) return { ok: false, reason: 'already_owned' };
  const claims = Array.isArray(note.ownershipClaims) ? note.ownershipClaims : [];
  const pending = claims.find(c => c && c.status === 'PENDING');
  if (!pending) return { ok: false, reason: 'no_pending_claim' };
  if (_claimTooOld(pending)) return { ok: false, reason: 'claim_expired' };
  const now = nowIso || new Date().toISOString();
  const nextClaims = claims.map(c => {
    if (c !== pending) return c;
    return Object.assign({}, c, {
      status: approve ? 'APPROVED' : 'REJECTED',
      decidedBy: String(session.user_id),
      decidedAt: now,
    });
  });
  const out = notes.slice();
  const decided = Object.assign({}, note, { ownershipClaims: nextClaims });
  if (approve) {
    // النمط الوحيد في النظام الذي يُكتب فيه createdBy لمملوك سابق:
    // من قرار إداري صريح، ومن sessions فقط.
    decided.createdBy = String(pending.requestedBy);
  }
  out[idx] = decided;
  return { ok: true, changed: true, notes: out, note: decided, approved: !!approve };
}

/** طلبات مفتوحة للإدارة، مع ملاحظة مختصرة (بلا نصّ كامل حتى يقرأها صاحبها فقط). */
function listPendingClaims(notes) {
  if (!Array.isArray(notes)) return [];
  const out = [];
  for (const n of notes) {
    if (!n || typeof n !== 'object') continue;
    if (noteOwnerId(n)) continue;
    for (const c of (Array.isArray(n.ownershipClaims) ? n.ownershipClaims : [])) {
      if (!c || c.status !== 'PENDING') continue;
      out.push({
        noteId: n.id,
        studentId: n.studentId,
        studentName: n.studentName || '',
        category: n.category || '',
        points: (typeof n.points === 'number') ? n.points : null,
        createdAt: n.createdAt || null,
        // النصّ الكامل لا يخرج للإدارة هنا: القائمة للاستنتاج والقرار، والقرار
        // على المراجعة في شاشة الملاحظات نفسها.
        hasText: !!n.description,
        requestedBy: c.requestedBy,
        requestedByName: c.requestedByName || '',
        requestedByRole: c.requestedByRole || '',
        requestedAt: c.requestedAt,
        expired: _claimTooOld(c),
      });
    }
  }
  return out;
}

// ===== حساب النقاط على الخادم (منفذ مطابق لـ pointItems في public/index.html) =====
const NOTE_POINTS_MAP = {
  'الانضباط': 5, 'الاحترام': 5, 'التعاون': 4, 'المشاركة': 3, 'المثابرة': 4,
  'تفوق دراسي': 10, 'إنجاز الواجبات': 3, 'القيادة': 6,
  'الغياب': -2, 'التأخر': -1, 'عدم إنجاز الواجبات': -4, 'الإزعاج داخل الفصل': -5,
  'عدم الانضباط': -6, 'قلة الاحترام': -7, 'التنمر': -10, 'عدم المشاركة': -3,
};
const UNDONE_DEDUCTION = -4;

function notePoints(type, category) {
  if (NOTE_POINTS_MAP[category] != null) return NOTE_POINTS_MAP[category];
  return type === 'POSITIVE' ? 2 : -3;
}
function attendancePoints(status, lateMins) {
  if (status === 'ABSENT') return -2;
  if (status === 'LATE') {
    const m = parseInt(lateMins, 10) || 0;
    if (m <= 15) return -1;
    if (m <= 30) return -2;
    if (m <= 60) return -3;
    return -4;
  }
  return 0;
}
// مطابق لـ __attEffStatus في الواجهة: الغائب يُقرّأ من status لا من غياب السجل.
// لو تجاهلنا ABSENT لبدا كل غياب حاضراً عند حساب النقاط على الخادم.
function attEffStatus(rec) {
  if (!rec) return 'PRESENT';
  if (rec.status === 'ABSENT') return 'ABSENT';
  return rec.status === 'LATE' ? 'LATE' : 'PRESENT';
}
// تاريخ العنصر كما تراه نقطة الواجهة: ملاحظة = createdAt، حضور = يومه،
// تكليف = نهاية يومه. لازم نحاكيها بالضبط لأن الترشيح بخط البداية يعتمد عليها.
function itemDate(it) {
  const d = it && it.createdAt ? String(it.createdAt).slice(0, 10) : '';
  return d;
}
function todayStrUTC() { return new Date().toISOString().slice(0, 10); }

/**
 * أرصدة النقاط لكل طالب، محسوبة من *كل* الملاحظات (لا مملوكةViewer فقط).
 * هذه هي القيمة التي يراها المدير حالياً؛ بإرسالها للجميع تبقى أرقام النقاط
 * مطابقة تماماً على كل الأجهزة بعد إخفاء نصوص الملاحظات عن غير المالكين.
 * القواعد منقولة حرفياً من pointItems() كي لا ينحرف أي رقم.
 */
function computePointsTotals(data, cutDate) {
  const notes = Array.isArray(data && data.notes) ? data.notes : [];
  const attendance = Array.isArray(data && data.attendance) ? data.attendance : [];
  const assignments = Array.isArray(data && data.assignments) ? data.assignments : [];
  const students = Array.isArray(data && data.students) ? data.students : [];
  const today = todayStrUTC();

  // ===== البناء أولاً: نفس ترتيب pointItems في الواجهة حرفياً =====
  // نبني قائمة عناصر (ملاحظة/حضور/تكليف) بدل الجمع مباشرة، لأن الترشيح
  // بخط بداية النقاط يقع على *كل* العناصر السالبة بعد بنائها. لو رُشّحت
  // الملاحظات وحدها (كما كان في نسخة أولى) لاختلف رقم الحضور والتكليف عن
  // جهاز المدير، لأن الحضور السالب قبل خط البداية ما زال يُحسب هنا.
  const items = [];

  for (const n of notes) {
    if (!n || n.deleted) continue;
    const pts = (typeof n.points === 'number') ? n.points : notePoints(n.type, n.category);
    if (!pts) continue;
    items.push({
      studentId: n.studentId, type: n.type, category: n.category, points: pts,
      createdAt: n.createdAt, assignmentId: n.assignmentId, kind: 'note',
    });
  }

  for (const a of attendance) {
    if (!a) continue;
    const eff = attEffStatus(a);
    const pts = attendancePoints(eff, a.lateMinutes);
    if (pts === 0) continue;
    items.push({
      studentId: a.studentId, type: 'NEGATIVE',
      category: eff === 'ABSENT' ? 'الغياب' : 'التأخر', points: pts,
      // نفس تاريخ الواجهة: يوم الحضور عند منتصف الليل UTC
      createdAt: (a.date || '') + 'T00:00:00.000Z', kind: 'att',
    });
  }

  for (const a of assignments) {
    if (!a || a.deleted) continue;
    if (!a.date || a.date > today) continue;
    for (const s of students) {
      if (!s.active || s.classId !== a.classId) continue;
      if (s.joinedAt && a.created && a.created < s.joinedAt) continue;
      if ((a.completedBy || []).includes(s.id)) continue;
      // ملاحظة «عدم إنجاز الواجب» تغطّي التكليف فلا يُخصم مرتين
      const covered = notes.find(n => !n.deleted && n.studentId === s.id
        && n.category === 'عدم إنجاز الواجب' && n.assignmentId === a.id);
      if (covered) continue;
      items.push({
        studentId: s.id, type: 'NEGATIVE', category: 'عدم إنجاز الواجب',
        points: UNDONE_DEDUCTION,
        // نفس تاريخ الواجهة: نهاية يوم الموعد
        createdAt: (a.date || '') + 'T23:59:59.000Z', kind: 'assign',
      });
    }
  }

  // ===== ثم الترشيح، بنفس شروط pointItems =====
  const attKeys = new Set(attendance.map(a => a && a.studentId + '|' + a.date + '|' + a.status));
  const doneAssignKeys = new Set(assignments
    .filter(a => !(a && a.deleted))
    .flatMap(a => (a.completedBy || []).map(sid => sid + '|' + a.id)));
  const kept = items.filter(it => {
    // خط بداية النقاط: كل سالب قبله لا يُحتسب (ملاحظة أو حضور أو تكليف)
    if (it.type === 'NEGATIVE' && cutDate) {
      const dt = itemDate(it);
      if (dt && dt < cutDate) return false;
    }
    // لا تُخصم مرتين: ملاحظة «غياب/تأخر» لها سجل حضور بنفس اليوم
    if (it.kind === 'note' && (it.category === 'الغياب' || it.category === 'التأخر')) {
      const date = itemDate(it);
      const status = it.category === 'الغياب' ? 'ABSENT' : 'LATE';
      if (date && attKeys.has(it.studentId + '|' + date + '|' + status)) return false;
    }
    // نفس فحص pointItems: عناصر التكليف تحمل assignmentId فارغاً هناك، فنقلّد
    // الفحص حرفياً (يظل غير مفعّل عملياً) بدل أن نخترع سلوكاً يخالف ما تراه
    // الواجهة على شاشة المدير.
    if (it.kind === 'assign' && doneAssignKeys.has(it.studentId + '|' + (it.assignmentId || ''))) return false;
    // ملاحظة: لا نقاط بسبب اختفاء مُنشئ الملاحظة (تكرار الأسماء/إعادة التوجيه)
    // — نفس قصد تعليق pointItems في الواجهة.
    return true;
  });

  const totals = {};
  const add = (studentId, points) => {
    if (!studentId || !points) return;
    const t = totals[studentId] || (totals[studentId] = { total: 0, pos: 0, neg: 0 });
    t.total += points;
    if (points > 0) t.pos += points; else t.neg += points;
  };
  for (const it of kept) add(it.studentId, it.points);
  return totals;
}


// ===== حق الحذف على مستوى الخادم =====
// الحذف عندنا ناعم: deleted:true ويبقى شاهد قبر لئلا يعود السجل بالسحب.
// لكن بقاء الشاهد لا يعني أن يُترك لأي عميل. القاعدة نفسها التي في
// الواجهة: المدير يحذف أي ملاحظة، والمعلم تحذف ملاحظتها هي فقط،
// وسائر الأدوار لا تحذف. من لا يملك الحق يُلغى عنده عَلَم الحذف
// ويبقى السجل كما هو: لا يُرفض دفعه كاملاً فتبقى بقية حفظه سليمة.
function canDeleteNote(note, session) {
  if (!session || !session.user_id) return false;
  if (session.role === 'ADMIN') return true;
  if (session.role !== 'TEACHER') return false;
  const owner = noteOwnerId(note);
  return !!owner && owner === String(session.user_id);
}

/**
 * يُطبَّق بعد enforceNoteOwners (فنكون نعرف المالك الحقيقي).
 * يعيد { notes, blocked }: قائمة منقاة، ومحاولات حذف مرفوضة للتسجيل.
 */
function enforceNoteDeleteRights(incomingNotes, session, serverNotes) {
  if (!Array.isArray(incomingNotes)) return { notes: incomingNotes, blocked: [] };
  const serverById = new Map();
  for (const n of (Array.isArray(serverNotes) ? serverNotes : [])) {
    if (n && n.id != null) serverById.set(String(n.id), n);
  }
  const blocked = [];
  const out = [];
  for (const n of incomingNotes) {
    if (!n || typeof n !== 'object' || n.deleted !== true) { out.push(n); continue; }
    if (canDeleteNote(n, session)) { out.push(n); continue; }
    const server = n.id != null ? serverById.get(String(n.id)) : null;
    // محذوفة عند الخادم أصلا: لا نحييها بازالة العَلَم ولا نبقه بلا فائدة
    if (server && server.deleted === true) { out.push(n); continue; }
    const copy = Object.assign({}, n);
    delete copy.deleted;
    delete copy.deletedAt;
    delete copy.deletedBy;
    blocked.push({
      id: n.id != null ? String(n.id) : null,
      owner: noteOwnerId(server || n),
      by: session && session.user_id ? String(session.user_id) : null,
      role: session && session.role ? String(session.role) : null,
    });
    out.push(copy);
  }
  return { notes: out, blocked };
}
module.exports = {
  ALL_NOTES_ROLES,
  OWNER_ROLES,
  NOTE_POINTS_MAP,
  CLAIM_WINDOW_DAYS,
  isPrivilegedNotesRole,
  noteOwnerId,
  canReadNote,
  filterNotesForViewer,
  enforceNoteOwners,
  canDeleteNote,
  enforceNoteDeleteRights,
  canClaimNote,
  requestNoteClaim,
  decideNoteClaim,
  listPendingClaims,
  computePointsTotals,
  notePoints,
  attendancePoints,
};
