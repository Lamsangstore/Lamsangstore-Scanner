/**
 * Google Apps Script: Backend สำหรับ Scanner PRO 3.1 (Hardened Edition)
 *
 * ✅ v3.1 changes:
 *  - API key check (จาก PropertiesService — รัน setupApiKey() ครั้งเดียว)
 *  - Rate limit ต่อ action (CacheService, per-minute bucket)
 *  - จำกัดขนาด video upload (กัน Drive bombing)
 *  - Input validation ทุก action
 *  - Action allowlist
 *
 * 🚀 วิธี deploy (ครั้งแรก):
 *  1. เปิด script.google.com → โปรเจคนี้
 *  2. รัน setupApiKey() ใน editor — ใส่ key เดียวกับใน index.html (GAS_API_KEY)
 *  3. Deploy → New deployment → Web app → Execute as me, Anyone access
 *  4. ก็อป URL ใหม่ ใส่ใน index.html (GAS_URL)
 *
 * 🔁 หมุน key เมื่อโดน leak:
 *  - เปลี่ยน GAS_API_KEY ใน index.html
 *  - รัน setupApiKey() ใน editor ด้วย key ใหม่
 *  - ไม่ต้อง re-deploy
 */

const SHEET_ORDERS      = "Orders";
const SHEET_SEARCH      = "Search";
const SHEET_PRODUCTS    = "Product name";
const SHEET_MARKETPLACE = "MarketplaceData";
const TARGET_FOLDER_ID  = "1uC2i5w5p9MhEYK2DhV6LGh1KfZF-GlVG";

// ============================================================
// 🔧 เมนูบนชีต — เปิดชีตแล้วจะมีเมนู "🔧 Scanner Tools" บนแถบบนสุด
//   เรียกเครื่องมือต่างๆ ได้โดยไม่ต้องเข้า Apps Script editor
//   (ครั้งแรกต้องกด Authorize + reload ชีต 1 ครั้ง)
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🔧 Scanner Tools')
    .addItem('🎬 เติมลิงก์วิดีโอ (reconcile)', 'menuReconcileVideos')
    .addSeparator()
    .addItem('🔥 ดูด Firebase inbox → ชีต', 'menuDrainInbox')
    .addItem('🔍 หาออเดอร์ที่หาย', 'menuFindLost')
    .addItem('🧩 รวม row ซ้ำ (merge duplicates)', 'menuMergeDup')
    .addItem('🏷️ ดันชื่อสินค้าขึ้น Firebase (แก้ขึ้น SKU)', 'menuForceMirrorProducts')
    .addSeparator()
    .addSubMenu(ui.createMenu('🧹 แก้ข้อมูลซ้ำ/เกิน')
      .addItem('1️⃣ พรีวิว: Page365 ซ้ำกับ native', 'menu365Preview')
      .addItem('2️⃣ ลบ Page365 ซ้ำ (แก้จริง)', 'menu365Apply')
      .addSeparator()
      .addItem('3️⃣ พรีวิว: ออเดอร์แสกนสินค้าเกิน', 'menuOverScanPreview')
      .addItem('4️⃣ แก้สินค้าเกิน + อัปเดต Firebase (แก้จริง)', 'menuOverScanApply'))
    .addToUi();
}

// 🎬 เติมลิงก์วิดีโอจาก Drive ให้ row ที่ no_video
function menuReconcileVideos() {
  const ui = SpreadsheetApp.getUi();
  try {
    const resp = ui.prompt('🎬 เติมลิงก์วิดีโอ',
      'ดึงไฟล์จาก Drive มาเติม row ที่ขึ้น no_video\nย้อนหลังกี่วัน? (เช่น 7 หรือ 30)',
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    const days = parseInt(resp.getResponseText(), 10) || 7;
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังสแกน Drive + ชีต... (อาจนานถ้าไฟล์เยอะ)', '🎬', 120);
    const r = reconcileVideoUrls({ sinceDays: days });
    if (r && r.success) {
      ui.alert('✅ เสร็จแล้ว',
        'เติมลิงก์: ' + r.fixed + ' แถว\n' +
        'สแกน: ' + r.scanned + ' แถว\n' +
        'ไฟล์ใน Drive: ' + r.driveFiles + '\n' +
        'ช่วง: ' + r.sinceDays + ' วัน', ui.ButtonSet.OK);
    } else {
      ui.alert('❌ ไม่สำเร็จ', (r && r.error) || 'ไม่มีผลลัพธ์', ui.ButtonSet.OK);
    }
  } catch(e) {
    ui.alert('❌ เกิดข้อผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK);
  }
}

function menuDrainInbox() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังดูด Firebase inbox...', '🔥', 60);
    drainFirebaseInbox();
    ui.alert('✅ ดูด inbox เสร็จ', 'ดู Execution log ใน editor ถ้าต้องการรายละเอียด', ui.ButtonSet.OK);
  } catch(e) {
    ui.alert('❌ เกิดข้อผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK);
  }
}

function menuFindLost() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังเทียบ SaveLog vs Orders...', '🔍', 60);
    const r = findLostOrders();
    const lost = (r && r.lost) || [];
    ui.alert(lost.length === 0 ? '✅ ไม่มีออเดอร์หาย' : '⚠ พบออเดอร์หาย ' + lost.length + ' ใบ',
      'success ใน SaveLog: ' + (r && r.successCount) + '\n' +
      'อยู่ในชีต: ' + (r && r.present) + '\n' +
      'หาย: ' + lost.length + (lost.length ? '\n\n' + lost.slice(0, 30).join('\n') : '') +
      (lost.length ? '\n\n(รายละเอียดเต็มส่งไปอีเมลแล้ว)' : ''), ui.ButtonSet.OK);
  } catch(e) {
    ui.alert('❌ เกิดข้อผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK);
  }
}

function menuMergeDup() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังรวม row ซ้ำ...', '🧩', 60);
    mergeDuplicateOrders();
    ui.alert('✅ รวม row ซ้ำเสร็จ', 'ดู Execution log ถ้าต้องการรายละเอียด', ui.ButtonSet.OK);
  } catch(e) {
    ui.alert('❌ เกิดข้อผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK);
  }
}

