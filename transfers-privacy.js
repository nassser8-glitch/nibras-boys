'use strict';
/* =============================================================================
 * خصوصية تحويلات الطلاب — من يرى التحويل
 *
 * التحويلات كانت تصل إلى كل جهاز بلا تصفية: GET /api/db/:school يعيد قسم
 * transfers كاملاً، فكل معلم تسحب كل تحويلات المدرسة وتقرأ أسماء طلاب زميلاتها
 * وأسباب تحويلهم. الإخفاء في الواجهة وحده ليس خصوصية: البيانات تصل إلى الجهاز
 * ويمكن استخراجها من تخزين المتصفح. القاعدة تُطبَّق على الاستجابة، كما هي
 * في notes-privacy.js للملاحظات.
 *
 * القاعدة المطلوبة:
 *   - المدير (ADMIN): كل تحويلات المدرسة.
 *   - الوكالة (AGENT) والموجه الطلابية (COUNSELOR): كل تحويلات المدرسة —
 *     طبقة إشراف على المعلمين، فحاجتها لها.
 *   - المعلم: التحويلات التي أرسلتها هي فقط. أن ترى تحويل زميلة عن طالب
 *     يشترك معك في فصل ليس حقاً لك،ولا часть من عملك.
 *   - الطالب: لا شيء.
 *
 * createdBy هو معرّف ثابت من req.session.user_id عند الإنشاء، ولا يُقبل من
 * جسم الطلب — فلا يمكن انتحال الملكية ولا المخاطبة بالاسم.
 * ========================================================================== */
const ALL_TRANSFERS_ROLES = new Set(['ADMIN', 'AGENT', 'COUNSELOR']);

/** معرّف صاحب التحويل، أو '' إن كان التحويل بلا مرسل معروف. */
function transferOwnerId(t) {
  if (!t || t.createdBy == null) return '';
  return String(t.createdBy).trim();
}

/** هل يقرأ هذا المستخدم هذا التحويل؟ */
function transferVisibleTo(t, viewer) {
  if (!t || typeof t !== 'object') return false;
  if (!viewer || !viewer.role) return false;
  // إشراف: الأدوار الثلاثة ترى المدرسة كلها.
  if (ALL_TRANSFERS_ROLES.has(String(viewer.role))) return true;
  // ما عدا ذلك: صاحب التحويل وحده.
  const owner = transferOwnerId(t);
  const me = viewer.user_id != null ? String(viewer.user_id).trim() : '';
  return !!owner && !!me && owner === me;
}

/** تصفية قسم transfers كاملاً حسب صلاحية القارئ. */
function filterTransfersForViewer(transfers, viewer) {
  if (!Array.isArray(transfers)) return [];
  return transfers.filter(t => transferVisibleTo(t, viewer));
}


// ===== حق الحذف على مستوى الخادم (تحويلات) =====
// الحذف عندنا ناعم: deleted:true ويبقى شاهد قبر لئلا يعود التحويل بالسحب.
// لكن بقاء الشاهد لا يعني أن يُترك لأي عميل. القاعدة نفسها التي في
// الواجهة: المدير يحذف أي تحويل، وسائر الأدوار لا تحذف.
function canDeleteTransfer(transfer, session) {
  if (!session || !session.user_id) return false;
  return String(session.role || '') === 'ADMIN';
}

/**
 * يُطبَّق قبل الدمج: من لا يملك الحق يُلغى عنده عَلَم الحذف ويبقى
 * التحويل كما هو — لا يُرفض دفعه كاملاً فتبقى بقية حفظه سليمة،
 * والمحاولة المرفوضة تُسجَّل في سجل الخادم.
 */
function enforceTransferDeleteRights(incomingTransfers, session, serverTransfers) {
  if (!Array.isArray(incomingTransfers)) return { transfers: incomingTransfers, blocked: [] };
  const serverById = new Map();
  for (const t of (Array.isArray(serverTransfers) ? serverTransfers : [])) {
    if (t && t.id != null) serverById.set(String(t.id), t);
  }
  const blocked = [];
  const out = [];
  for (const t of incomingTransfers) {
    if (!t || typeof t !== 'object' || t.deleted !== true) { out.push(t); continue; }
    if (canDeleteTransfer(t, session)) { out.push(t); continue; }
    const server = t.id != null ? serverById.get(String(t.id)) : null;
    // محذوف عند الخادم أصلا: يبقى الشاهد ولا يُحيا
    if (server && server.deleted === true) { out.push(t); continue; }
    const copy = Object.assign({}, t);
    delete copy.deleted;
    delete copy.deletedAt;
    delete copy.deletedBy;
    blocked.push({
      id: t.id != null ? String(t.id) : null,
      owner: transferOwnerId(server || t),
      by: session && session.user_id ? String(session.user_id) : null,
      role: session && session.role ? String(session.role) : null,
    });
    out.push(copy);
  }
  return { transfers: out, blocked };
}
module.exports = {
  ALL_TRANSFERS_ROLES,
  transferOwnerId,
  transferVisibleTo,
  filterTransfersForViewer,
  canDeleteTransfer,
  enforceTransferDeleteRights,
};