// 🏷️ ดันชื่อสินค้าขึ้น Firebase (แก้เคสเครื่องขึ้น SKU)
function menuForceMirrorProducts() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังดันชื่อสินค้าขึ้น Firebase...', '🏷️', 30);
    const n = forceMirrorProducts();
    ui.alert(n > 0 ? '✅ เสร็จ' : '⚠️ ไม่ได้ทำ',
      n > 0 ? ('ดันชื่อสินค้า ' + n + ' รายการขึ้น Firebase + เตะให้ทุกเครื่องดึงใหม่แล้ว\nให้เครื่องที่ขึ้น SKU รีเฟรช/สลับมาหน้าจอ')
            : 'product sheet ว่าง — ไม่ทำ (กันลบของดี)', ui.ButtonSet.OK);
  } catch(e) { ui.alert('❌ ผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK); }
}

// 1️⃣ พรีวิว: Page365 ที่ tracking ซ้ำกับ native (ไม่ลบ)
function menu365Preview() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังตรวจ Page365 ซ้ำ...', '🧹', 30);
    const r = removePage365Duplicates(); // dry-run
    ui.alert('🔍 พรีวิว Page365 ซ้ำ',
      'พบแถว Page365 ที่ tracking ซ้ำกับ marketplace อื่น: ' + (r.candidates || 0) + ' แถว\n\n' +
      (r.candidates > 0 ? 'กด "2️⃣ ลบ Page365 ซ้ำ" เพื่อแก้จริง' : 'ไม่มีของซ้ำ ✅'), ui.ButtonSet.OK);
  } catch(e) { ui.alert('❌ ผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK); }
}

// 2️⃣ ลบ Page365 ซ้ำจริง (มี confirm)
function menu365Apply() {
  const ui = SpreadsheetApp.getUi();
  try {
    const pre = removePage365Duplicates(); // นับก่อน
    if (!pre.candidates) { ui.alert('✅ ไม่มี Page365 ซ้ำ', 'ไม่ต้องแก้อะไร', ui.ButtonSet.OK); return; }
    const ok = ui.alert('⚠️ ยืนยันลบ Page365 ซ้ำ',
      'จะลบแถว Page365 ที่ tracking ซ้ำกับ native จำนวน ' + pre.candidates + ' แถว\n' +
      '(เก็บ native ไว้) แล้วอัปเดตหน้าแสกนให้\n\nยืนยันลบ?', ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังลบ + อัปเดต /pending...', '🧹', 60);
    const r = removePage365Duplicates({ apply: true });
    ui.alert('✅ ลบเสร็จ', 'ลบ ' + (r.removed || 0) + ' แถว + อัปเดตหน้าแสกนแล้ว', ui.ButtonSet.OK);
  } catch(e) { ui.alert('❌ ผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK); }
}

// 3️⃣ พรีวิว: ออเดอร์ที่แพคแล้วแสกนสินค้าเกิน (ไม่แก้)
function menuOverScanPreview() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังตรวจออเดอร์แสกนเกิน (วันนี้)...', '🩹', 60);
    const r = auditOverScannedOrders(); // dry-run, วันนี้
    const sample = (r.detail || []).slice(0, 15)
      .map(d => '• ' + d.tracking + ': ' + d.before + '→' + d.after + ' [' + d.cap + ']').join('\n');
    ui.alert('🔍 พรีวิว สินค้าเกิน (วันนี้)',
      'ตรวจ ' + (r.scanned || 0) + ' ออเดอร์ · เจอเกิน ' + (r.overScanned || 0) + ' ใบ\n\n' +
      (r.overScanned > 0 ? sample + ((r.detail || []).length > 15 ? '\n...อีก ' + (r.detail.length - 15) + ' ใบ' : '') +
        '\n\nกด "4️⃣ แก้สินค้าเกิน" เพื่อแก้จริง' : 'ไม่มีออเดอร์เกิน ✅'), ui.ButtonSet.OK);
  } catch(e) { ui.alert('❌ ผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK); }
}

// 4️⃣ แก้สินค้าเกินจริง + rebuild Firebase (มี confirm)
function menuOverScanApply() {
  const ui = SpreadsheetApp.getUi();
  try {
    const pre = auditOverScannedOrders(); // นับก่อน (วันนี้)
    if (!pre.overScanned) { ui.alert('✅ ไม่มีออเดอร์เกิน', 'ไม่ต้องแก้อะไร (วันนี้)', ui.ButtonSet.OK); return; }
    const ok = ui.alert('⚠️ ยืนยันแก้สินค้าเกิน',
      'จะ cap จำนวนสินค้าใน ' + pre.overScanned + ' ออเดอร์ (วันนี้) ลงเหลือค่าจริง\n' +
      'แล้วอัปเดต Firebase (รายงาน + ค้นหา) ให้\n\n💡 ทำ "2️⃣ ลบ Page365 ซ้ำ" ก่อนเสมอ\n\nยืนยันแก้?', ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    SpreadsheetApp.getActiveSpreadsheet().toast('กำลังแก้ + rebuild Firebase...', '🩹', 120);
    const r = auditOverScannedOrders({ apply: true });
    ui.alert('✅ แก้เสร็จ', 'แก้ ' + (r.fixed || 0) + ' ออเดอร์ + อัปเดต Firebase /stats + /orders แล้ว', ui.ButtonSet.OK);
  } catch(e) { ui.alert('❌ ผิดพลาด', String(e && e.message || e), ui.ButtonSet.OK); }
}

// กัน Drive bombing — base64 ~24MB ≈ raw video ~18MB
const MAX_VIDEO_BASE64_LEN = 24 * 1024 * 1024; // ~18MB raw — client อัดที่ 1.2Mbps พอ ~2 นาที/ใบ

// ✅ Marker สำหรับ row placeholder (legacy — ไม่มีการสร้างใหม่แล้ว)
//    saveData ยังเช็ค/"upgrade" row แบบนี้ไว้ เผื่อมี placeholder เก่าค้างในชีต
const PLACEHOLDER_MARKER = "__VIDEO_FIRST__ waiting for order data";

// ✅ Cache-based dedup — แทนการอ่าน column tracking ทั้งหมดจาก sheet
//    เดิม: scan 16K rows ใน lock = 1-3s → lock_timeout
//    ใหม่: CacheService.get() = 10ms → lock hold time ~700ms
//    ค่าใน cache: "<rowIndex>" สำหรับ row ปกติ, "P:<rowIndex>" สำหรับ placeholder
const PARCEL_CACHE_PREFIX = 'parcel_';
const PARCEL_CACHE_TTL_SEC = 6 * 60 * 60; // 6 ชม.
const FALLBACK_SCAN_RECENT_ROWS = 2000;   // ถ้า cache miss → scan แค่ 2000 แถวล่าสุด (ไม่ใช่ทั้ง 16K+)
// ⏱️ Timestamp = "เวลาแพค" → ชีตไม่ได้เรียงเวลาเป๊ะ (drain ลำดับ ≠ เวลาแพค + มี straggler)
//   bottom-up scan จึง "หยุดเมื่อเจอแถวเก่าติดกัน N แถว" แทนหยุดทันที → ทน straggler เดี่ยว/กลุ่มเล็ก
const SCAN_OOO_LIMIT = 1500;
// cleanUpOldOrders: ไม่ลบ row ที่อยู่ "ท้ายชีต" N แถว (เพิ่ง append) แม้เวลาแพคเก่า — กันลบ straggler ที่เพิ่งกู้เข้ามา
const CLEANUP_PROTECT_TAIL_ROWS = 3000;

function _getCachedParcelRow(parcelId) {
  try {
    const v = CacheService.getScriptCache().get(PARCEL_CACHE_PREFIX + parcelId.toUpperCase());
    if (!v) return null;
    if (v.indexOf('P:') === 0) {
      return { rowIndex: parseInt(v.slice(2), 10), isPlaceholder: true };
    }
    return { rowIndex: parseInt(v, 10), isPlaceholder: false };
  } catch(e) {
    return null;
  }
}

function _setCachedParcelRow(parcelId, rowIndex, isPlaceholder) {
  try {
    const v = (isPlaceholder ? 'P:' : '') + String(rowIndex);
    CacheService.getScriptCache().put(PARCEL_CACHE_PREFIX + parcelId.toUpperCase(), v, PARCEL_CACHE_TTL_SEC);
  } catch(e) {
    Logger.log("[_setCachedParcelRow] cache error: " + e.message);
  }
}

function _clearCachedParcelRow(parcelId) {
  try {
    CacheService.getScriptCache().remove(PARCEL_CACHE_PREFIX + parcelId.toUpperCase());
  } catch(e) {}
}

// ============================================================
// 🔥 FIREBASE INBOX DRAIN — durable safety net
//   client เขียนออเดอร์ลง Firebase RTDB /inbox/{idemToken} ด้วย
//   ฟังก์ชันนี้ (cron ทุก 1 นาที) ดูดเข้า Orders sheet → ออเดอร์ไม่หายแม้เครื่องหาย
//   ตั้งค่าครั้งเดียว: รัน setupFirebase() ใน editor (ใส่ URL + secret)
// ============================================================
function setupFirebase() {
  // ✏️ แก้ 2 ค่านี้ก่อนรัน:
  const DB_URL = "https://lamsang-scanner-default-rtdb.asia-southeast1.firebasedatabase.app";   // เช่น https://xxx-default-rtdb.asia-southeast1.firebasedatabase.app
  const DB_SECRET = "K9JldzYRGdygmQhpUtjdC3aGTv8pr6UzYTg1mBMT"; // Firebase console → Project settings → Service accounts → Database secrets
  if (DB_URL.indexOf("PASTE") === 0 || DB_SECRET.indexOf("PASTE") === 0) {
    throw new Error("กรุณาแก้ DB_URL และ DB_SECRET ในโค้ดก่อนรัน");
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('FIREBASE_DB_URL', DB_URL.replace(/\/$/, ''));
  props.setProperty('FIREBASE_SECRET', DB_SECRET);
  Logger.log("✅ Firebase ตั้งค่าแล้ว: " + DB_URL);
}

function _firebaseCfg() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: props.getProperty('FIREBASE_DB_URL') || '',
    secret: props.getProperty('FIREBASE_SECRET') || ''
  };
}

// ✅ cron — ดูด /inbox เข้า sheet แบบ BATCH (เร็ว) แล้วลบ doc ทีเดียว
//   เดิม: เรียก saveData ทีละ doc → scan ชีต 2000 แถว + log + lock ทุก doc → ช้ามาก
//   ใหม่: อ่าน tracking ในชีตครั้งเดียว → append รวด (lock เดียว) → ลบ doc ทีเดียว
function drainFirebaseInbox(opts) {
  // onDemand = เรียกจากแอป (doPost action "drainInbox") → non-blocking ไม่ค้างถ้าตัวอื่นรันอยู่
  //   trigger ส่ง event object เป็น arg แรก → (opts === true) เป็น false → โหมด blocking ปกติ
  const onDemand = (opts === true);
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) { Logger.log("[drainFirebase] ยังไม่ได้ setupFirebase()"); return { success: false, error: "no firebase cfg" }; }

  const lock = LockService.getDocumentLock();
  try { if (!lock.tryLock(onDemand ? 1 : 5000)) { Logger.log("[drainFirebase] ตัวก่อนยังรันอยู่ ข้าม"); return { success: true, skipped: "busy" }; } }
  catch(e) { return { success: false, error: e.message }; }

  try {
    const listUrl = cfg.url + "/inbox.json?auth=" + encodeURIComponent(cfg.secret);
    const resp = UrlFetchApp.fetch(listUrl, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log("[drainFirebase] list fail: " + resp.getResponseCode() + " " + resp.getContentText().slice(0, 200));
      return;
    }
    const body = resp.getContentText();
    if (!body || body === "null") return;
    let docs;
    try { docs = JSON.parse(body); } catch(e) { Logger.log("[drainFirebase] bad json"); return; }
    const keys = Object.keys(docs || {});
    if (keys.length === 0) return { success: true, drained: 0, deleted: 0 };
    Logger.log("[drainFirebase] พบ " + keys.length + " docs");

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS) || ss.insertSheet(SHEET_ORDERS);

    // อ่าน tracking ที่อยู่ในชีตแล้ว "ครั้งเดียว" (ไม่ scan ซ้ำทุก doc)
    const existing = new Set();
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const colD = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
      colD.forEach(r => { const t = numToStr(r[0]).toUpperCase(); if (t) existing.add(t); });
    }

    const MAX_PER_RUN = 500;
    // ⏳ grace — doc ที่ "ออเดอร์ยังไม่อยู่ในชีต + ยังใหม่กว่านี้" → ยังไม่ drain
    //   ให้ direct saveData (เขียน row พร้อม link วิดีโอ) ทำเสร็จก่อน drain จะ fallback no_video
    const DRAIN_GRACE_MS = 25000;
    const nowMs = Date.now();
    const delKeys = {};              // doc ที่ process แล้ว → ลบทีเดียว
    const newRows = [];              // row ใหม่ที่จะ append
    const newTokens = [];            // token ที่ต้อง mark completed
    const ordersMirror = {};         // 🔍 เขียน /orders มิเรอร์พร้อมกัน → search เห็นทันที (ไม่รอ mirror 5 นาที)
    const seenInBatch = new Set();
    const statsDelta = {};           // 📊 "date/path" -> จำนวน → atomic increment เข้า /stats (รายงานสดทันที)
    const statsTz = Session.getScriptTimeZone();
    let processed = 0;

    for (let i = 0; i < keys.length && processed < MAX_PER_RUN; i++) {
      const key = keys[i];
      const d = docs[key] || {};
      const parcelId = String(d.parcelId || "").trim();
      processed++;

      if (!parcelId || parcelId.length > 64 || parcelId === "__DIAGTEST__") { delKeys[key] = null; continue; }
      const tk = parcelId.toUpperCase();

      // มีในชีตแล้ว / token เสร็จแล้ว / ซ้ำใน batch → แค่ลบ doc (ไม่ append)
      if (existing.has(tk) || seenInBatch.has(tk) || (d.idemToken && _isCompletedToken(d.idemToken))) {
        delKeys[key] = null; continue;
      }

      // ⏳ doc มีวิดีโอแต่ยังไม่ได้ videoUrl (client กำลังอัป Drive) + ยังใหม่ → รอรอบหน้า
      //   ให้ client PATCH videoUrl เข้ามาก่อน → drain เขียน row "พร้อม link" ครั้งเดียว
      //   เกิน grace แล้วยังไม่มี url (อัปวิดีโอล้ม) → เขียน no_video กู้ไว้ (retry/reconcile เก็บตก)
      const videoUrl = String(d.videoUrl || "");
      if (d.hadVideo && !videoUrl && Number(d.ts) && (nowMs - Number(d.ts)) < DRAIN_GRACE_MS) { continue; }

      // normalize items (RTDB คืน array เป็น object ได้)
      let itemsArr;
      if (Array.isArray(d.items)) itemsArr = d.items.filter(x => x != null);
      else if (d.items && typeof d.items === 'object') itemsArr = Object.values(d.items).filter(x => x != null);
      else itemsArr = [];

      seenInBatch.add(tk);
      // ⏱️ ใช้ "เวลาแพค" (d.ts จาก Firebase) เป็น Timestamp ของ row — ไม่ใช่เวลาที่ drain เขียน
      const packTime = (Number(d.ts) > 0) ? new Date(Number(d.ts)) : new Date();
      newRows.push([packTime, String(d.orderId || ""), String(d.marketplace || ""), parcelId,
                    videoUrl || "no_video", String(d.remark || ""), itemsArr.length, ...itemsArr.slice(0, 500).map(String)]);
      // 🔍 มิเรอร์ /orders จากข้อมูล /inbox ที่มีอยู่ในมือ — ไม่ต้องวนกลับไปอ่านชีต
      ordersMirror[_fbKey(tk)] = {
        ts: Number(d.ts) || Date.now(), tk: parcelId, oid: String(d.orderId || ""),
        mp: String(d.marketplace || "").trim().toLowerCase(), v: videoUrl || "",
        rm: String(d.remark || ""), it: itemsArr.slice(0, 500).map(String)
      };
      // 📊 สะสม stats delta — นับ "เป๊ะเหมือน" _computeStatsForDates (date=เวลาแพค, mp lowercase, sku=_fbKey)
      //    → atomic increment เข้า /stats หลังเขียน row สำเร็จ ทำให้รายงานสดทันทีไม่ต้องรอรอบ 5 นาที
      const dayKey = Utilities.formatDate(packTime, statsTz, "yyyy-MM-dd");
      const mpKey  = (String(d.marketplace || "").trim().toLowerCase()) || "other";
      statsDelta[dayKey + "/orders"] = (statsDelta[dayKey + "/orders"] || 0) + 1;
      statsDelta[dayKey + "/mp/" + mpKey + "/orders"] = (statsDelta[dayKey + "/mp/" + mpKey + "/orders"] || 0) + 1;
      let itemCnt = 0;
      itemsArr.slice(0, 500).forEach(it => {
        const v = String(it).trim();
        if (!v) return;
        itemCnt++;
        const sk = _fbKey(v.toUpperCase());
        statsDelta[dayKey + "/sku/" + sk] = (statsDelta[dayKey + "/sku/" + sk] || 0) + 1;
      });
      if (itemCnt > 0) {
        statsDelta[dayKey + "/items"] = (statsDelta[dayKey + "/items"] || 0) + itemCnt;
        statsDelta[dayKey + "/mp/" + mpKey + "/items"] = (statsDelta[dayKey + "/mp/" + mpKey + "/items"] || 0) + itemCnt;
      }
      if (d.idemToken) newTokens.push({ token: d.idemToken, parcelId: parcelId });
      delKeys[key] = null;
    }

    // เขียน row ใหม่ทั้งหมด "ใต้ lock เดียว" (appendRow auto-extend)
    if (newRows.length > 0) {
      const slock = LockService.getScriptLock();
      try { slock.waitLock(onDemand ? 8000 : 30000); } catch(e) {
        Logger.log("[drainFirebase] ไม่ได้ script lock — ข้ามรอบนี้"); return { success: true, skipped: "script lock" };
      }
      try {
        // เขียนทีเดียวด้วย setValues (เร็วกว่า appendRow-ต่อแถวหลายสิบเท่า — กัน timeout/quota ตอน backlog เยอะ)
        //   row ยาวไม่เท่ากัน (จำนวน item ต่างกัน) → หา maxCols แล้ว pad ด้วย "" ให้เป็นสี่เหลี่ยม
        //   setValues ไม่ auto-extend → ต้องเพิ่ม row/column ให้พอเองก่อน (appendRow ทำให้อัตโนมัติ)
        let maxCols = 0;
        for (let r = 0; r < newRows.length; r++) if (newRows[r].length > maxCols) maxCols = newRows[r].length;
        const startRow = sheet.getLastRow() + 1;
        const needRows = startRow + newRows.length - 1;
        if (sheet.getMaxRows() < needRows) sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
        if (sheet.getMaxColumns() < maxCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), maxCols - sheet.getMaxColumns());
        const padded = newRows.map(row => row.length < maxCols ? row.concat(new Array(maxCols - row.length).fill("")) : row);
        sheet.getRange(startRow, 1, padded.length, maxCols).setValues(padded);
        SpreadsheetApp.flush();
        for (let r = 0; r < newRows.length; r++) _setCachedParcelRow(newRows[r][3], startRow + r, false);
        newTokens.forEach(x => _markTokenCompleted(x.token));
      } finally { try { slock.releaseLock(); } catch(_) {} }

      // 🔍 เขียน /orders มิเรอร์ "ตอนเดียวกับที่เขียนชีต" → search เห็นออเดอร์ใหม่ในไม่กี่วิ
      //   (ไม่ต้องรอ refreshRecentStats mirror รอบ 5 นาที — ตัด round-trip ชีต→มิเรอร์ออก)
      try {
        UrlFetchApp.fetch(cfg.url + "/orders.json?auth=" + encodeURIComponent(cfg.secret), {
          method: "patch", contentType: "application/json",
          payload: JSON.stringify(ordersMirror), muteHttpExceptions: true
        });
      } catch(e) { Logger.log("[drainFirebase] /orders mirror error: " + e.message); }

      // 📊 atomic increment /stats — รายงานเด้งทันที (refreshRecentStats ยัง PUT ค่า exact กัน drift)
      //    multi-path PATCH: key เป็น deep path, value เป็น server-value increment
      const statPaths = Object.keys(statsDelta);
      if (statPaths.length > 0) {
        const incPayload = {};
        statPaths.forEach(p => { incPayload[p] = { ".sv": { "increment": statsDelta[p] } }; });
        try {
          UrlFetchApp.fetch(cfg.url + "/stats.json?auth=" + encodeURIComponent(cfg.secret), {
            method: "patch", contentType: "application/json",
            payload: JSON.stringify(incPayload), muteHttpExceptions: true
          });
        } catch(e) { Logger.log("[drainFirebase] /stats increment error: " + e.message); }
      }
    }

    // ลบ doc ที่ process แล้วทั้งหมด "ทีเดียว" (multi-path PATCH = null)
    const delCount = Object.keys(delKeys).length;
    if (delCount > 0) {
      try {
        UrlFetchApp.fetch(cfg.url + "/inbox.json?auth=" + encodeURIComponent(cfg.secret), {
          method: "patch", contentType: "application/json",
          payload: JSON.stringify(delKeys), muteHttpExceptions: true
        });
      } catch(e) { Logger.log("[drainFirebase] batch delete error: " + e.message); }
    }

    Logger.log("[drainFirebase] เขียนใหม่ " + newRows.length + " | ลบ doc " + delCount);
    if (newRows.length > 0) _logSaveAttempt("", "", "firebase_drain", newRows.length, "drained=" + newRows.length + " deleted=" + delCount);
    return { success: true, drained: newRows.length, deleted: delCount };
  } catch(e) {
    Logger.log("[drainFirebase] error: " + e.message);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

// 🔧 เคลียร์ /inbox ที่กองค้างทั้งหมดในรันเดียว — ใช้ตอน backlog เยอะ (รันจาก editor)
//    drainFirebaseInbox ทำได้รอบละ ≤500 ใบ → ตัวนี้วนเรียกจนเกลี้ยง
//    แนะนำ: ลบ trigger drainFirebaseInbox 1 นาทีชั่วคราวก่อนรัน กันยิงซ้อนแย่ง lock
function drainInboxUntilEmpty() {
  let total = 0, busy = 0;
  for (let i = 0; i < 40; i++) {              // กันลูปไม่จบ — 40 × 500 = 20,000 ใบ
    const r = drainFirebaseInbox();           // blocking mode (รอ lock 5s)
    if (r && r.skipped === "busy") {          // มี drain อื่นถือ lock อยู่ (เช่น trigger) → รอแล้วลองใหม่
      if (++busy > 10) { Logger.log("[drainAll] busy เกินไป — หยุด (ลบ trigger 1 นาทีก่อนแล้วลองใหม่)"); break; }
      Utilities.sleep(3000); continue;
    }
    busy = 0;
    total += (r && r.drained) || 0;
    Logger.log("[drainAll] รอบ " + (i + 1) + ": drained=" + ((r && r.drained) || 0) +
               " deleted=" + ((r && r.deleted) || 0) + " | รวม " + total);
    if (!r || (r.deleted || 0) === 0) break;  // ไม่มี doc ให้ลบแล้ว = เกลี้ยง (เหลือแต่ที่ติด grace 25s รอรอบ trigger)
  }
  Logger.log("[drainAll] ✅ เสร็จ — เขียนชีตรวม " + total + " แถว");
  return total;
}

// ====== DRAIN /mpInbox → MarketplaceData sheet (อัปไฟล์ marketplace ผ่าน Firebase) ======
//   client อัปไฟล์ → push /mpInbox (เร็ว) → ฟังก์ชันนี้เขียนลงชีต (dedup อ่านครั้งเดียว) แล้วลบ doc
//   คืนจำนวนแถวที่เขียนใหม่ — caller ค่อยเรียก refreshPendingCache(true) ให้ /pending + ทุกเครื่องอัปเดต
function drainMpInbox() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return 0;
  const lock = LockService.getDocumentLock();
  try { if (!lock.tryLock(3000)) return 0; } catch(e) { return 0; }
  try {
    const resp = UrlFetchApp.fetch(cfg.url + "/mpInbox.json?auth=" + encodeURIComponent(cfg.secret), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return 0;
    const body = resp.getContentText();
    if (!body || body === "null") return 0;
    let docs; try { docs = JSON.parse(body); } catch(e) { return 0; }
    const keys = Object.keys(docs || {});
    if (keys.length === 0) return 0;

    const sheet = setupMarketplaceSheet();

    // 🔒 ถือ ScriptLock "ครอบทั้ง dedup-read + write" = lock ตัวเดียวกับ saveMarketplaceData
    //    กัน cross-path race: เดิม drainMpInbox อ่าน existingKeys "นอก lock" + ใช้ DocumentLock
    //    ส่วน saveMarketplaceData ใช้ ScriptLock → ทั้งคู่ dedup-read เห็น "ยังไม่มี" พร้อมกัน → เขียนซ้ำ
    const slock = LockService.getScriptLock();
    try { slock.waitLock(30000); } catch(e) { Logger.log("[drainMpInbox] script lock timeout"); return 0; }
    const ts = new Date();
    const newRows = [];
    const delKeys = {};
    try {
      // dedup keys (tracking|sku|orderId) — อ่านทั้งชีต "ครั้งเดียว" ใต้ lock
      const existingKeys = new Set();
      const lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        const slice = sheet.getRange(2, 3, lastRow - 1, 5).getValues(); // C..G
        for (let i = 0; i < slice.length; i++) {
          existingKeys.add(numToStr(slice[i][0]).toUpperCase() + '|' + numToStr(slice[i][1]).toUpperCase() + '|' + numToStr(slice[i][4]));
        }
      }
      keys.forEach(k => {
        delKeys[k] = null;
        const d = docs[k] || {};
        const mp = String(d.marketplace || "").slice(0, 32);
        let rows = Array.isArray(d.rows) ? d.rows : (d.rows && typeof d.rows === 'object' ? Object.values(d.rows) : []);
        rows.forEach(item => {
          if (!item || typeof item !== 'object') return;
          const t   = String(item.tracking || "").trim().toUpperCase();
          const sku = String(item.sku || "").trim().toUpperCase();
          const oid = String(item.orderId || "").trim();
          if (!t || !sku) return;
          const key = t + '|' + sku + '|' + oid;
          if (existingKeys.has(key)) return;
          existingKeys.add(key);
          newRows.push([ts, mp || String(item.marketplace || ""), "'" + t, "'" + sku,
                        Number(item.qty) || 1, String(item.remark || "").trim().slice(0, 500), "'" + oid]);
        });
      });
      if (newRows.length > 0) {
        const startRow = sheet.getLastRow() + 1;
        const needRows = startRow + newRows.length - 1; // setValues ไม่ auto-extend → เพิ่มแถวให้พอก่อน (กัน error เกินขอบชีตตอนไฟล์ใหญ่)
        if (sheet.getMaxRows() < needRows) sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
        sheet.getRange(startRow, 1, newRows.length, 7).setValues(newRows);
        SpreadsheetApp.flush();
      }
    } finally { try { slock.releaseLock(); } catch(_) {} }

    // ลบ batch ที่ process แล้วทั้งหมด (Firebase — นอก lock)
    UrlFetchApp.fetch(cfg.url + "/mpInbox.json?auth=" + encodeURIComponent(cfg.secret), {
      method: "patch", contentType: "application/json", payload: JSON.stringify(delKeys), muteHttpExceptions: true
    });
    Logger.log("[drainMpInbox] เขียน " + newRows.length + " แถว จาก " + keys.length + " batch");
    if (newRows.length > 0) _logSaveAttempt("", "", "mp_drain", newRows.length, "batches=" + keys.length);
    return newRows.length;
  } catch(e) {
    Logger.log("[drainMpInbox] error: " + e.message);
    return 0;
  } finally { try { lock.releaseLock(); } catch(_) {} }
}

// 🧹 ลบแถวซ้ำใน MarketplaceData (key = tracking|sku|orderId) — เก็บแถว "แรก" ของแต่ละ key
//   ใช้แก้ข้อมูลที่ซ้ำไปแล้ว (รันครั้งเดียวจาก editor) — getAllPendingOrders รวม qty ตาม tracking+sku
//   ⇒ แถวซ้ำ exact-key ทำให้ qty บานตามจำนวนครั้งที่อัปซ้ำ ; ลบแล้ว qty กลับมาถูก
//   รักษา order line ที่ orderId ต่างกันไว้ (ไม่ถือว่าซ้ำ) ; ลบเฉพาะ key เป๊ะเดียวกัน
function dedupeMarketplaceData() {
  let deleted = 0;
  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); } catch(e) { Logger.log("[dedupeMP] ไม่ได้ lock: " + e.message); return 0; }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_MARKETPLACE);
    if (!sheet) { Logger.log("[dedupeMP] ไม่พบชีต"); return 0; }
    const lastRow = sheet.getLastRow();
    if (lastRow < 3) { Logger.log("[dedupeMP] แถวน้อย ข้าม"); return 0; }
    const data = sheet.getRange(2, 3, lastRow - 1, 5).getValues(); // C..G (tracking, sku, qty, remark, orderId)
    const seen = new Set();
    const dupRows = []; // sheet row numbers ที่ต้องลบ
    for (let i = 0; i < data.length; i++) {
      const t = numToStr(data[i][0]).toUpperCase();
      const s = numToStr(data[i][1]).toUpperCase();
      const o = numToStr(data[i][4]);
      if (!t || !s) continue;
      const key = t + '|' + s + '|' + o;
      if (seen.has(key)) dupRows.push(i + 2); // ซ้ำ → คิวลบ (เก็บตัวแรกไว้)
      else seen.add(key);
    }
    if (dupRows.length === 0) { Logger.log("[dedupeMP] ✅ ไม่มีแถวซ้ำ (unique " + seen.size + ")"); return 0; }
    // ลบจากล่างขึ้นบนแบบ contiguous ranges (เร็ว + index ไม่เลื่อน)
    dupRows.sort((a, b) => b - a);
    let i = 0;
    while (i < dupRows.length) {
      const top = dupRows[i]; let count = 1;
      while (i + 1 < dupRows.length && dupRows[i + 1] === top - count) { count++; i++; }
      sheet.deleteRows(top - count + 1, count);
      deleted += count;
      i++;
    }
    SpreadsheetApp.flush();
    Logger.log("[dedupeMP] ✅ ลบแถวซ้ำ " + deleted + " แถว เหลือ unique " + seen.size);
  } catch(e) {
    Logger.log("[dedupeMP] error: " + e.message);
  } finally { try { lock.releaseLock(); } catch(_) {} }
  // refresh /pending หลังลบ (นอก lock) → หน้าแสกนเห็น qty ถูกทันที
  if (deleted > 0) { try { refreshPendingCache(true); } catch(e) { Logger.log("[dedupeMP] refresh fail: " + e.message); } }
  return deleted;
}

// ลบแถว page365 ที่ tracking ซ้ำกับ marketplace native — Page365 รวมออเดอร์ tiktok/shopee/lazada มาด้วย
//   พนักงานอัปไฟล์ 365 "ทั้งไฟล์" (ไม่กรองเฉพาะ 365) → tracking เดียวมาทั้งจาก 365 + native → ซ้ำ
//   กฎ: 1 tracking = 1 พัสดุ ; ถ้ามี native (tiktok/shopee/lazada) แล้ว → แถว page365 ของ tracking นั้น = ซ้ำ
//   คืน { candidates, removed } ; ไม่ refresh /pending (ให้ caller จัดการ — กัน recursion)
// หา sheet row numbers ของแถว page365 ที่ tracking มี native ด้วย (อ่านอย่างเดียว)
function _scan365DupRows(sheet) {
  if (sheet.getLastRow() < 2) return [];
  const data = sheet.getRange(2, 2, sheet.getLastRow() - 1, 2).getValues(); // B,C = marketplace, tracking
  const hasNative = {}; // tracking → มี marketplace ที่ไม่ใช่ page365
  for (let i = 0; i < data.length; i++) {
    const mk = String(data[i][0] || "").trim().toLowerCase();
    const tk = numToStr(data[i][1]).toUpperCase();
    if (tk && mk && mk !== "page365") hasNative[tk] = true;
  }
  const delRows = [];
  for (let i = 0; i < data.length; i++) {
    const mk = String(data[i][0] || "").trim().toLowerCase();
    const tk = numToStr(data[i][1]).toUpperCase();
    if (mk === "page365" && tk && hasNative[tk]) delRows.push(i + 2);
  }
  return delRows;
}

function _removePage365DupRows(apply) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MARKETPLACE);
  if (!sheet) return { candidates: 0, removed: 0 };
  // pre-check แบบ lock-free → ส่วนใหญ่ไม่มีซ้ำ จะได้ไม่จับ lock เปล่าทุกรอบ refresh
  const pre = _scan365DupRows(sheet);
  if (!apply || pre.length === 0) {
    Logger.log("[rm365] page365 ที่ซ้ำกับ native: " + pre.length + " แถว" + (apply ? "" : " (DRY-RUN)"));
    return { candidates: pre.length, removed: 0 };
  }
  const slock = LockService.getScriptLock();
  try { slock.waitLock(45000); } catch(e) { Logger.log("[rm365] ไม่ได้ lock"); return { candidates: pre.length, removed: 0, error: "lock" }; }
  try {
    const delRows = _scan365DupRows(sheet); // re-scan ใต้ lock (กัน index เลื่อนจาก write ระหว่างนั้น)
    if (delRows.length === 0) return { candidates: 0, removed: 0 };
    delRows.sort((a, b) => b - a); // ลบล่าง→บน แบบ contiguous ranges
    let removed = 0, i = 0;
    while (i < delRows.length) {
      const top = delRows[i]; let count = 1;
      while (i + 1 < delRows.length && delRows[i + 1] === top - count) { count++; i++; }
      sheet.deleteRows(top - count + 1, count);
      removed += count; i++;
    }
    SpreadsheetApp.flush();
    Logger.log("[rm365] ✅ ลบแถว page365 ซ้ำ (มี native แล้ว) " + removed + " แถว");
    return { candidates: delRows.length, removed: removed };
  } catch(e) {
    Logger.log("[rm365] error: " + e.message);
    return { candidates: 0, removed: 0, error: e.message };
  } finally { try { slock.releaseLock(); } catch(_) {} }
}

// public — dry-run (ดีฟอลต์) / apply + refresh /pending ; เรียกจาก editor
//   removePage365Duplicates()  หรือ  removePage365Duplicates({ apply: true })
function removePage365Duplicates(opts) {
  opts = opts || {};
  const r = _removePage365DupRows(opts.apply === true);
  if (opts.apply === true && r.removed > 0) {
    try { refreshPendingCache(true); } catch(e) { Logger.log("[rm365] refresh fail: " + e.message); }
  }
  return r;
}

// normalize SKU เหมือนฝั่ง client (index.html normSku) — tiktok ตัวเลขล้วน → เติม "B"
function _normSku(sku, marketplace) {
  const s = String(sku || "").trim().toUpperCase();
  if (!s) return "";
  if (String(marketplace || "").toLowerCase() === "tiktok" && /^\d+$/.test(s)) return "B" + s;
  return s;
}

// 🩹 แก้ออเดอร์ "แสกนสินค้าเกิน" (พนักงานแสกนชิ้นเดิมซ้ำเพื่อปิดงาน ตอน expected บานจาก MarketplaceData ซ้ำ)
//   หลักการ: แอปบล็อกการแสกนเกิน reqItem.qty → จำนวนที่ stored = "expected ที่บาน" พอดี
//            ⇒ cap จำนวนแต่ละ sku ในแถว Orders ลงเหลือ "expected จริง (dedup)" = ได้ค่าถูกต้อง
//   - expected จริง = qty ต่อ (tracking, normSku) จาก MarketplaceData แบบ dedup key tracking|sku|orderId
//   - cap เฉพาะ sku ที่ตรง expected ; sku ที่ไม่อยู่ใน expected = ไม่แตะ (ปลอดภัย)
//   - dryRun (ดีฟอลต์) = รายงานเฉยๆ ; apply:true = แก้ชีต + rebuild /orders + /stats (Firebase แก้ตาม)
//   เรียก: auditOverScannedOrders()  หรือ  auditOverScannedOrders({ sinceDays: 1, apply: true })
function auditOverScannedOrders(opts) {
  opts = opts || {};
  const sinceDays = Number(opts.sinceDays) > 0 ? Number(opts.sinceDays) : 1;
  const apply = (opts.apply === true);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordSheet = ss.getSheetByName(SHEET_ORDERS);
  const mpSheet  = ss.getSheetByName(SHEET_MARKETPLACE);
  if (!ordSheet || !mpSheet) { Logger.log("[overscan] ไม่พบชีต"); return { error: "no sheet" }; }

  let slock = null;
  if (apply) {
    slock = LockService.getScriptLock();
    try { slock.waitLock(60000); } catch(e) { Logger.log("[overscan] ไม่ได้ lock — ยกเลิก"); return { error: "lock" }; }
  }
  try {
    // 1) expected[trackingUpper][normSku] = qty (dedup exact-key tracking|rawSku|orderId กัน row ซ้ำ)
    const expected = {};
    const mpLast = mpSheet.getLastRow();
    if (mpLast > 1) {
      const mp = mpSheet.getRange(2, 2, mpLast - 1, 6).getValues(); // B..G: marketplace, tracking, sku, qty, remark, orderId
      const seen = new Set();
      for (let i = 0; i < mp.length; i++) {
        const mk = String(mp[i][0] || "");
        const t  = numToStr(mp[i][1]).toUpperCase();
        const rawS = numToStr(mp[i][2]).toUpperCase();
        const q  = parseInt(mp[i][3]) || 1;
        const o  = numToStr(mp[i][5]);
        if (!t || !rawS) continue;
        const dk = t + '|' + rawS + '|' + o;
        if (seen.has(dk)) continue;       // row ซ้ำ exact-key → ไม่นับซ้ำ (= expected จริง)
        seen.add(dk);
        const ns = _normSku(rawS, mk);
        if (!expected[t]) expected[t] = {};
        expected[t][ns] = (expected[t][ns] || 0) + q;
      }
    }

    // 2) สแกน Orders ในช่วง sinceDays (bottom-up, ทน straggler) → หาแถวที่แสกนเกิน
    const tz = Session.getScriptTimeZone();
    const cutoff = Utilities.formatDate(new Date(Date.now() - (sinceDays - 1) * 86400000), tz, "yyyy-MM-dd");
    const lastRow = ordSheet.getLastRow();
    const lastCol = ordSheet.getLastColumn();
    const report = [];
    const affectedDates = {};
    let scanned = 0, fixedRows = 0, oooRun = 0, stop = false, row = lastRow;
    const CHUNK = 2000;
    while (row >= 2 && !stop) {
      const from = Math.max(2, row - CHUNK + 1);
      const data = ordSheet.getRange(from, 1, row - from + 1, lastCol).getValues();
      for (let i = data.length - 1; i >= 0; i--) {
        const ts = data[i][0];
        if (!(ts instanceof Date)) continue;
        const dayKey = Utilities.formatDate(ts, tz, "yyyy-MM-dd");
        if (dayKey < cutoff) { if (++oooRun >= SCAN_OOO_LIMIT) { stop = true; break; } continue; }
        oooRun = 0;
        const remark = String(data[i][5] || "");
        if (remark.indexOf("__VIDEO_FIRST__") === 0) continue;
        const tracking = numToStr(data[i][3]).toUpperCase();
        if (!tracking) continue;
        const exp = expected[tracking];
        if (!exp) continue;                // ไม่มี expected (MarketplaceData ถูก prune ฯลฯ) → ข้าม ไม่เสี่ยงแก้
        scanned++;
        // นับ sku ที่แสกนในแถวนี้ (col 8+)
        const counts = {}; const order = [];
        for (let c = 7; c < data[i].length; c++) {
          const v = String(data[i][c]).trim().toUpperCase();
          if (!v) continue;
          if (counts[v] === undefined) order.push(v);
          counts[v] = (counts[v] || 0) + 1;
        }
        // cap แต่ละ sku ที่ตรง expected
        let changed = false; const cap = []; const newCounts = {};
        order.forEach(sku => {
          const c = counts[sku], e = exp[sku];
          if (e !== undefined && c > e) { newCounts[sku] = e; changed = true; cap.push(sku + ' ' + c + '→' + e); }
          else newCounts[sku] = c;
        });
        if (!changed) continue;
        const sheetRow = from + i;
        const before = order.reduce((s, k) => s + counts[k], 0);
        const newItems = [];
        order.forEach(sku => { for (let k = 0; k < newCounts[sku]; k++) newItems.push(sku); });
        report.push({ row: sheetRow, tracking: tracking, date: dayKey, before: before, after: newItems.length, cap: cap.join(', ') });
        affectedDates[dayKey] = true;
        if (apply) {
          const oldWidth = data[i].length - 7;                // จำนวนช่อง item เดิม (รวมช่องว่างท้าย)
          const out = [newItems.length].concat(newItems);     // col7=count, col8+=items
          while (out.length < 1 + oldWidth) out.push("");      // pad ลบ item เก่าที่เกิน
          ordSheet.getRange(sheetRow, 7, 1, out.length).setValues([out]);
          fixedRows++;
        }
      }
      row = from - 1;
    }

    Logger.log("[overscan] scanned=" + scanned + " ออเดอร์ใน " + sinceDays + " วัน | เกิน=" + report.length +
               (apply ? (" | แก้แล้ว=" + fixedRows) : " (DRY-RUN — ยังไม่แก้)"));
    report.slice(0, 80).forEach(r => Logger.log("  • " + r.tracking + " (" + r.date + ") row " + r.row + ": " + r.before + "→" + r.after + " [" + r.cap + "]"));
    if (report.length > 80) Logger.log("  ...อีก " + (report.length - 80) + " ออเดอร์");

    if (apply && fixedRows > 0) {
      SpreadsheetApp.flush();
      const dates = Object.keys(affectedDates);
      _putStatsForDates(dates);     // 📊 recompute /stats exact → ทับค่า inline ที่บาน
      _mirrorOrdersForDates(dates); // 🔍 rebuild /orders → search/ตาราง เห็น item ถูก
      Logger.log("[overscan] ✅ rebuild Firebase /stats + /orders แล้ว: " + dates.join(", "));
    }
    return { scanned: scanned, overScanned: report.length, fixed: apply ? fixedRows : 0, dryRun: !apply, detail: report.slice(0, 200) };
  } catch(e) {
    Logger.log("[overscan] error: " + e.message);
    return { error: e.message };
  } finally { if (slock) { try { slock.releaseLock(); } catch(_) {} } }
}

// ============================================================
// ▶️ ปุ่มรันจาก editor — เลือกชื่อจาก dropdown บนสุด แล้วกด Run (รันตามเลข 1→4)
//    editor ส่ง argument ไม่ได้ → ใช้ wrapper พวกนี้แทนการพิมพ์ {apply:true}
//    ดูผลที่ "Execution log" (View → Logs / ปุ่มล่าง)
// ============================================================
function RUN_1_ลบ365ซ้ำ_พรีวิว()    { const r = removePage365Duplicates();              Logger.log("ผล: " + JSON.stringify(r)); return r; }
function RUN_2_ลบ365ซ้ำ_แก้จริง()   { const r = removePage365Duplicates({ apply: true }); Logger.log("ผล: " + JSON.stringify(r)); return r; }
function RUN_3_แก้สินค้าเกิน_พรีวิว() { const r = auditOverScannedOrders();                Logger.log("ผล: " + JSON.stringify({scanned:r.scanned, overScanned:r.overScanned, dryRun:r.dryRun})); return r; }
function RUN_4_แก้สินค้าเกิน_แก้จริง(){ const r = auditOverScannedOrders({ apply: true }); Logger.log("ผล: " + JSON.stringify({scanned:r.scanned, overScanned:r.overScanned, fixed:r.fixed})); return r; }

// ตั้ง trigger drain ทุก 1 นาที (รันครั้งเดียวใน editor)
function setupFirebaseTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === "drainFirebaseInbox" || fn === "refreshRecentStats" ||
        fn === "refreshPendingCache" || fn === "frequentVideoReconcile") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("drainFirebaseInbox").timeBased().everyMinutes(1).create();
  // 📊 อัปเดต stats รายงานเข้า Firebase ทุก 5 นาที (เบื้องหลัง — ไม่แตะ saveData)
  ScriptApp.newTrigger("refreshRecentStats").timeBased().everyMinutes(5).create();
  // 📋 อัปเดต pending orders + products ทุก 5 นาที (ข้ามถ้าข้อมูลไม่เปลี่ยน — กัน quota)
  ScriptApp.newTrigger("refreshPendingCache").timeBased().everyMinutes(5).create();
  // 🎬 เติม videoUrl จาก Drive ให้ row no_video ทุก 15 นาที (เก็บกวาด lock_timeout)
  ScriptApp.newTrigger("frequentVideoReconcile").timeBased().everyMinutes(15).create();
  Logger.log("✅ Firebase triggers: drain(1m) + stats(5m) + pending(5m) + videoReconcile(15m)");
}

// 🎬 reconcile ถี่ — เติม videoUrl ให้ row no_video ของ 2 วันล่าสุด (เร็ว, ไม่ lock)
//   แก้อาการ: วิดีโออัป Drive แล้ว แต่ saveData ติด lock_timeout เลยไม่ได้เขียน URL
function frequentVideoReconcile() {
  try {
    const r = reconcileVideoUrls({ sinceDays: 2 });
    if (r && r.fixed > 0) Logger.log("[frequentVideoReconcile] เติม " + r.fixed + " แถว");
  } catch(e) {
    Logger.log("[frequentVideoReconcile] error: " + e.message);
  }
}

// ============================================================
// 📋 PENDING CACHE → Firebase — มือถืออ่าน /pending แทนเรียก getAllPendingOrders (ช้า)
//   GAS คำนวณ logic เดิม (ไม่แตะ) แล้วเก็บผลลัพธ์ + product map ลง Firebase
//   มือถืออ่านตรง ~100ms ไม่ต้องรอ scan MarketplaceData + cold start
//   ✅ ข้ามถ้า Orders/MarketplaceData ไม่เปลี่ยนตั้งแต่รอบก่อน — กัน GAS quota หมด
// ============================================================
// hash สั้นๆ สำหรับเช็คว่าเนื้อหาเปลี่ยนไหม
function _strHash(s) {
  let h = 0; s = String(s);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function refreshPendingCache(force) {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return;
  try {
    drainMpInbox(); // backup: ดูดไฟล์ marketplace ที่ค้างใน /mpInbox เข้าชีตก่อน mirror /pending
    _removePage365DupRows(true); // 🧹 กันซ้ำ: ลบแถว page365 ที่ tracking ซ้ำกับ native (ก่อนคำนวณ /pending)
    _prunePendingLive(cfg); // 🧹 ลบ overlay ที่เก่า (ตอนนี้ /pending ตัวจริงครอบคลุมแล้ว)
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ordSheet = ss.getSheetByName(SHEET_ORDERS);
    const mpSheet  = ss.getSheetByName(SHEET_MARKETPLACE);
    const pSheet   = ss.getSheetByName(SHEET_PRODUCTS);
    const props = PropertiesService.getScriptProperties();
    let bumped = false;

    // 🔄 products — mirror "ทุกครั้งที่เนื้อหาเปลี่ยน" (จับการแก้ชื่อในแถวเดิม ไม่ใช่แค่เพิ่ม/ลบแถว)
    //    Product sheet เล็ก → อ่านทุกรอบถูก; PUT เฉพาะตอน hash เปลี่ยน → ไม่เปลือง bandwidth
    //    client อ่าน /products ล้วน (ไม่ fallback GAS) → ชีตยังแก้ได้ + mirror ดึงจากชีตตลอด
    const products = getProductData();
    const productsHaveData = products && Object.keys(products).length > 0;
    const pHash = _strHash(JSON.stringify(products));
    // ⚠️ เช็คว่า /products ใน Firebase "ว่างจริง" ไหม — กันเคส property บอก mirror แล้ว แต่ข้อมูลหาย
    //    (เคยเจอ: Firebase ถูกล้าง/รีเซ็ต แต่ productsHash ค้าง → ไม่ re-mirror → ทุกเครื่องขึ้น SKU)
    let fbProductsEmpty = false;
    try {
      const pr = UrlFetchApp.fetch(cfg.url + "/products.json?shallow=true&auth=" + encodeURIComponent(cfg.secret), { muteHttpExceptions: true });
      const b = (pr.getResponseCode() === 200) ? pr.getContentText() : "x";
      fbProductsEmpty = (b === "null" || b === "" || b === "{}");
    } catch(e) {}
    // PUT เมื่อ: บังคับ / เนื้อหาเปลี่ยน / Firebase ว่าง — แต่ "ห้าม PUT ทับด้วยของว่าง" (กันลบชื่อทิ้ง)
    if (productsHaveData && (force || fbProductsEmpty || props.getProperty('productsHash') !== pHash)) {
      _fbPut(cfg, "/products.json", products);
      props.setProperty('productsHash', pHash);
      bumped = true;
      Logger.log("[refreshPendingCache] products mirrored: " + Object.keys(products).length + (fbProductsEmpty ? " (เติมเพราะ /products ว่าง)" : ""));
    }

    // 📦 pending (แพง — scan Orders) — ข้ามถ้า sheet sig เดิม
    const sig = (ordSheet ? ordSheet.getLastRow() : 0) + ":" +
                (mpSheet ? mpSheet.getLastRow() : 0) + ":" +
                (pSheet ? pSheet.getLastRow() : 0);
    if (force || props.getProperty('pendingCacheSig') !== sig) {
      const pending = getAllPendingOrders();
      _fbPut(cfg, "/pending.json", pending);
      props.setProperty('pendingCacheSig', sig);
      bumped = true;
      Logger.log("[refreshPendingCache] pending mirrored: " + Object.keys(pending).length + " sig=" + sig);
    }

    // เตะ real-time sync เฉพาะตอนมีอะไรเปลี่ยนจริง → client refresh /products+/pending
    if (bumped) _fbPut(cfg, "/cacheMeta.json", { ts: Date.now() });
  } catch(e) {
    Logger.log("[refreshPendingCache] error: " + e.message);
  }
}

// 🧹 prune /pendingLive — ลบ overlay ที่ PC เขียนไว้แต่เก่ากว่า 30 นาที (ป่านนี้ /pending ตัวจริง mirror แล้ว)
//   node เล็ก (เฉพาะที่เพิ่งอัป) → อ่านทั้งก้อนถูก
function _prunePendingLive(cfg) {
  try {
    const resp = UrlFetchApp.fetch(cfg.url + "/pendingLive.json?auth=" + encodeURIComponent(cfg.secret), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return;
    const body = resp.getContentText();
    if (!body || body === "null") return;
    let docs; try { docs = JSON.parse(body); } catch(e) { return; }
    const cutoff = Date.now() - 30 * 60 * 1000;
    const del = {};
    Object.keys(docs || {}).forEach(tk => {
      const ts = Number(docs[tk] && docs[tk].ts) || 0;
      if (ts < cutoff) del[tk] = null;
    });
    if (Object.keys(del).length > 0) {
      UrlFetchApp.fetch(cfg.url + "/pendingLive.json?auth=" + encodeURIComponent(cfg.secret), {
        method: "patch", contentType: "application/json", payload: JSON.stringify(del), muteHttpExceptions: true
      });
      Logger.log("[prunePendingLive] ลบ overlay เก่า " + Object.keys(del).length + " รายการ");
    }
  } catch(e) { Logger.log("[prunePendingLive] error: " + e.message); }
}

// 🏷️ บังคับ mirror /products ขึ้น Firebase เดี๋ยวนี้ — แก้เคส /products ว่าง → ทุกเครื่องขึ้น SKU
//    (ไม่ PUT ทับด้วยของว่าง) + เตะ /cacheMeta ให้ทุกเครื่องดึงชื่อใหม่ทันที
function forceMirrorProducts() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) { Logger.log("[forceMirrorProducts] ไม่มี firebase cfg"); return 0; }
  const products = getProductData();
  const n = products ? Object.keys(products).length : 0;
  if (n === 0) { Logger.log("[forceMirrorProducts] product sheet ว่าง — ไม่ทำ (กันลบของดี)"); return 0; }
  _fbPut(cfg, "/products.json", products);
  PropertiesService.getScriptProperties().setProperty('productsHash', _strHash(JSON.stringify(products)));
  _fbPut(cfg, "/cacheMeta.json", { ts: Date.now() }); // เตะ real-time sync → ทุกเครื่องดึงชื่อใหม่
  Logger.log("[forceMirrorProducts] ✅ mirror " + n + " สินค้า + เตะ cacheMeta");
  return n;
}

function _fbPut(cfg, path, obj) {
  const url = cfg.url + path + "?auth=" + encodeURIComponent(cfg.secret);
  const resp = UrlFetchApp.fetch(url, {
    method: "put",
    contentType: "application/json",
    payload: JSON.stringify(obj),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) Logger.log("[_fbPut] " + path + " fail: " + resp.getResponseCode());
}

// ============================================================
// 📊 FIREBASE STATS — pre-aggregated counters เพื่อรายงานเร็ว ~100ms
//   client อ่าน /stats/{YYYY-MM-DD} ตรง ไม่ต้องให้ GAS scan ชีต
//   วิธี: cron recompute วันนี้+เมื่อวาน (exact, PUT ทับ — ไม่มี drift)
//   โครงสร้าง: /stats/{date} = { orders, items, mp:{shopee:{orders,items}}, sku:{B173..:n} }
// ============================================================

// sanitize key ให้ใช้กับ RTDB ได้ (ห้ามมี . $ # [ ] /)
function _fbKey(s) {
  return String(s || "").replace(/[.$#\[\]\/\x00-\x1f\x7f]/g, "_").slice(0, 200) || "_";
}

// คำนวณ stats ของวันที่กำหนด (array ของ "yyyy-MM-dd") จาก Orders sheet แบบ exact
//   scan จากล่างขึ้น หยุดเมื่อพ้นช่วง → อ่านเฉพาะแถวล่าสุด ไม่ scan ทั้งชีต
function _computeStatsForDates(dateSet) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_ORDERS);
  const out = {}; // date -> { orders, items, mp:{}, sku:{} }
  dateSet.forEach(d => out[d] = { orders: 0, items: 0, mp: {}, sku: {} });
  if (!sheet) return out;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;

  const tz = Session.getScriptTimeZone();
  // หาวันเก่าสุดที่ต้องการ → ใช้เป็นจุดหยุด scan
  let minDate = null;
  dateSet.forEach(d => { if (!minDate || d < minDate) minDate = d; });

  const lastCol = sheet.getLastColumn();
  const CHUNK = 2000;
  let row = lastRow;
  let stop = false, oooRun = 0; // oooRun = แถวเก่ากว่าช่วงที่เจอ "ติดกัน"
  while (row >= 2 && !stop) {
    const from = Math.max(2, row - CHUNK + 1);
    const n = row - from + 1;
    const data = sheet.getRange(from, 1, n, lastCol).getValues();
    for (let i = data.length - 1; i >= 0; i--) {
      const ts = data[i][0];
      if (!(ts instanceof Date)) continue;
      const dayKey = Utilities.formatDate(ts, tz, "yyyy-MM-dd");
      if (dayKey < minDate) { if (++oooRun >= SCAN_OOO_LIMIT) { stop = true; break; } continue; } // เก่ากว่าช่วง — ข้าม (ทน straggler)
      oooRun = 0;
      if (!out[dayKey]) continue; // ไม่ใช่วันที่สนใจ
      const remark = String(data[i][5] || "");
      if (remark.indexOf("__VIDEO_FIRST__") === 0) continue; // placeholder ยังไม่ใช่ออเดอร์จริง
      const tracking = numToStr(data[i][3]);
      if (!tracking) continue;
      const mp = (String(data[i][2] || "").trim().toLowerCase()) || "other";
      const bucket = out[dayKey];
      bucket.orders++;
      if (!bucket.mp[mp]) bucket.mp[mp] = { orders: 0, items: 0 };
      bucket.mp[mp].orders++;
      // items เริ่ม col 8 (index 7)
      for (let c = 7; c < data[i].length; c++) {
        const v = String(data[i][c]).trim();
        if (!v) continue;
        bucket.items++;
        bucket.mp[mp].items++;
        const sk = _fbKey(v.toUpperCase());
        bucket.sku[sk] = (bucket.sku[sk] || 0) + 1;
      }
    }
    row = from - 1;
  }
  return out;
}

// เขียน stats ของวันที่กำหนดลง Firebase (PUT ทับ — exact, ไม่ drift)
function _putStatsForDates(dates) {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return false;
  const stats = _computeStatsForDates(dates);
  let ok = true;
  dates.forEach(d => {
    const payload = stats[d] || { orders: 0, items: 0, mp: {}, sku: {} };
    try {
      const url = cfg.url + "/stats/" + d + ".json?auth=" + encodeURIComponent(cfg.secret);
      const resp = UrlFetchApp.fetch(url, {
        method: "put",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() !== 200) {
        ok = false;
        Logger.log("[stats] PUT " + d + " fail: " + resp.getResponseCode());
      }
    } catch(e) { ok = false; Logger.log("[stats] PUT " + d + " error: " + e.message); }
  });
  return ok;
}

// cron ทุก 5 นาที — refresh วันนี้ + เมื่อวาน
function refreshRecentStats() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return;
  const tz = Session.getScriptTimeZone();
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  const dates = [Utilities.formatDate(y, tz, "yyyy-MM-dd"), Utilities.formatDate(today, tz, "yyyy-MM-dd")];
  _putStatsForDates(dates);
  _mirrorOrdersForDates(dates); // 🔍 mirror ออเดอร์ลง /orders ให้ search เร็ว
  checkDrainBacklog();          // 🚨 เฝ้า /inbox + /mpInbox ค้าง → เมลเตือนเจ้าของก่อนกองเป็นพัน
}

// ============================================================
// 🚨 checkDrainBacklog — เฝ้า backlog ใน Firebase แล้วเมลเตือนถ้า drain ตามไม่ทัน/พัง
//   ปกติ /inbox ใกล้ 0 (drain ทุก 1 นาทีเคลียร์) — ค้างเยอะต่อเนื่อง = trigger ถูก quota ปิด/พัง
//   เงื่อนไข: ค้างเกิน threshold "ต่อเนื่อง >10 นาที" + cooldown เมล 30 นาที (กัน burst ปกติ/สแปม)
// ============================================================
const DRAIN_BACKLOG_THRESHOLD = 200;            // /inbox ค้างเกินนี้ = ผิดปกติ
const MP_BACKLOG_THRESHOLD = 50;                // /mpInbox ค้างเกินนี้ = drain marketplace มีปัญหา
const BACKLOG_SUSTAIN_MS = 10 * 60 * 1000;      // ต้องค้างต่อเนื่องเกินนี้ถึงเตือน
const BACKLOG_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // เตือนซ้ำได้ทุก 30 นาที

function checkDrainBacklog() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return;
  try {
    const inboxN = _fbCountShallow(cfg, "/inbox");
    const mpN    = _fbCountShallow(cfg, "/mpInbox");
    const props = PropertiesService.getScriptProperties();
    const problems = [];
    if (inboxN > DRAIN_BACKLOG_THRESHOLD) problems.push("/inbox ค้าง " + inboxN + " ออเดอร์ (ปกติใกล้ 0)");
    if (mpN > MP_BACKLOG_THRESHOLD)       problems.push("/mpInbox ค้าง " + mpN + " batch ไฟล์ marketplace");

    if (problems.length === 0) {                 // ปกติ → รีเซ็ตตัวจับเวลา/cooldown ให้เหตุครั้งหน้าเตือนทันที
      props.deleteProperty('backlogHighSince');
      props.deleteProperty('backlogAlertAt');
      return;
    }
    const now = Date.now();
    let since = Number(props.getProperty('backlogHighSince') || 0);
    if (!since) { props.setProperty('backlogHighSince', String(now)); since = now; }
    if (now - since < BACKLOG_SUSTAIN_MS) {       // เพิ่งค้าง — รอดูว่าต่อเนื่องไหม (กัน burst ชั่วคราว)
      Logger.log("[checkDrainBacklog] ค้างแต่ยังไม่ถึง " + (BACKLOG_SUSTAIN_MS/60000) + " นาที: " + problems.join("; "));
      return;
    }
    const lastAlert = Number(props.getProperty('backlogAlertAt') || 0);
    if (now - lastAlert < BACKLOG_ALERT_COOLDOWN_MS) return; // ยัง cooldown
    props.setProperty('backlogAlertAt', String(now));
    _alertOwner("⚠️ Drain ค้าง — ข้อมูลยังไม่เข้าชีต",
      "พบข้อมูลค้างใน Firebase ที่ drain ยังไม่ได้ดูดเข้าชีต (ค้างต่อเนื่องเกิน " + (BACKLOG_SUSTAIN_MS/60000) + " นาที):\n\n" +
      "  • " + problems.join("\n  • ") + "\n\n" +
      "ควรเช็ก:\n" +
      "  1. Apps Script → Triggers: drainFirebaseInbox / refreshPendingCache ยังทำงานไหม (อาจถูก quota ปิด)\n" +
      "  2. Executions: มี error ค้างไหม\n" +
      "  3. กู้: รัน drainInboxUntilEmpty (เคลียร์ /inbox) และ refreshPendingCache (เคลียร์ /mpInbox) ใน editor\n\n" +
      "(เตือนซ้ำได้อีกครั้งหลัง 30 นาทีถ้ายังไม่หาย)");
    Logger.log("[checkDrainBacklog] 📧 ส่งเมลเตือนแล้ว: " + problems.join("; "));
  } catch(e) { Logger.log("[checkDrainBacklog] error: " + e.message); }
}

// นับจำนวน key แบบ shallow (เบามาก — ไม่โหลด value) ใช้กับ secret (อ่านได้แม้ rules ปิด)
function _fbCountShallow(cfg, path) {
  try {
    const resp = UrlFetchApp.fetch(cfg.url + path + ".json?shallow=true&auth=" + encodeURIComponent(cfg.secret), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return 0;
    const body = resp.getContentText();
    if (!body || body === "null") return 0;
    const obj = JSON.parse(body);
    return (obj && typeof obj === 'object') ? Object.keys(obj).length : 0;
  } catch(e) { return 0; }
}

// nightly — rebuild 3 วันล่าสุด exact (กัน drift จาก merge/late edits) + prune /orders เก่า
function nightlyStatsRebuild() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return;
  const tz = Session.getScriptTimeZone();
  const dates = [];
  for (let i = 0; i < 3; i++) {
    dates.push(Utilities.formatDate(new Date(Date.now() - i * 86400000), tz, "yyyy-MM-dd"));
  }
  _putStatsForDates(dates);
  _mirrorOrdersForDates(dates);
  pruneOldFirebaseOrders();
  Logger.log("[nightlyStatsRebuild] rebuilt " + dates.join(", "));
}

// ============================================================
// 🔍 FIREBASE ORDERS MIRROR — ให้ search อ่านตรงจาก Firebase (เร็ว ~100ms)
//   /orders/{trackingKey} = { ts, tk, oid, mp, v, rm, it:[sku..] }
//   key = tracking (sanitize) — ตรงกับ model dedup ของแอป
// ============================================================
function _collectOrdersForDates(dateSet) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_ORDERS);
  const out = {}; // trackingKey -> doc
  if (!sheet) return out;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  const tz = Session.getScriptTimeZone();
  let minDate = null;
  dateSet.forEach(d => { if (!minDate || d < minDate) minDate = d; });

  const lastCol = sheet.getLastColumn();
  const CHUNK = 2000;
  let row = lastRow, stop = false, oooRun = 0; // oooRun = แถวเก่ากว่าช่วงที่เจอ "ติดกัน"
  while (row >= 2 && !stop) {
    const from = Math.max(2, row - CHUNK + 1);
    const data = sheet.getRange(from, 1, row - from + 1, lastCol).getValues();
    for (let i = data.length - 1; i >= 0; i--) {
      const ts = data[i][0];
      if (!(ts instanceof Date)) continue;
      const dayKey = Utilities.formatDate(ts, tz, "yyyy-MM-dd");
      if (dayKey < minDate) { if (++oooRun >= SCAN_OOO_LIMIT) { stop = true; break; } continue; } // เก่ากว่าช่วง — ข้าม (ทน straggler)
      oooRun = 0;
      if (dateSet.indexOf(dayKey) === -1) continue;
      const remark = String(data[i][5] || "");
      if (remark.indexOf("__VIDEO_FIRST__") === 0) continue;
      const tracking = numToStr(data[i][3]);
      if (!tracking) continue;
      const items = [];
      for (let c = 7; c < data[i].length; c++) {
        const v = String(data[i][c]).trim();
        if (v) items.push(v);
      }
      const key = _fbKey(tracking.toUpperCase());
      // ถ้า tracking ซ้ำ (ออเดอร์เดียวกันหลายแถว) → เก็บแถวที่ใหม่กว่า
      const tsMs = ts.getTime();
      if (out[key] && out[key].ts >= tsMs) continue;
      out[key] = {
        ts: tsMs,
        tk: tracking,
        oid: numToStr(data[i][1]),
        mp: String(data[i][2] || "").trim().toLowerCase(),
        v: String(data[i][4] || ""),
        rm: remark,
        it: items
      };
    }
    row = from - 1;
  }
  return out;
}

// PATCH /orders.json ทีเดียวหลายรายการ (efficient — 1 HTTP call)
function _mirrorOrdersForDates(dates) {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return;
  const docs = _collectOrdersForDates(dates);
  const keys = Object.keys(docs);
  if (keys.length === 0) return;
  try {
    const url = cfg.url + "/orders.json?auth=" + encodeURIComponent(cfg.secret);
    const resp = UrlFetchApp.fetch(url, {
      method: "patch",
      contentType: "application/json",
      payload: JSON.stringify(docs),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) Logger.log("[mirrorOrders] PATCH fail: " + resp.getResponseCode());
    else Logger.log("[mirrorOrders] mirrored " + keys.length + " orders");
  } catch(e) { Logger.log("[mirrorOrders] error: " + e.message); }
}

// backfill ออเดอร์ทั้งหมด → /orders (รันครั้งเดียวใน editor)
function backfillAllOrders() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) throw new Error("ยังไม่ได้ setupFirebase()");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_ORDERS);
  if (!sheet || sheet.getLastRow() < 2) { Logger.log("[backfillOrders] ไม่มีข้อมูล"); return; }
  const tz = Session.getScriptTimeZone();
  const tsCol = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  const dateSet = {};
  tsCol.forEach(r => { if (r[0] instanceof Date) dateSet[Utilities.formatDate(r[0], tz, "yyyy-MM-dd")] = true; });
  const dates = Object.keys(dateSet).sort();
  for (let i = 0; i < dates.length; i += 10) {
    _mirrorOrdersForDates(dates.slice(i, i + 10));
  }
  Logger.log("[backfillOrders] เสร็จ " + dates.length + " วัน");
}

// ลบ /orders เก่ากว่า retention (กัน Firebase บวม) — รัน nightly
function pruneOldFirebaseOrders() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return;
  try {
    // ดึงเฉพาะ key+ts ทั้งหมด (shallow ไม่ได้กับค่า nested → ดึง orderBy ts)
    const cutoff = Date.now() - CLEANUP_ORDERS_RETENTION_DAYS * 86400000;
    const url = cfg.url + '/orders.json?auth=' + encodeURIComponent(cfg.secret) +
                '&orderBy=' + encodeURIComponent('"ts"') + '&endAt=' + cutoff;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return;
    const body = resp.getContentText();
    if (!body || body === "null") return;
    const old = JSON.parse(body);
    const keys = Object.keys(old || {});
    if (keys.length === 0) return;
    // ลบทีละก้อนผ่าน multi-path PATCH = null
    const del = {};
    keys.forEach(k => del[k] = null);
    UrlFetchApp.fetch(cfg.url + '/orders.json?auth=' + encodeURIComponent(cfg.secret), {
      method: "patch", contentType: "application/json",
      payload: JSON.stringify(del), muteHttpExceptions: true
    });
    Logger.log("[pruneOldFirebaseOrders] ลบ " + keys.length + " orders เก่า");
  } catch(e) { Logger.log("[pruneOldFirebaseOrders] error: " + e.message); }
}

// backfill — รันครั้งเดียวใน editor เพื่อสร้าง stats ย้อนหลังทั้งหมด
function backfillAllStats() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) throw new Error("ยังไม่ได้ setupFirebase()");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_ORDERS);
  if (!sheet || sheet.getLastRow() < 2) { Logger.log("[backfill] ไม่มีข้อมูล"); return; }
  const tz = Session.getScriptTimeZone();
  // เก็บทุกวันที่ที่มีในชีต
  const tsCol = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  const dateSet = {};
  tsCol.forEach(r => {
    if (r[0] instanceof Date) dateSet[Utilities.formatDate(r[0], tz, "yyyy-MM-dd")] = true;
  });
  const dates = Object.keys(dateSet).sort();
  Logger.log("[backfill] " + dates.length + " วัน");
  // ทำทีละ batch 20 วัน กัน timeout
  for (let i = 0; i < dates.length; i += 20) {
    _putStatsForDates(dates.slice(i, i + 20));
  }
  Logger.log("[backfill] เสร็จ " + dates.length + " วัน");
}

// ✅ หา row ของ parcelId — cache ก่อน, fallback scan
//    fullScan=true → scan ทั้งชีต; fullScan=false/undefined → scan แค่ 2000 แถวล่าสุด (saveData hot path)
//    return: { rowIndex, isPlaceholder } หรือ null
function _findParcelRow(sheet, parcelId, fullScan) {
  // Fast path: cache
  const cached = _getCachedParcelRow(parcelId);
  if (cached) {
    // verify ว่า cache ยังตรงกับชีตจริง (กัน race condition)
    try {
      const actual = numToStr(sheet.getRange(cached.rowIndex, 4).getValue()).toUpperCase();
      if (actual === parcelId.toUpperCase()) {
        // เช็ค placeholder marker จาก remark column (col F) ให้แม่นยำ
        const remark = String(sheet.getRange(cached.rowIndex, 6).getValue() || "");
        const isPlaceholder = remark.indexOf("__VIDEO_FIRST__") === 0;
        return { rowIndex: cached.rowIndex, isPlaceholder };
      }
      // cache เพี้ยน → ลบและ scan ต่อ
      _clearCachedParcelRow(parcelId);
    } catch(e) {}
  }

  // Fallback: scan ตามขอบเขตที่กำหนด
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;
  const startScan = fullScan ? 2 : Math.max(2, lastRow - FALLBACK_SCAN_RECENT_ROWS + 1);
  const numScan = lastRow - startScan + 1;
  const data = sheet.getRange(startScan, 4, numScan, 3).getValues(); // col D (tracking), E (video), F (remark)
  const target = parcelId.toUpperCase();
  for (let i = data.length - 1; i >= 0; i--) {
    if (numToStr(data[i][0]).toUpperCase() === target) {
      const rowIndex = startScan + i;
      const isPlaceholder = String(data[i][2] || "").indexOf("__VIDEO_FIRST__") === 0;
      _setCachedParcelRow(parcelId, rowIndex, isPlaceholder); // populate cache สำหรับ call ถัดไป
      return { rowIndex, isPlaceholder };
    }
  }
  return null;
}

// Rate limit ต่อนาที (รวมทุกผู้ใช้)
const RATE_LIMITS = {
  saveData: 120,
  saveMarketplaceData: 60,
  getAllPendingOrders: 60,
  getProductData: 60,
  searchData: 120,
  getReportData: 30,
  getExpectedOrderDetails: 240,
  getSpreadsheetUrl: 30,
  getMarketplaceVersionUrl: 30,
  uploadVideoOnly: 120,
  reconcileVideoUrls: 6,
  drainInbox: 60,            // on-demand drain — debounce ฝั่ง client คุมอีกชั้น
  refreshPending: 12,        // on-demand pending refresh หลังอัปไฟล์ marketplace
  drainMpInbox: 30,          // on-demand drain ไฟล์ marketplace จาก /mpInbox
  // 🔧 เครื่องมือแอดมิน (เรียกจากหน้าเว็บ) — admin ใช้เป็นครั้งคราว
  forceMirrorProducts: 20,
  removePage365Dup: 20,
  auditOverScan: 12,
  mergeDuplicates: 6,
  findLost: 6,
  _default: 120
};

const ALLOWED_ACTIONS = new Set([
  "getProductData", "saveData", "searchData", "saveMarketplaceData",
  "getExpectedOrderDetails", "getReportData", "getAllPendingOrders",
  "getSpreadsheetUrl", "getMarketplaceVersionUrl",
  "uploadVideoOnly", "reconcileVideoUrls", "drainInbox", "refreshPending", "drainMpInbox",
  // 🔧 เครื่องมือแอดมิน
  "forceMirrorProducts", "removePage365Dup", "auditOverScan", "mergeDuplicates", "findLost"
]);

// ============================================================
// ✅ setupApiKey — รันครั้งเดียวใน editor เพื่อ set key
// เปิด Apps Script editor → เลือกฟังก์ชัน setupApiKey → Run
// แล้วใส่ค่าใหม่ลงในตัวแปร NEW_KEY ก่อนรัน
// ============================================================
function setupApiKey() {
  const NEW_KEY = "PASTE-NEW-API-KEY-HERE";
  if (NEW_KEY === "PASTE-NEW-API-KEY-HERE") {
    throw new Error("กรุณาเปลี่ยน NEW_KEY ในโค้ดก่อนรัน");
  }
  PropertiesService.getScriptProperties().setProperty('API_KEY', NEW_KEY);
  Logger.log("✅ API key ถูกตั้งแล้ว (ความยาว " + NEW_KEY.length + ")");
}

// ============================================================
// _checkApiKey — verify request มี apiKey ตรงกับที่เก็บไว้
// ============================================================
function _checkApiKey(body) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected) return false; // ยังไม่ได้ set → ปฏิเสธทุก request
  const got = String(body.apiKey || "");
  if (got.length !== expected.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================
// _checkRateLimit — global per-action throttle
// ============================================================
function _checkRateLimit(action) {
  try {
    const cache = CacheService.getScriptCache();
    const bucket = Math.floor(Date.now() / 60000); // per-minute
    const key = 'rl_' + action + '_' + bucket;
    const limit = RATE_LIMITS[action] || RATE_LIMITS._default;
    const current = parseInt(cache.get(key) || '0', 10);
    if (current >= limit) {
      Logger.log("[rate-limit] action=" + action + " current=" + current + " limit=" + limit);
      return false;
    }
    cache.put(key, String(current + 1), 70);
    return true;
  } catch (e) {
    // ถ้า cache พัง → ปล่อยผ่าน (fail-open) ดีกว่าทำเว็บใช้ไม่ได้
    Logger.log("[rate-limit] cache error: " + e.message);
    return true;
  }
}

// ============================================================
// numToStr — แปลงค่าจาก Sheet เป็น string ที่ถูกต้อง
// ============================================================
function numToStr(val) {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "number") {
    return val.toLocaleString("fullwide", { useGrouping: false, maximumFractionDigits: 0 });
  }
  return String(val).trim();
}

// ============================================================
// doPost — entry point
// ============================================================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      _logRequestRejected("", "", "empty_body", "");
      return _json({ error: "Empty body" });
    }
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      _logRequestRejected("", "", "bad_json", parseErr.message);
      return _json({ error: "Bad JSON" });
    }

    if (!body || typeof body !== 'object') {
      _logRequestRejected("", "", "bad_body", "");
      return _json({ error: "Bad body" });
    }

    const action = String(body.action || "");
    const parcelId = String(body.parcelId || "");

    if (!_checkApiKey(body)) {
      Utilities.sleep(500); // slow down brute force a bit
      _logRequestRejected(parcelId, action, "unauthorized", "");
      return _json({ error: "Unauthorized" });
    }

    if (!ALLOWED_ACTIONS.has(action)) {
      _logRequestRejected(parcelId, action, "unknown_action", "");
      return _json({ error: "Unknown action" });
    }

    if (!_checkRateLimit(action)) {
      _logRequestRejected(parcelId, action, "rate_limit", "");
      return _json({ error: "Rate limit exceeded" });
    }

    let result;
    if      (action === "getProductData")             result = getProductData();
    else if (action === "saveData")                   result = saveData(body);
    else if (action === "searchData")                 result = searchData(body.query);
    else if (action === "saveMarketplaceData")        result = saveMarketplaceData(body);
    else if (action === "getExpectedOrderDetails")    result = getExpectedOrderDetails(body.trackingNo);
    else if (action === "getReportData")              result = getReportData(body.start, body.end);
    else if (action === "getAllPendingOrders")        result = getAllPendingOrders();
    else if (action === "getSpreadsheetUrl")          result = getSpreadsheetUrl();
    else if (action === "getMarketplaceVersionUrl")   result = getMarketplaceVersionUrl();
    else if (action === "uploadVideoOnly")            result = uploadVideoOnly(body);
    else if (action === "reconcileVideoUrls")         result = reconcileVideoUrls(body);
    else if (action === "drainInbox")                 result = drainFirebaseInbox(true);
    else if (action === "refreshPending")             { refreshPendingCache(true); result = { success: true }; }
    else if (action === "drainMpInbox")               { const n = drainMpInbox(); if (n > 0) refreshPendingCache(true); result = { success: true, written: n }; }
    // 🔧 เครื่องมือแอดมิน (เรียกจากหน้าเว็บ)
    else if (action === "forceMirrorProducts")        { result = { success: true, mirrored: forceMirrorProducts() }; }
    else if (action === "removePage365Dup")           { result = removePage365Duplicates({ apply: body.apply === true }); }
    else if (action === "auditOverScan")              { result = auditOverScannedOrders({ apply: body.apply === true, sinceDays: Number(body.sinceDays) || 1 }); }
    else if (action === "mergeDuplicates")            { mergeDuplicateOrders(); result = { success: true }; }
    else if (action === "findLost")                   { result = findLostOrders(); }

    return _json(result);

  } catch (err) {
    Logger.log("[doPost] error: " + err.toString());
    try { _logRequestRejected("", "", "doPost_error", err.toString()); } catch(_) {}
    return _json({ error: "Server error" }); // ไม่คืน stack ให้ client เห็น
  }
}

// ✅ บันทึก request ที่ถูกปฏิเสธก่อนถึงฟังก์ชัน — เห็นภาพรวมของ traffic ที่หายไป
//    จำกัด log เฉพาะ action ที่เกี่ยวกับ saveData (กัน SaveLog บวมจาก getProductData ฯลฯ)
function _logRequestRejected(parcelId, action, reason, detail) {
  try {
    // log เฉพาะ action ที่ใช้บันทึกข้อมูล — ไม่ log getProductData, searchData ฯลฯ
    const WRITE_ACTIONS = new Set(["saveData", "saveMarketplaceData", ""]);
    if (action && !WRITE_ACTIONS.has(action)) return;
    _logSaveAttempt(parcelId, "", reason, 0, action + " | " + (detail || ""));
  } catch(e) {
    Logger.log("[_logRequestRejected] error: " + e.message);
  }
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return _json({ status: "Scanner PRO 3.1 API is running" });
}

// ============================================================
// _bumpMarketplaceVersion
// ============================================================
function _bumpMarketplaceVersion() {
  try {
    const folder = DriveApp.getFolderById(TARGET_FOLDER_ID);
    const version = Date.now().toString();
    const files = folder.getFilesByName('marketplace_version.txt');
    if (files.hasNext()) {
      files.next().setContent(version);
    } else {
      const f = folder.createFile('marketplace_version.txt', version, MimeType.PLAIN_TEXT);
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
    Logger.log('[_bumpMarketplaceVersion] version = ' + version);
  } catch(e) {
    Logger.log('[_bumpMarketplaceVersion] error: ' + e.message);
  }
}

function getMarketplaceVersionUrl() {
  try {
    const folder = DriveApp.getFolderById(TARGET_FOLDER_ID);
    const files = folder.getFilesByName('marketplace_version.txt');
    let fileId;
    if (files.hasNext()) {
      fileId = files.next().getId();
    } else {
      const f = folder.createFile('marketplace_version.txt', '0', MimeType.PLAIN_TEXT);
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      fileId = f.getId();
    }
    return { url: 'https://drive.google.com/uc?export=download&id=' + fileId };
  } catch(e) {
    Logger.log('[getMarketplaceVersionUrl] error: ' + e.message);
    return { url: '' };
  }
}

// ============================================================
// getProductData
// ============================================================
function getProductData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_PRODUCTS);
    if (!sheet) return {};
    const data = sheet.getDataRange().getValues();
    const productMap = {};
    for (let i = 1; i < data.length; i++) {
      let sku  = String(data[i][0]).trim();
      let name = String(data[i][3]).trim();
      if (sku) productMap[sku] = name;
    }
    return productMap;
  } catch (e) {
    Logger.log("Error in getProductData: " + e.message);
    return {};
  }
}

// ============================================================
// _logSaveAttempt — บันทึกทุก call ของ saveData ลง SaveLog sheet
// ใช้ตรวจสอบย้อนหลังว่ามีอะไรเข้ามาบ้าง สำเร็จ/dup/error
// ============================================================
function _logSaveAttempt(parcelId, marketplace, result, itemsCount, errorMsg) {
  try {
    const sheet = getOrCreateSheet("SaveLog",
      ["Timestamp", "ParcelId", "Marketplace", "Result", "ItemsCount", "Error"]);
    sheet.appendRow([new Date(), parcelId || "", marketplace || "", result || "",
                     Number(itemsCount) || 0, String(errorMsg || "").slice(0, 500)]);
  } catch(e) {
    Logger.log("[_logSaveAttempt] error: " + e.message);
  }
}

// ============================================================
// Idempotency token tracking — เก็บใน CacheService (TTL 6 ชม.)
// CacheService ใช้แทน PropertiesService เพราะ:
//   - PropertiesService มี quota 9KB ต่อ property → token เยอะๆ จะเต็ม
//   - CacheService quota สูงกว่า, มี TTL auto-expire
// ============================================================
const IDEM_TOKEN_TTL_SEC = 6 * 60 * 60; // 6 ชม.

function _isCompletedToken(token) {
  if (!token) return false;
  try {
    return CacheService.getScriptCache().get('idem_' + token) === '1';
  } catch(e) {
    return false;
  }
}

function _markTokenCompleted(token) {
  if (!token) return;
  try {
    CacheService.getScriptCache().put('idem_' + token, '1', IDEM_TOKEN_TTL_SEC);
  } catch(e) {
    Logger.log("[_markTokenCompleted] cache error: " + e.message);
  }
}

// ============================================================
// reconcileSaveLogVsOrders — daily check
// เปรียบเทียบ "success ใน SaveLog วันนี้" vs "Orders rows วันนี้"
// ถ้าต่างกัน → email แจ้งเจ้าของ
// รันตอน 23:00 ทุกวัน (ตั้งใน setupDailyCleanupTrigger)
// ============================================================
function reconcileSaveLogVsOrders() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = Session.getScriptTimeZone();
    const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

    // นับ success ใน SaveLog ของวันนี้
    const logSheet = ss.getSheetByName("SaveLog");
    let logSuccessCount = 0;
    const logTrackings = new Set();
    if (logSheet && logSheet.getLastRow() > 1) {
      const data = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 4).getValues();
      for (let i = 0; i < data.length; i++) {
        const ts = data[i][0];
        if (!(ts instanceof Date)) continue;
        const day = Utilities.formatDate(ts, tz, "yyyy-MM-dd");
        if (day !== today) continue;
        const result = String(data[i][3] || "").toLowerCase();
        if (result === "success") {
          logSuccessCount++;
          logTrackings.add(String(data[i][1] || "").toUpperCase());
        }
      }
    }

    // นับแถวใน Orders ของวันนี้
    const ordSheet = ss.getSheetByName(SHEET_ORDERS);
    let ordCount = 0;
    const ordTrackings = new Set();
    if (ordSheet && ordSheet.getLastRow() > 1) {
      const lastRow = ordSheet.getLastRow();
      const data = ordSheet.getRange(2, 1, lastRow - 1, 4).getValues(); // ts + 3 cols → tracking is col 4
      for (let i = 0; i < data.length; i++) {
        const ts = data[i][0];
        if (!(ts instanceof Date)) continue;
        const day = Utilities.formatDate(ts, tz, "yyyy-MM-dd");
        if (day !== today) continue;
        ordCount++;
        ordTrackings.add(String(data[i][3] || "").toUpperCase());
      }
    }

    const diff = logSuccessCount - ordCount;
    Logger.log("[reconcile] วันนี้ SaveLog success=" + logSuccessCount + " Orders=" + ordCount + " diff=" + diff);

    if (diff === 0) return; // ตรงกัน ไม่ต้องแจ้ง

    // หา tracking ที่อยู่ใน log แต่ไม่อยู่ในชีต (น่าจะเป็นรายการที่ verify ผิดพลาด)
    const missingInOrders = [];
    logTrackings.forEach(t => { if (!ordTrackings.has(t)) missingInOrders.push(t); });

    const lines = [
      "วันที่: " + today,
      "SaveLog success: " + logSuccessCount + " รายการ",
      "Orders sheet:    " + ordCount + " รายการ",
      "ส่วนต่าง:        " + diff + " รายการ",
      ""
    ];
    if (missingInOrders.length > 0) {
      lines.push("รายการที่ log ว่าสำเร็จแต่ไม่อยู่ในชีต (" + missingInOrders.length + ' รายการ):');
      missingInOrders.slice(0, 50).forEach(t => lines.push("  - " + t));
      if (missingInOrders.length > 50) lines.push("  ...อีก " + (missingInOrders.length - 50) + " รายการ");
    }
    _alertOwner("Daily reconciliation: ส่วนต่าง " + diff + " รายการ", lines.join("\n"));
  } catch(e) {
    Logger.log("[reconcileSaveLogVsOrders] error: " + e.message);
    _alertOwner("Reconciliation error", e.toString());
  }
}

// ============================================================
// saveData — video upload (นอก lock) + short-lock write + cache dedup + audit
//   ✅ video อัป Drive "นอก lock" (ส่วนช้า) → lock ไม่ค้างตอนแพคเร็ว
//   ✅ การเขียนชีต (dedup + appendRow) อยู่ "ใต้ lock สั้น ~100ms-1s"
//      → กัน concurrent appendRow เขียนทับ row เดียวกัน (เคยทำให้ 4 ออเดอร์หาย)
//   ✅ idempotency token + cache → กัน duplicate, retry idempotent
//   ✅ videoPending → client retry วิดีโอถ้า Drive ล้ม
// ============================================================
function saveData(body) {
  // --- validate input ---
  const parcelId    = String(body.parcelId || "").trim();
  const orderId     = String(body.orderId || "").slice(0, 128);
  const marketplace = String(body.marketplace || "").slice(0, 32);
  const remark      = String(body.remark || "").slice(0, 500);
  const itemsArr    = Array.isArray(body.items) ? body.items : [];
  // ⏱️ ใช้ "เวลาแพค" ที่ client ส่งมา (body.ts) ถ้ามี — ไม่งั้นใช้เวลาปัจจุบัน
  const rowTs       = (Number(body.ts) > 0) ? new Date(Number(body.ts)) : new Date();

  if (!parcelId) {
    _logSaveAttempt(parcelId, marketplace, "invalid", itemsArr.length, "parcelId ว่าง");
    return { success: false, error: "parcelId ว่าง" };
  }
  if (parcelId.length > 64) {
    _logSaveAttempt(parcelId, marketplace, "invalid", itemsArr.length, "parcelId ยาวเกินไป");
    return { success: false, error: "parcelId ยาวเกินไป" };
  }
  if (itemsArr.length > 500) {
    _logSaveAttempt(parcelId, marketplace, "invalid", itemsArr.length, "items มากเกินไป");
    return { success: false, error: "items มากเกินไป" };
  }

  const videoBase64 = String(body.videoEvidence || "");
  if (videoBase64.length > MAX_VIDEO_BASE64_LEN) {
    Logger.log("[saveData] video too large: " + videoBase64.length + " bytes");
    _logSaveAttempt(parcelId, marketplace, "invalid", itemsArr.length, "video too large");
    return { success: false, error: "Video too large" };
  }

  // --- รับ MIME ที่อนุญาตจาก client (mp4 / webm) ---
  const ALLOWED_VIDEO_MIMES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
  let videoMime = String(body.videoMimeType || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_VIDEO_MIMES[videoMime]) videoMime = 'video/webm';
  const videoExt = ALLOWED_VIDEO_MIMES[videoMime];

  const idemToken = String(body.idemToken || "").slice(0, 64);
  const hasVideo = !!(videoBase64 && videoBase64 !== "no_video" && videoBase64 !== "video_too_large");

  // ⚡ Fast path: token เคย complete → retry เงียบๆ
  //   ❗ ยกเว้นถ้า request นี้ "มี video" — เพราะ flush ตอนปิดแอปส่ง order-only (no_video)
  //      ก่อน แล้ว complete token ไปแล้ว → ปล่อยให้ตัวที่มี video ผ่าน เพื่อไป attach
  //      วิดีโอใส่ row เดิม (ผ่าน duplicate path)
  if (idemToken && _isCompletedToken(idemToken) && !hasVideo) {
    Logger.log("[saveData] Idempotent retry: " + idemToken);
    _logSaveAttempt(parcelId, marketplace, "idempotent_retry", itemsArr.length, "token " + idemToken);
    return { success: true, note: "idempotent_retry" };
  }

  // 🎬 Upload video → Drive ก่อน (ส่วนช้า — ทำ "นอก lock" เพื่อไม่ให้ lock ค้างตอนแพคเร็ว)
  //   uploadedVideoUrl: "" = ไม่มีวิดีโอ, drive url, หรือ "video_too_large"
  let uploadedVideoUrl = "";
  let videoUploadFailed = false;
  if (hasVideo) {
    const u = _uploadVideoToDrive(videoBase64, videoMime, videoExt, parcelId);
    if (u === "upload_failed") videoUploadFailed = true;
    else uploadedVideoUrl = u;
  } else if (videoBase64 === "video_too_large") {
    uploadedVideoUrl = "video_too_large";
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS) || ss.insertSheet(SHEET_ORDERS);

    // 🔎 dedup find "นอก lock" (scan อาจช้า — ไม่ควรถือ lock ระหว่างนี้)
    const found = _findParcelRow(sheet, parcelId);
    if (found) {
      const matchRow = found.rowIndex;
      // ✅ placeholder → upgrade (เขียน row เดิม — ไม่ใช่ append → ไม่ต้อง lock)
      if (found.isPlaceholder) {
        const existingVideoUrl = String(sheet.getRange(matchRow, 5).getValue() || "no_video").trim();
        const finalVideoUrl = (uploadedVideoUrl && uploadedVideoUrl !== "video_too_large") ? uploadedVideoUrl : existingVideoUrl;
        const upgradedRow = [rowTs, orderId, marketplace, parcelId, finalVideoUrl, remark, itemsArr.length, ...itemsArr.slice(0, 500).map(String)];
        sheet.getRange(matchRow, 1, 1, upgradedRow.length).setValues([upgradedRow]);
        _setCachedParcelRow(parcelId, matchRow, false);
        if (idemToken) _markTokenCompleted(idemToken);
        _logSaveAttempt(parcelId, marketplace, "placeholder_upgraded", itemsArr.length, "row " + matchRow);
        return { success: true, note: "placeholder_upgraded", row: matchRow };
      }
      // duplicate ปกติ — เติม video ถ้า row ยังไม่มี (เขียน cell เดิม — ไม่ต้อง lock)
      if (uploadedVideoUrl && uploadedVideoUrl !== "video_too_large") {
        try {
          const cur0 = String(sheet.getRange(matchRow, 5).getValue()).trim();
          if (cur0.indexOf('drive.google.com') === -1) sheet.getRange(matchRow, 5).setValue(uploadedVideoUrl);
        } catch(e) {}
      }
      if (idemToken) _markTokenCompleted(idemToken);
      _logSaveAttempt(parcelId, marketplace, "duplicate_skipped", itemsArr.length, "row " + matchRow);
      return { success: true, note: "duplicate_skipped", videoPending: videoUploadFailed };
    }

    // 🆕 new row — ❗LOCK เฉพาะ appendRow (สั้นมาก ~100ms) กัน concurrent overwrite
    //    scan/dedup ทำนอก lock ไปแล้ว → critical section เหลือแค่ append → lock_timeout น้อยลงมาก
    const videoUrl = uploadedVideoUrl || "no_video";
    const lock = LockService.getScriptLock();
    try { lock.waitLock(30000); }
    catch(e) {
      Logger.log("[saveData] ไม่ได้ lock ภายใน 30s: " + e.message);
      _logSaveAttempt(parcelId, marketplace, "lock_timeout", itemsArr.length, e.message);
      return { success: false, error: "Server busy, please retry" };
    }
    let newRow;
    try {
      // re-check token ใน lock — กัน retry ของ save เดิม append ซ้ำ (cache ~10ms)
      if (idemToken && _isCompletedToken(idemToken) && !hasVideo) {
        _logSaveAttempt(parcelId, marketplace, "idempotent_retry", itemsArr.length, "token " + idemToken);
        return { success: true, note: "idempotent_retry" };
      }
      const row = [rowTs, orderId, marketplace, parcelId, videoUrl, remark, itemsArr.length, ...itemsArr.slice(0, 500).map(String)];
      sheet.appendRow(row);
      newRow = sheet.getLastRow();
      if (idemToken) _markTokenCompleted(idemToken);
      _setCachedParcelRow(parcelId, newRow, false);
    } finally {
      try { lock.releaseLock(); } catch(_) {}
    }

    _logSaveAttempt(parcelId, marketplace, videoUploadFailed ? "success_video_pending" : "success", itemsArr.length, "row " + newRow);
    Logger.log("[saveData] บันทึก: " + parcelId + " | row=" + newRow + (videoUploadFailed ? " (video pending)" : ""));

    // PropertiesService update — non-critical, "นอก lock"
    try {
      const props = PropertiesService.getScriptProperties();
      const packed = JSON.parse(props.getProperty('packedTrackings') || '[]');
      if (!packed.includes(parcelId.toUpperCase())) {
        packed.push(parcelId.toUpperCase());
        const cutoff = Date.now() - (3 * 24 * 60 * 60 * 1000);
        const ts = JSON.parse(props.getProperty('packedTs') || '{}');
        ts[parcelId.toUpperCase()] = Date.now();
        const fresh = packed.filter(id => (ts[id] || 0) > cutoff);
        const freshTs = {};
        fresh.forEach(id => { freshTs[id] = ts[id]; });
        props.setProperty('packedTrackings', JSON.stringify(fresh));
        props.setProperty('packedTs', JSON.stringify(freshTs));
      }
    } catch(propErr) {
      Logger.log("[saveData] PropertiesService error: " + propErr.message);
    }

    return { success: true, row: newRow, videoPending: videoUploadFailed };
  } catch (e) {
    Logger.log("Error in saveData: " + e.message);
    _logSaveAttempt(parcelId, marketplace, "exception", itemsArr.length, e.toString());
    return { success: false, error: e.toString() };
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

// ✅ Helper: upload video → Drive, คืน URL (หรือ "upload_failed")
// ✅ อัปวิดีโอขึ้น Drive — retry 3 ครั้ง (กัน Drive ล้มชั่วคราวตอนแพคเร็ว/หลายคนพร้อมกัน)
//    setSharing แยก try — ถ้า share fail แต่ไฟล์ขึ้นแล้ว ยังคืน URL (ไม่นับว่า fail)
function _uploadVideoToDrive(videoBase64, videoMime, videoExt, parcelId) {
  let decoded, folder;
  try {
    decoded = Utilities.base64Decode(videoBase64);
    folder = DriveApp.getFolderById(TARGET_FOLDER_ID);
  } catch(e) {
    Logger.log("[_uploadVideoToDrive] decode/folder error: " + e.message);
    return "upload_failed";
  }
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const blob = Utilities.newBlob(decoded, videoMime, parcelId + "." + videoExt);
      const file = folder.createFile(blob);
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
      catch(shareErr) { Logger.log("[_uploadVideoToDrive] setSharing fail (ไฟล์ขึ้นแล้ว): " + shareErr.message); }
      return file.getUrl();
    } catch(e) {
      lastErr = e.message;
      Logger.log("[_uploadVideoToDrive] attempt " + (attempt + 1) + " fail: " + e.message);
      if (attempt < 2) Utilities.sleep(800 * (attempt + 1)); // 0.8s, 1.6s
    }
  }
  Logger.log("[_uploadVideoToDrive] หมด retry: " + lastErr);
  return "upload_failed";
}

// ✅ uploadVideoOnly — อัปวิดีโอขึ้น Drive แล้วคืน URL "เฉยๆ" ไม่แตะชีต
//   ใช้ใน flow ใหม่: client อัปวิดีโอก่อน → เอา URL ไปแนบใน Firebase doc → drain เขียน row พร้อม link
//   ไม่มี appendRow / ไม่มี script lock → ไม่ติด lock_timeout เหมือน saveData
function uploadVideoOnly(body) {
  const parcelId = String(body.parcelId || "").trim();
  if (!parcelId || parcelId.length > 64) return { success: false, error: "parcelId ไม่ถูกต้อง" };
  const videoBase64 = String(body.videoEvidence || "");
  if (!videoBase64 || videoBase64 === "no_video") return { success: true, videoUrl: "" };
  if (videoBase64 === "video_too_large") return { success: true, videoUrl: "video_too_large" };
  if (videoBase64.length > MAX_VIDEO_BASE64_LEN) {
    _logSaveAttempt(parcelId, "", "video_invalid", 0, "too large: " + videoBase64.length);
    return { success: true, videoUrl: "video_too_large" };
  }
  const ALLOWED = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
  let mime = String(body.videoMimeType || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED[mime]) mime = 'video/webm';
  const url = _uploadVideoToDrive(videoBase64, mime, ALLOWED[mime], parcelId);
  if (url === "upload_failed") {
    _logSaveAttempt(parcelId, "", "video_drive_fail", 0, "uploadVideoOnly");
    return { success: false, error: "Drive upload failed" };
  }
  _logSaveAttempt(parcelId, "", "video_uploaded", 0, "uploadVideoOnly");
  return { success: true, videoUrl: url };
}

// ============================================================
// reconcileVideoUrls — patch up rows that show "no_video" but have a
// matching file in Drive (filename = parcelId.webm / parcelId.mp4)
// สาเหตุที่ row หาย videoUrl ทั้งที่ Drive มีไฟล์:
//   - cache cold + fallback scan 2000 rows ไม่เจอ row เก่า
//   - uploadVideoForParcel เลย "สร้าง placeholder ใหม่" แทนที่จะ update row เดิม
//   - row เดิมยังคงแสดง no_video, placeholder มี Drive URL แยกอยู่
// reconcile วิ่งดู Drive แล้ว map กลับมา fix ทุก row ที่ยัง no_video
// ============================================================
// ✅ nightly wrapper — เติม videoUrl ให้ row ที่ no_video แต่มีไฟล์ใน Drive (กู้อัตโนมัติ)
//   ตั้ง trigger ใน setupDailyCleanupTrigger (รัน 04:30 หลัง stats rebuild)
function nightlyVideoReconcile() {
  try {
    const res = reconcileVideoUrls({ sinceDays: 3 });
    Logger.log("[nightlyVideoReconcile] fixed " + (res && res.fixed) + " rows");
  } catch(e) {
    Logger.log("[nightlyVideoReconcile] error: " + e.message);
  }
}

// ✅ หาไฟล์วิดีโอใน Drive ด้วยชื่อ (เร็ว — ไม่ scan ทั้งโฟลเดอร์)
//   ลองชื่อ: parcelId.webm / parcelId.mp4 / parcelId_retry.webm / parcelId_retry.mp4
function _findDriveVideoUrl(folder, parcelId) {
  const names = [parcelId + ".webm", parcelId + ".mp4", parcelId + "_retry.webm", parcelId + "_retry.mp4"];
  let best = null, bestTs = -1;
  for (const nm of names) {
    const it = folder.getFilesByName(nm); // indexed lookup — เร็ว
    while (it.hasNext()) {
      const f = it.next();
      const ts = f.getDateCreated().getTime();
      if (ts > bestTs) { bestTs = ts; best = f.getUrl(); }
    }
  }
  return best;
}

function reconcileVideoUrls(body) {
  body = body || {};
  const sinceDays = Math.max(1, Math.min(90, Number(body.sinceDays) || 7));

  try {
    const folder = DriveApp.getFolderById(TARGET_FOLDER_ID);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS);
    if (!sheet) return { success: false, error: "Orders sheet ไม่พบ" };
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { success: true, fixed: 0, scanned: 0, found: 0, driveFiles: 0, sinceDays };

    // 1) อ่าน "เฉพาะแถวท้ายชีต" ที่อยู่ในช่วง sinceDays — ไม่อ่านทั้งชีต
    //    row append ต่อท้ายตามเวลาบันทึก → row ในช่วงวันที่อยู่ "ล่างสุด" เสมอ
    //    อ่านจากล่างขึ้นบนทีละ chunk แล้วหยุดทันทีเมื่อเจอ ts เก่ากว่า cutoff
    const cutoff = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);
    const CHUNK = 2000;
    const candidates = []; // { row, parcelId }
    let scanned = 0, skippedDateRange = 0, skippedHadVideo = 0;

    let cur = lastRow, reachedOlder = false, oooRun = 0; // oooRun = แถวเก่ากว่าช่วงที่เจอ "ติดกัน"
    while (cur >= 2 && !reachedOlder) {
      const from = Math.max(2, cur - CHUNK + 1);
      const chunk = sheet.getRange(from, 1, cur - from + 1, 5).getValues();
      for (let i = chunk.length - 1; i >= 0; i--) {  // ล่าง → บน
        const ts = chunk[i][0];
        if (ts instanceof Date && ts.getTime() < cutoff) { if (++oooRun >= SCAN_OOO_LIMIT) { reachedOlder = true; break; } continue; } // เก่า — ข้าม (ทน straggler)
        if (ts instanceof Date) oooRun = 0;
        const tracking = String(chunk[i][3] || "").trim().toUpperCase();
        if (!tracking) continue;
        scanned++;
        const videoUrl = String(chunk[i][4] || "").trim();
        if (videoUrl.indexOf('drive.google.com') !== -1) { skippedHadVideo++; continue; }
        candidates.push({ row: from + i, parcelId: tracking });
      }
      cur = from - 1;
    }

    // 2) ค้นไฟล์ใน Drive "เฉพาะ tracking ที่ no_video" (getFilesByName — ไม่ scan ทั้งโฟลเดอร์)
    const updates = [];
    let noDriveMatch = 0;
    candidates.forEach(c => {
      const url = _findDriveVideoUrl(folder, c.parcelId);
      if (url) updates.push({ row: c.row, url, parcelId: c.parcelId });
      else noDriveMatch++;
    });
    const driveCount = candidates.length;

    Logger.log("[reconcileVideoUrls] scanned=" + scanned + " no_video=" + candidates.length +
               " toFix=" + updates.length + " noDriveMatch=" + noDriveMatch +
               " skippedHadVideo=" + skippedHadVideo + " skippedDateRange=" + skippedDateRange);

    // ✅ ไม่ใช้ script lock — แค่เติม URL ลง cell ที่ no_video (re-check ก่อนเขียน)
    //    ถ้า saveData เขียน cell เดียวกันพร้อมกัน → ทั้งคู่เป็น Drive URL ที่ valid (ไม่เสียหาย)
    //    (เดิมใช้ waitLock(30000) → ติด lock_timeout ตอนมีคนแพคอยู่ → เอาออก)
    let written = 0;
    for (const u of updates) {
      try {
        // 🛡️ re-validate ว่าแถวยังเป็น tracking เดิม — กัน sortOrdersByDate/ลบแถว ย้าย index ระหว่าง scan→write
        //    (ไม่มี lock → ถ้าไม่เช็ค อาจเขียน videoUrl ลงผิดแถว) ; แถวย้าย → ข้าม รอบหน้าเก็บตก
        const tkNow = numToStr(sheet.getRange(u.row, 4).getValue()).toUpperCase();
        if (tkNow !== String(u.parcelId).toUpperCase()) continue;
        const current = String(sheet.getRange(u.row, 5).getValue()).trim();
        if (current.indexOf('drive.google.com') !== -1) continue; // มี url แล้ว (เพิ่งถูกเติม) → ข้าม
        sheet.getRange(u.row, 5).setValue(u.url);
        written++;
      } catch(e) {
        Logger.log("[reconcileVideoUrls] setValue fail row=" + u.row + ": " + e.message);
      }
    }
    if (written > 0) SpreadsheetApp.flush();
    Logger.log("[reconcileVideoUrls] fixed " + written + " rows");
    _logSaveAttempt("", "", "reconcile_done", written, "scanned=" + scanned + " sinceDays=" + sinceDays);
    return { success: true, fixed: written, scanned, found: updates.length, driveFiles: driveCount, sinceDays };
  } catch(e) {
    Logger.log("[reconcileVideoUrls] error: " + e.message);
    return { success: false, error: e.toString() };
  }
}



// ============================================================
// searchData
// ============================================================
function searchData(query) {
  try {
    const keyword = String(query || "").trim().toUpperCase();
    if (!keyword || keyword.length > 64) return [];

    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_SEARCH) || ss.getSheetByName(SHEET_ORDERS);
    if (!sheet) return [];
    const data    = sheet.getDataRange().getValues();
    const tz      = Session.getScriptTimeZone();
    // ✅ เก็บ raw Date ไว้ sort ก่อน format string (new Date("dd/MM/yyyy") = NaN ใน V8 → sort พัง)
    // ✅ เริ่ม i=1 ข้าม header row (ไม่งั้นพิมพ์ "Tracking" จะตรงกับชื่อ header)
    const results = [];
    for (let i = 1; i < data.length; i++) {
      const strB = numToStr(data[i][1]).toUpperCase();
      const strD = numToStr(data[i][3]).toUpperCase();

      if (strB.includes(keyword) || strD.includes(keyword)) {
        const rawDate = data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0]);
        const tsMs = isNaN(rawDate.getTime()) ? 0 : rawDate.getTime();
        const rowFormatted = data[i].map(c => {
          if (c instanceof Date) return Utilities.formatDate(c, tz, "dd/MM/yyyy HH:mm:ss");
          return numToStr(c);
        });
        results.push({ ts: tsMs, row: rowFormatted });
      }
    }
    return results.sort((a, b) => b.ts - a.ts).map(r => r.row);
  } catch (e) {
    return [];
  }
}

// ============================================================
// setupMarketplaceSheet
// ============================================================
function setupMarketplaceSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_MARKETPLACE);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_MARKETPLACE);
    sheet.appendRow(["Timestamp", "Marketplace", "TrackingNo", "SKU", "Qty", "Remark", "OrderId"]);
    sheet.setFrozenRows(1);
  } else {
    const headerRow = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 7)).getValues()[0];
    if (headerRow.length < 6 || String(headerRow[5]).trim() === "") {
      sheet.getRange(1, 6).setValue("Remark");
    }
    if (headerRow.length < 7 || String(headerRow[6]).trim() === "") {
      sheet.getRange(1, 7).setValue("OrderId");
    }
  }
  // ✅ บังคับให้ column A (Timestamp) แสดงเป็น วันที่+เวลา ไม่ใช่วันที่เฉยๆ
  try {
    sheet.getRange("A2:A").setNumberFormat("dd/MM/yyyy HH:mm:ss");
  } catch (e) {
    Logger.log("[setupMarketplaceSheet] setNumberFormat error: " + e.message);
  }
  return sheet;
}

// ============================================================
// saveMarketplaceData
// ============================================================
function saveMarketplaceData(body) {
  // ✅ LockService — กัน race condition เมื่ออัปโหลดหลายไฟล์พร้อมกัน
  // ไม่มี lock = 2 requests อ่าน lastRow ค่าเดียวกัน → เขียนทับกัน → ข้อมูลหาย
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(45000); // รอ lock สูงสุด 45 วินาที — เผื่อ cleanup/parallel uploads
  } catch(e) {
    Logger.log("[saveMarketplaceData] ไม่ได้ lock ภายใน 45s: " + e.message);
    return { success: false, error: "Server busy, please retry" };
  }

  try {
    const dataArray = Array.isArray(body.data) ? body.data : [];
    if (dataArray.length > 10000) return { success: false, error: "data มากเกินไป" };

    const fileName    = String(body.fileName    || "").slice(0, 200);
    const marketplace = String(body.marketplace || "").slice(0, 32);
    const sheet       = setupMarketplaceSheet();
    const timestamp   = new Date();

    const logSheet = getOrCreateSheet("UploadLog", ["Timestamp","FileName","Marketplace","Count"]);

    // ✅ อ่านเฉพาะคอลัมน์ C-G (tracking, sku, qty, remark, orderId) — เร็วกว่าอ่านทุกคอลัมน์
    // เดิม: getDataRange().getValues() อ่าน 7 คอลัมน์ รวม timestamp ที่ไม่ใช้ → เสียเวลา serialize
    const existingKeys = new Set();
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const slice = sheet.getRange(2, 3, lastRow - 1, 5).getValues(); // C..G
      for (let i = 0; i < slice.length; i++) {
        const t = numToStr(slice[i][0]).toUpperCase(); // col C
        const s = numToStr(slice[i][1]).toUpperCase(); // col D
        const o = numToStr(slice[i][4]);               // col G
        existingKeys.add(t + '|' + s + '|' + o);
      }
    }

    let newRows = [];
    let duplicateSkipped = 0;
    dataArray.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const t   = String(item.tracking || "").trim().toUpperCase();
      const sku = String(item.sku || "").trim().toUpperCase();
      const oid = String(item.orderId || "").trim();
      if (!t || !sku) return;
      const key = t + '|' + sku + '|' + oid;
      if (existingKeys.has(key)) { duplicateSkipped++; return; }
      existingKeys.add(key);
      newRows.push([
        timestamp,
        marketplace,
        "'" + t,
        "'" + sku,
        Number(item.qty) || 1,
        String(item.remark || "").trim().slice(0, 500),
        "'" + oid
      ]);
    });

    let verified = 0;
    if (newRows.length > 0) {
      const startRow = sheet.getLastRow() + 1;
      const needRows = startRow + newRows.length - 1; // setValues ไม่ auto-extend → เพิ่มแถวให้พอ (กัน error เกินขอบชีตตอนไฟล์ใหญ่)
      if (sheet.getMaxRows() < needRows) sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
      sheet.getRange(startRow, 1, newRows.length, 7).setValues(newRows);
      // ✅ force commit ทันที — ไม่ให้ค้างใน batch ที่อาจ rollback
      SpreadsheetApp.flush();
      // ✅ verify: อ่านกลับมานับว่ามีแถวที่เขียนจริงครบไหม (กัน "บอกสำเร็จแต่ข้อมูลหาย")
      const verifyValues = sheet.getRange(startRow, 1, newRows.length, 1).getValues();
      verified = verifyValues.filter(r => r[0] !== '' && r[0] != null).length;
      if (verified !== newRows.length) {
        Logger.log('[saveMarketplaceData] verify FAIL: expected ' + newRows.length + ' got ' + verified + ' file=' + fileName);
        return { success: false, error: 'Write verification failed: ' + verified + '/' + newRows.length + ' rows committed' };
      }
    }

    logSheet.appendRow([timestamp, fileName, marketplace, newRows.length]);

    if (newRows.length > 0) _bumpMarketplaceVersion();

    return { success: true, count: newRows.length, duplicateSkipped, verified };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    try { lock.releaseLock(); } catch(_) {}
    // ⚠️ ไม่เรียก cleanup ใน hot path แล้ว — รัน synchronous จะหน่วง response 5-20s
    // cleanup ย้ายไปเป็น scheduled trigger (03:00 รายวัน) ดูใน setupDailyCleanupTrigger
  }
}

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) { sheet = ss.insertSheet(name); sheet.appendRow(headers); sheet.setFrozenRows(1); }
  return sheet;
}

// ============================================================
// getExpectedOrderDetails
// ============================================================
function getExpectedOrderDetails(trackingNo) {
  try {
    const targetTracking = numToStr(trackingNo).trim().toUpperCase();
    if (!targetTracking || targetTracking.length > 64) return [];

    const sheet          = setupMarketplaceSheet();
    const data           = sheet.getDataRange().getValues();
    let expectedItems    = {};
    let trackingRemark   = "";

    for (let i = 1; i < data.length; i++) {
      let rowTracking = numToStr(data[i][2]).toUpperCase();
      if (rowTracking === targetTracking) {
        let sku    = numToStr(data[i][3]).toUpperCase();
        let qty    = Number(data[i][4]) || 1;
        let remark = String(data[i][5] || "").trim();
        expectedItems[sku] = (expectedItems[sku] || 0) + qty;
        if (!trackingRemark && remark) trackingRemark = remark;
      }
    }

    return Object.entries(expectedItems).map(([sku, qty]) => ({
      sku,
      qty,
      remark: trackingRemark
    }));
  } catch (e) {
    return [];
  }
}

// ============================================================
// getReportData
// ============================================================
function getReportData(startStr, endStr) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS);
    if (!sheet) return { totalOrders: 0, totalItems: 0, allProducts: [], dailyBreakdown: {} };

    const start = new Date(startStr); start.setHours(0,0,0,0);
    const end   = new Date(endStr);   end.setHours(23,59,59,999);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { totalOrders: 0, totalItems: 0, allProducts: [], dailyBreakdown: {} };
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { totalOrders: 0, totalItems: 0, allProducts: [], dailyBreakdown: {} };

    const tsCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    let rowStart = -1, rowEnd = -1;
    for (let i = 0; i < tsCol.length; i++) {
      const d = new Date(tsCol[i][0]);
      if (isNaN(d)) continue;
      if (d >= start && rowStart === -1) rowStart = i;
      if (d <= end) rowEnd = i;
    }
    if (rowStart === -1 || rowEnd < rowStart) {
      return { totalOrders: 0, totalItems: 0, allProducts: [], dailyBreakdown: {} };
    }

    const numRows = rowEnd - rowStart + 1;
    const lastCol = sheet.getLastColumn();
    const data    = sheet.getRange(rowStart + 2, 1, numRows, lastCol).getValues();

    let totalOrders = 0, totalItems = 0;
    const skuCount = {};
    const dailyBreakdown = {};
    const byMarketplace = {}; // { shopee: { orders, items }, ... }
    const tz = Session.getScriptTimeZone();
    const seenTrackings = new Set();

    for (let i = 0; i < data.length; i++) {
      const row     = data[i];
      const rowDate = new Date(row[0]);
      if (isNaN(rowDate) || rowDate < start || rowDate > end) continue;

      const tracking = numToStr(row[3]).toUpperCase();
      if (tracking && seenTrackings.has(tracking)) continue;
      if (tracking) seenTrackings.add(tracking);

      totalOrders++;
      const dayKey = Utilities.formatDate(rowDate, tz, "yyyy-MM-dd");
      if (!dailyBreakdown[dayKey]) dailyBreakdown[dayKey] = { orders: 0, items: 0 };
      dailyBreakdown[dayKey].orders++;

      // marketplace from col C (index 2) — empty/unknown bucketed as "other"
      const mp = String(row[2] || "").trim().toLowerCase() || "other";
      if (!byMarketplace[mp]) byMarketplace[mp] = { orders: 0, items: 0 };
      byMarketplace[mp].orders++;

      let rowItemCount = 0;
      for (let c = 7; c < row.length; c++) {
        const val = String(row[c]).trim();
        if (!val) continue;
        totalItems++;
        rowItemCount++;
        dailyBreakdown[dayKey].items++;
        skuCount[val] = (skuCount[val] || 0) + 1;
      }
      byMarketplace[mp].items += rowItemCount;
    }

    const productSheet = ss.getSheetByName("Product name");
    const productMap   = {};
    if (productSheet) {
      const pData = productSheet.getDataRange().getValues();
      for (let i = 1; i < pData.length; i++) {
        const sku  = String(pData[i][0]).trim();
        const name = String(pData[i][3]).trim();
        if (sku) productMap[sku] = name || sku;
      }
    }

    // ✅ จำกัด allProducts สูงสุด 200 SKUs (กัน response > 6MB ตอนช่วงวันยาว)
    const ALL_PRODUCTS_LIMIT = 200;
    const sortedProducts = Object.entries(skuCount)
      .map(([sku, count]) => ({ sku, name: productMap[sku] || sku, count }))
      .sort((a, b) => b.count - a.count);
    const truncated   = sortedProducts.length > ALL_PRODUCTS_LIMIT;
    const allProducts = truncated ? sortedProducts.slice(0, ALL_PRODUCTS_LIMIT) : sortedProducts;

    return { totalOrders, totalItems, allProducts, dailyBreakdown, byMarketplace, productsTruncated: truncated, totalUniqueProducts: sortedProducts.length };
  } catch(e) {
    return { totalOrders: 0, totalItems: 0, allProducts: [], dailyBreakdown: {}, byMarketplace: {}, error: e.toString() };
  }
}

// ============================================================
// cleanUpOldMarketplaceData
// ============================================================
// ✅ wrapper — รัน cleanup เฉพาะถ้าผ่านไปนานเกิน 1 ชม. (กันรัน clearContents+rewrite ทุก upload)
function _maybeCleanUpOldMarketplaceData() {
  try {
    const props = PropertiesService.getScriptProperties();
    const last = parseInt(props.getProperty('mpCleanupLastRun') || '0', 10);
    const now = Date.now();
    if (now - last < 60 * 60 * 1000) return; // 1 ชม.
    cleanUpOldMarketplaceData();
    props.setProperty('mpCleanupLastRun', String(now));
  } catch(e) {
    Logger.log('[_maybeCleanUpOldMarketplaceData] error: ' + e.message);
  }
}

// ✅ เก็บข้อมูล MarketplaceData ย้อนหลัง 2 วัน
// ใช้ LockService + deleteRows + CSV backup ก่อนลบ
function cleanUpOldMarketplaceData() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch(e) {
    Logger.log("[cleanUpOldMarketplaceData] ไม่ได้ lock ภายใน 30s: " + e.message);
    return;
  }
  try {
    const sheet = setupMarketplaceSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return;

    // อ่านเฉพาะคอลัมน์ A (timestamp)
    const tsValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);

    const rowsToDelete = [];
    for (let i = 0; i < tsValues.length; i++) {
      const ts = tsValues[i][0];
      if (!ts) continue; // ⚠️ ข้ามแถวที่ timestamp ว่าง
      const d = ts instanceof Date ? ts : new Date(ts);
      if (isNaN(d.getTime())) continue;
      if (d < cutoff) rowsToDelete.push(i + 2);
    }
    if (rowsToDelete.length === 0) return;

    // ⚠️ ไม่ backup MarketplaceData — เป็น snapshot ที่ re-upload ได้
    // ถ้า backup จะถือ lock นานเกินไป ทำให้ saveMarketplaceData ขนาน timeout

    rowsToDelete.sort((a, b) => b - a);
    let deleted = 0;
    let i = 0;
    while (i < rowsToDelete.length) {
      const top = rowsToDelete[i];
      let count = 1;
      while (i + 1 < rowsToDelete.length && rowsToDelete[i + 1] === top - count) {
        count++;
        i++;
      }
      const start = top - count + 1;
      try {
        sheet.deleteRows(start, count);
        deleted += count;
      } catch(e) {
        Logger.log("[cleanUpOldMarketplaceData] deleteRows fail ที่แถว " + start + ": " + e.message);
        break;
      }
      i++;
    }
    SpreadsheetApp.flush();
    Logger.log("[cleanUpOldMarketplaceData] ลบเสร็จ " + deleted + " แถว");
  } catch (e) {
    Logger.log("Error cleaning up marketplace: " + e.message);
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

// ============================================================
// _backupSheetToCsv — สำรองชีตเป็น CSV ลง Drive
// คืนค่า fileId ถ้าสำเร็จ, null ถ้าล้มเหลว
// keepCount = จำนวนไฟล์ที่จะเก็บ (rolling) — ถ้าเกิน จะลบของเก่าทิ้ง
// ============================================================
function _backupSheetToCsv(sheetName, keepCount) {
  if (!keepCount || keepCount < 1) keepCount = 14;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return null;
    const data = sheet.getDataRange().getValues();
    if (data.length === 0) return null;

    const tz = Session.getScriptTimeZone();
    const csv = data.map(row => row.map(cell => {
      if (cell instanceof Date) return Utilities.formatDate(cell, tz, "yyyy-MM-dd HH:mm:ss");
      const s = String(cell == null ? "" : cell);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\n");

    const folder = DriveApp.getFolderById(TARGET_FOLDER_ID);
    let backupFolder;
    const sub = folder.getFoldersByName("backups");
    backupFolder = sub.hasNext() ? sub.next() : folder.createFolder("backups");

    const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd_HH-mm-ss");
    const name  = sheetName + "_" + stamp + ".csv";
    const file  = backupFolder.createFile(name, csv, MimeType.CSV);

    // rolling cleanup — เก็บแค่ keepCount ไฟล์ล่าสุดของชีตนี้
    const existing = [];
    const it = backupFolder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (f.getName().indexOf(sheetName + "_") === 0) existing.push(f);
    }
    existing.sort((a, b) => b.getDateCreated().getTime() - a.getDateCreated().getTime());
    for (let i = keepCount; i < existing.length; i++) {
      try { existing[i].setTrashed(true); } catch(_) {}
    }

    Logger.log("[_backupSheetToCsv] backup เสร็จ: " + name + " (" + data.length + " แถว, keep=" + keepCount + ")");
    return file.getId();
  } catch(e) {
    Logger.log("[_backupSheetToCsv] error: " + e.message);
    return null;
  }
}

// ============================================================
// backupOrdersDaily — รันโดย trigger ทุกวัน 01:00 น.
// สำรอง Orders sheet เก็บย้อนหลัง 30 วัน (= 30 ไฟล์)
// ============================================================
const ORDERS_BACKUP_KEEP_DAYS = 30;

function backupOrdersDaily() {
  try {
    const id = _backupSheetToCsv(SHEET_ORDERS, ORDERS_BACKUP_KEEP_DAYS);
    if (!id) {
      Logger.log("[backupOrdersDaily] backup ล้มเหลว");
      _alertOwner("Orders daily backup failed", "ไม่สามารถสำรอง Orders sheet เป็น CSV ได้ — ตรวจสอบ Drive permission/quota");
    }
  } catch(e) {
    Logger.log("[backupOrdersDaily] error: " + e.message);
    _alertOwner("Orders daily backup error", e.toString());
  }
}

// ============================================================
// _alertOwner — ส่งอีเมลแจ้งเจ้าของ script (best-effort)
// ============================================================
function _alertOwner(subject, body) {
  try {
    const email = Session.getEffectiveUser().getEmail();
    if (!email) return;
    MailApp.sendEmail(email, "[Scanner PRO] " + subject, body);
  } catch(e) {
    Logger.log("[_alertOwner] error: " + e.message);
  }
}

// ============================================================
// cleanUpOldOrders — ลบรายการเก่ากว่า 90 วันใน Orders sheet
// ✅ ใช้ deleteRows() แบบ contiguous ranges (ไม่ใช่ clearContents+setValues)
//    ถ้า fail กลางทาง ส่วนที่เหลือยังอยู่ครบ
// ✅ Sanity guard — ถ้าจะลบเกิน 20% ของแถวทั้งหมด → abort + แจ้งเตือน
// ✅ CSV backup ลง Drive ก่อนลบทุกครั้ง
// ============================================================
const CLEANUP_ORDERS_RETENTION_DAYS = 90;
const CLEANUP_MAX_DELETE_RATIO = 0.20; // ห้ามลบเกิน 20% ในการรันครั้งเดียว

function cleanUpOldOrders() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch(e) {
    Logger.log("[cleanUpOldOrders] ไม่ได้ lock ภายใน 30s: " + e.message);
    return;
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS);
    if (!sheet) {
      Logger.log("Orders sheet not found: " + SHEET_ORDERS);
      return;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      Logger.log("[cleanUpOldOrders] ไม่มีข้อมูล");
      return;
    }

    // อ่านเฉพาะคอลัมน์ A (timestamp) — เร็วและกินเมโมรี่น้อยกว่า getDataRange ทั้งชีต
    const tsValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - CLEANUP_ORDERS_RETENTION_DAYS);
    cutoff.setHours(0, 0, 0, 0);

    // หา sheet row ที่เก่ากว่า cutoff (1-indexed)
    const rowsToDelete = [];
    for (let i = 0; i < tsValues.length; i++) {
      const ts = tsValues[i][0];
      if (!ts) continue; // ⚠️ ข้ามแถวที่ timestamp ว่าง — ไม่ลบ (กัน false positive)
      const d = ts instanceof Date ? ts : new Date(ts);
      if (isNaN(d.getTime())) continue; // ⚠️ ข้ามแถวที่ parse ไม่ได้ — ไม่ลบ
      // ⏱️ Timestamp = เวลาแพค → straggler เวลาแพคเก่าอาจเพิ่ง append → กันลบ row ท้ายชีต
      if (d < cutoff && (i + 2) <= lastRow - CLEANUP_PROTECT_TAIL_ROWS) rowsToDelete.push(i + 2); // sheet row = tsValues index + 2
    }

    if (rowsToDelete.length === 0) {
      Logger.log("[cleanUpOldOrders] ไม่พบรายการที่เก่ากว่า " + CLEANUP_ORDERS_RETENTION_DAYS + " วัน");
      return;
    }

    // 🛡️ Sanity guard — abort ถ้าจะลบเยอะผิดปกติ
    const totalDataRows = lastRow - 1;
    const ratio = rowsToDelete.length / totalDataRows;
    if (ratio > CLEANUP_MAX_DELETE_RATIO) {
      const msg = "ABORT: cleanUpOldOrders จะลบ " + rowsToDelete.length + "/" + totalDataRows +
                  " แถว (" + (ratio * 100).toFixed(1) + "%) เกินเพดาน " +
                  (CLEANUP_MAX_DELETE_RATIO * 100) + "% — น่าจะมีอะไรผิดปกติ ตรวจสอบก่อน";
      Logger.log("[cleanUpOldOrders] " + msg);
      _alertOwner("Orders cleanup aborted (suspicious)", msg);
      return;
    }

    // 💾 Backup ก่อนลบ
    const backupId = _backupSheetToCsv(SHEET_ORDERS);
    if (!backupId) {
      Logger.log("[cleanUpOldOrders] backup ล้มเหลว — abort cleanup เพื่อความปลอดภัย");
      _alertOwner("Orders cleanup aborted (backup failed)",
                  "ไม่สามารถสำรองข้อมูล Orders ก่อน cleanup ได้ — ยกเลิกการลบเพื่อความปลอดภัย");
      return;
    }

    // จัดกลุ่ม contiguous ranges แล้วลบจากล่างขึ้นบน (กัน index shift)
    rowsToDelete.sort((a, b) => b - a);
    let deleted = 0;
    let i = 0;
    while (i < rowsToDelete.length) {
      const top = rowsToDelete[i];
      let count = 1;
      while (i + 1 < rowsToDelete.length && rowsToDelete[i + 1] === top - count) {
        count++;
        i++;
      }
      const start = top - count + 1;
      try {
        sheet.deleteRows(start, count);
        deleted += count;
      } catch(e) {
        Logger.log("[cleanUpOldOrders] deleteRows fail ที่แถว " + start + " (" + count + " แถว): " + e.message);
        _alertOwner("Orders cleanup partial failure",
                    "ลบสำเร็จ " + deleted + "/" + rowsToDelete.length + " แถว แล้วเกิด error: " + e.message +
                    "\n\nBackup ID: " + backupId);
        break;
      }
      i++;
    }
    SpreadsheetApp.flush();
    Logger.log("[cleanUpOldOrders] ลบเสร็จ " + deleted + " แถว (backup=" + backupId + ")");
  } catch (e) {
    Logger.log("Error in cleanUpOldOrders: " + e.message);
    _alertOwner("Orders cleanup error", e.toString());
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

// ============================================================
// 🗂️ sortOrdersByDate — เรียง Orders sheet ตาม Timestamp (คอลัมน์ A) เก่า→ใหม่ — รันทุกตี 5
//   เพราะ row Timestamp = "เวลาแพค" ไม่ใช่เวลา drain เขียน → ลำดับ append ไม่ตรงเวลา (มี straggler)
//   เรียงคืนให้ "ใหม่อยู่ล่างสุด" → bottom-up scan (stats/report/reconcile/findRow) แม่นขึ้น
//   ถือ getScriptLock = exclusive กับ append ของ drain/saveData (กันเรียงทับตอนกำลังเขียน)
//   หมายเหตุ: parcel row cache (CacheService) จะ stale หลัง sort แต่ _findParcelRow re-validate
//            col D เองอยู่แล้ว (เจอ mismatch → ล้าง+scan ใหม่) → ไม่ต้องล้าง cache
// ============================================================
function sortOrdersByDate() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_ORDERS);
  if (!sheet) { Logger.log("[sortOrders] ไม่พบชีต Orders"); return; }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(120000); } // ตี 5 ไม่มีคนแพค → รอ lock ได้นาน
  catch(e) { Logger.log("[sortOrders] ไม่ได้ lock: " + e.message); return; }
  try {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 3) { Logger.log("[sortOrders] แถวน้อยเกินไป ข้าม"); return; }
    sheet.getRange(2, 1, lastRow - 1, lastCol).sort({ column: 1, ascending: true }); // ข้าม header แถว 1
    SpreadsheetApp.flush();
    Logger.log("[sortOrders] ✅ เรียง " + (lastRow - 1) + " แถวตาม Timestamp เก่า→ใหม่");
  } catch(e) {
    Logger.log("[sortOrders] error: " + e.message);
  } finally { try { lock.releaseLock(); } catch(_) {} }
}

// ============================================================
// setupDailyCleanupTrigger — ตั้ง triggers ทั้งหมด
//   01:00 น. → backupOrdersDaily         (สำรอง Orders เก็บย้อนหลัง 30 วัน)
//   02:00 น. → cleanUpOldOrders          (ลบ Orders ที่เก่ากว่า 90 วัน)
//   03:00 น. → cleanUpOldMarketplaceData (ลบ MarketplaceData ที่เก่ากว่า 2 วัน)
//   05:00 น. → sortOrdersByDate          (เรียง Orders ตามวันที่)
// รันฟังก์ชันนี้ครั้งเดียวใน Apps Script editor หลัง deploy
// ============================================================
function setupDailyCleanupTrigger() {
  // ลบ trigger เดิม (กันซ้ำซ้อนถ้ารันหลายรอบ)
  const HANDLERS = ["cleanUpOldOrders", "backupOrdersDaily",
                    "cleanUpOldMarketplaceData", "reconcileSaveLogVsOrders",
                    "mergeDuplicateOrders", "nightlyStatsRebuild", "nightlyVideoReconcile",
                    "sortOrdersByDate"];
  ScriptApp.getProjectTriggers().forEach(t => {
    if (HANDLERS.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // ✅ Reconciliation รันก่อน cleanup — เพื่อเห็นยอดวันนี้ก่อนที่ Orders จะถูกลบ
  ScriptApp.newTrigger("reconcileSaveLogVsOrders")
    .timeBased().everyDays(1).atHour(23).create();

  // ✅ Merge duplicates ก่อน reconcile — รวม row ที่ซ้ำกัน (จาก lock-free races)
  ScriptApp.newTrigger("mergeDuplicateOrders")
    .timeBased().everyDays(1).atHour(22).create();

  // ✅ Rebuild Firebase stats 3 วันล่าสุด ตอน 04:00 (หลัง merge/cleanup ทุกตัว → exact)
  ScriptApp.newTrigger("nightlyStatsRebuild")
    .timeBased().everyDays(1).atHour(4).create();

  // 🗂️ เรียง Orders ตาม Timestamp เก่า→ใหม่ — 05:00 (ถือ script lock, exclusive กับ append)
  ScriptApp.newTrigger("sortOrdersByDate")
    .timeBased().everyDays(1).atHour(5).create();

  // ✅ เติม videoUrl ให้ row ที่ no_video แต่มีไฟล์ใน Drive (กู้ race ที่ scan พลาด) — 06:00 (หลัง sort)
  ScriptApp.newTrigger("nightlyVideoReconcile")
    .timeBased().everyDays(1).atHour(6).create();

  // Backup ก่อน cleanup 1 ชั่วโมง — backup ล่าสุดจะเป็น snapshot ก่อนถูกตัด
  ScriptApp.newTrigger("backupOrdersDaily")
    .timeBased().everyDays(1).atHour(1).create();

  ScriptApp.newTrigger("cleanUpOldOrders")
    .timeBased().everyDays(1).atHour(2).create();

  // ✅ Marketplace cleanup ย้ายมาเป็น scheduled trigger
  // (เดิมรันใน finally ของ saveMarketplaceData → ทำให้ upload หน่วง)
  ScriptApp.newTrigger("cleanUpOldMarketplaceData")
    .timeBased().everyDays(1).atHour(3).create();

  Logger.log("✅ Daily triggers set:");
  Logger.log("   22:00 น. → mergeDuplicateOrders (รวม row ซ้ำจาก lock-free races)");
  Logger.log("   23:00 น. → reconcileSaveLogVsOrders (เปรียบเทียบ SaveLog vs Orders)");
  Logger.log("   01:00 น. → backupOrdersDaily (เก็บ " + ORDERS_BACKUP_KEEP_DAYS + " วัน)");
  Logger.log("   02:00 น. → cleanUpOldOrders (เก็บ " + CLEANUP_ORDERS_RETENTION_DAYS + " วัน)");
  Logger.log("   03:00 น. → cleanUpOldMarketplaceData (เก็บ 2 วัน)");
  Logger.log("   04:00 น. → nightlyStatsRebuild (rebuild Firebase stats 3 วันล่าสุด)");
  Logger.log("   05:00 น. → sortOrdersByDate (เรียง Orders ตาม Timestamp เก่า→ใหม่)");
  Logger.log("   06:00 น. → nightlyVideoReconcile (เติม videoUrl จาก Drive ให้ row no_video)");
}

// ============================================================
// mergeDuplicateOrders — รวม row ที่มี parcelId ซ้ำกันใน Orders sheet
//   เกิดจาก race condition ใน lock-free saveData (rare)
//   logic: เก็บ row ที่ "ครบสุด" (มี videoUrl, มี items, มี orderId) ลบที่เหลือ
//   ถ้าเทียบกันแล้วเท่ากัน → เก็บ row ที่ใหม่กว่า (timestamp ใหญ่กว่า)
// ============================================================
function mergeDuplicateOrders() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); }
  catch(e) {
    Logger.log("[mergeDuplicateOrders] ไม่ได้ lock: " + e.message);
    return;
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return;

    // อ่านทั้งชีต (รับได้ — รันแค่กลางคืน)
    const data = sheet.getDataRange().getValues();
    const header = data[0];

    // group rows ตาม tracking (col D = index 3)
    const groups = {}; // tracking → [{ rowIndex (1-based sheet), data }]
    for (let i = 1; i < data.length; i++) {
      const tracking = String(data[i][3] || "").trim().toUpperCase();
      if (!tracking) continue;
      if (!groups[tracking]) groups[tracking] = [];
      groups[tracking].push({ rowIndex: i + 1, data: data[i] });
    }

    // หา group ที่มี duplicate
    const rowsToDelete = []; // sheet row indices (1-based)
    let mergedCount = 0;
    for (const tracking in groups) {
      const group = groups[tracking];
      if (group.length < 2) continue;

      // คะแนนความครบของ row (มากกว่า = ครบกว่า)
      const score = (r) => {
        const d = r.data;
        let s = 0;
        const videoUrl = String(d[4] || "");
        if (videoUrl.indexOf('drive.google.com') !== -1) s += 100;
        const remark = String(d[5] || "");
        if (remark && remark.indexOf("__VIDEO_FIRST__") !== 0) s += 10;
        const itemsCount = Number(d[6]) || 0;
        s += itemsCount; // item count
        const orderId = String(d[1] || "");
        if (orderId) s += 50;
        const marketplace = String(d[2] || "");
        if (marketplace) s += 5;
        return s;
      };

      // sort: คะแนนสูงสุดก่อน, ถ้าเท่ากันใช้ timestamp ใหม่กว่า
      group.sort((a, b) => {
        const sb = score(b), sa = score(a);
        if (sb !== sa) return sb - sa;
        const tb = (b.data[0] instanceof Date) ? b.data[0].getTime() : 0;
        const ta = (a.data[0] instanceof Date) ? a.data[0].getTime() : 0;
        return tb - ta;
      });

      // เก็บตัวแรก (ครบสุด), ลบที่เหลือ
      const keep = group[0];
      // ถ้า keep ไม่มี videoUrl แต่ตัวอื่นมี → copy มาใส่ keep
      if (String(keep.data[4] || "").indexOf('drive.google.com') === -1) {
        for (let i = 1; i < group.length; i++) {
          const otherVid = String(group[i].data[4] || "");
          if (otherVid.indexOf('drive.google.com') !== -1) {
            sheet.getRange(keep.rowIndex, 5).setValue(otherVid);
            break;
          }
        }
      }
      for (let i = 1; i < group.length; i++) {
        rowsToDelete.push(group[i].rowIndex);
        mergedCount++;
      }
    }

    if (rowsToDelete.length === 0) {
      Logger.log("[mergeDuplicateOrders] ไม่พบ duplicate");
      return;
    }

    // ลบจากล่างขึ้นบน (กัน index shift)
    rowsToDelete.sort((a, b) => b - a);
    let i = 0;
    while (i < rowsToDelete.length) {
      const top = rowsToDelete[i];
      let count = 1;
      while (i + 1 < rowsToDelete.length && rowsToDelete[i + 1] === top - count) {
        count++;
        i++;
      }
      const start = top - count + 1;
      sheet.deleteRows(start, count);
      i++;
    }
    SpreadsheetApp.flush();
    Logger.log("[mergeDuplicateOrders] รวม " + mergedCount + " duplicates");
    _logSaveAttempt("", "", "merge_dedup", mergedCount, "deleted " + mergedCount + " duplicate rows");
    if (mergedCount > 50) {
      _alertOwner("Merge dedup: ลบ duplicates " + mergedCount + " rows",
                  "พบ duplicate เยอะผิดปกติ ตรวจสอบ network/race condition");
    }
  } catch(e) {
    Logger.log("[mergeDuplicateOrders] error: " + e.message);
    _alertOwner("mergeDuplicateOrders error", e.toString());
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

// ============================================================
// findLostOrders — หา tracking ที่ SaveLog บอก "success" แต่หายจาก Orders sheet
//   (= ถูก concurrent appendRow เขียนทับ → ข้อมูลหาย)
//   รันใน editor: ดู Logger + จะได้อีเมลรายการที่หาย
//   หมายเหตุ: เช็คย้อนหลังตาม SaveLog ที่มี (SaveLog ไม่ถูกลบอัตโนมัติ)
// ============================================================
function findLostOrders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("SaveLog");
  const ordSheet = ss.getSheetByName(SHEET_ORDERS);
  if (!logSheet || !ordSheet) { Logger.log("[findLostOrders] sheet ไม่ครบ"); return; }

  // 1) tracking ที่ SaveLog บอกว่า success (มาถึง server จริง)
  const successInfo = {}; // tracking -> { ts, marketplace, items }
  if (logSheet.getLastRow() > 1) {
    const ld = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 5).getValues();
    for (let i = 0; i < ld.length; i++) {
      const result = String(ld[i][3] || "").toLowerCase();
      if (result !== "success" && result !== "success_video_pending") continue;
      const tk = String(ld[i][1] || "").trim().toUpperCase();
      if (!tk) continue;
      successInfo[tk] = { ts: ld[i][0], marketplace: ld[i][2], items: ld[i][4] };
    }
  }

  // 2) tracking ที่อยู่ใน Orders จริง
  const present = new Set();
  if (ordSheet.getLastRow() > 1) {
    const od = ordSheet.getRange(2, 4, ordSheet.getLastRow() - 1, 1).getValues();
    od.forEach(r => { const t = numToStr(r[0]).toUpperCase(); if (t) present.add(t); });
  }

  // 3) success แต่ไม่อยู่ในชีต = หาย
  const lost = [];
  for (const tk in successInfo) {
    if (!present.has(tk)) lost.push({ tracking: tk, ...successInfo[tk] });
  }
  lost.sort((a, b) => (a.ts instanceof Date ? a.ts.getTime() : 0) - (b.ts instanceof Date ? b.ts.getTime() : 0));

  const tz = Session.getScriptTimeZone();
  Logger.log("[findLostOrders] success ใน SaveLog: " + Object.keys(successInfo).length +
             " | อยู่ในชีต: " + present.size + " | หาย: " + lost.length);
  const lines = lost.map(o => {
    const tstr = (o.ts instanceof Date) ? Utilities.formatDate(o.ts, tz, "dd/MM/yyyy HH:mm:ss") : "";
    return tstr + "  " + o.tracking + "  " + (o.marketplace || "") + "  items=" + (o.items || 0);
  });
  lines.forEach(l => Logger.log("  ❌ " + l));

  if (lost.length > 0) {
    _alertOwner("พบออเดอร์หาย " + lost.length + " ใบ (เขียนทับจาก concurrent save)",
      "tracking ที่ SaveLog บอกสำเร็จแต่ไม่อยู่ใน Orders sheet:\n\n" + lines.join("\n") +
      "\n\n→ ต้องแพคใหม่ หรือเพิ่มเข้าชีตด้วยมือ (สินค้าที่คาดหวังดูได้จาก MarketplaceData)");
  }
  return { successCount: Object.keys(successInfo).length, present: present.size, lost: lost.map(o => o.tracking) };
}

// ============================================================
// getAllPendingOrders
// ============================================================
function getAllPendingOrders() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const orderSheet = ss.getSheetByName(SHEET_ORDERS);
    const packedTrackings = new Set();
    if (orderSheet) {
      const lastRow = orderSheet.getLastRow();
      if (lastRow > 1) {
        const colD = orderSheet.getRange(2, 4, lastRow - 1, 1).getValues();
        colD.forEach(r => {
          const t = numToStr(r[0]).toUpperCase();
          if (t) packedTrackings.add(t);
        });
      }
    }

    try {
      const props = PropertiesService.getScriptProperties();
      const propPacked = JSON.parse(props.getProperty('packedTrackings') || '[]');
      propPacked.forEach(t => packedTrackings.add(String(t).toUpperCase()));
    } catch(e) {
      Logger.log("[getAllPendingOrders] PropertiesService error: " + e.message);
    }

    const sheet = ss.getSheetByName(SHEET_MARKETPLACE);
    if (!sheet) return {};

    const data = sheet.getDataRange().getValues();
    const result = {};

    for (let i = 1; i < data.length; i++) {
      const marketplace = String(data[i][1] || "").trim().toLowerCase();
      const tracking    = numToStr(data[i][2]).toUpperCase();
      const sku         = numToStr(data[i][3]).toUpperCase();
      const qty         = parseInt(data[i][4]) || 1;
      const remark      = String(data[i][5] || "").trim();
      const orderId     = numToStr(data[i][6]);

      if (!tracking || !sku) continue;
      if (packedTrackings.has(tracking)) continue;

      if (!result[tracking]) result[tracking] = [];

      const existing = result[tracking].find(function(item) { return item.sku === sku; });
      if (existing) {
        existing.qty += qty;
        if (!existing.remark && remark) existing.remark = remark;
        if (orderId && !existing.orderId.split(',').map(s=>s.trim()).includes(orderId)) {
          existing.orderId = existing.orderId ? existing.orderId + ',' + orderId : orderId;
        }
      } else {
        result[tracking].push({ sku, qty, remark, orderId, marketplace });
      }
    }

    return result;
  } catch (e) {
    Logger.log("Error in getAllPendingOrders: " + e.message);
    return {};
  }
}

// ============================================================
// getSpreadsheetUrl
// ============================================================
function getSpreadsheetUrl() {
  try {
    return { url: SpreadsheetApp.getActiveSpreadsheet().getUrl() };
  } catch(e) {
    return { url: '', error: e.toString() };
  }
}
