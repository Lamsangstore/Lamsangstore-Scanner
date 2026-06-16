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

// กัน Drive bombing — base64 ~14MB ≈ raw video ~10MB
const MAX_VIDEO_BASE64_LEN = 14 * 1024 * 1024;

// ✅ Marker สำหรับ row ที่ video ถูก upload ก่อน order data
//    uploadVideoForParcel ใส่ในคอลัมน์ remark (F) เพื่อให้ saveData ตรวจเจอ
//    และ "upgrade" row นั้นด้วยข้อมูลเต็มแทนที่จะ skip เป็น duplicate
const PLACEHOLDER_MARKER = "__VIDEO_FIRST__ waiting for order data";

// ✅ Cache-based dedup — แทนการอ่าน column tracking ทั้งหมดจาก sheet
//    เดิม: scan 16K rows ใน lock = 1-3s → lock_timeout
//    ใหม่: CacheService.get() = 10ms → lock hold time ~700ms
//    ค่าใน cache: "<rowIndex>" สำหรับ row ปกติ, "P:<rowIndex>" สำหรับ placeholder
const PARCEL_CACHE_PREFIX = 'parcel_';
const PARCEL_CACHE_TTL_SEC = 6 * 60 * 60; // 6 ชม.
const FALLBACK_SCAN_RECENT_ROWS = 2000;   // ถ้า cache miss → scan แค่ 2000 แถวล่าสุด (ไม่ใช่ทั้ง 16K+)

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

// ✅ cron — ดูด /inbox เข้า sheet แล้วลบ doc ที่สำเร็จ
//   reuse saveData() เต็มรูปแบบ → ได้ dedup + idempotency + cache ฟรี
function drainFirebaseInbox() {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) { Logger.log("[drainFirebase] ยังไม่ได้ setupFirebase()"); return; }

  // กันรันซ้อน
  const lock = LockService.getScriptLock();
  try { if (!lock.tryLock(5000)) { Logger.log("[drainFirebase] ตัวก่อนยังรันอยู่ ข้าม"); return; } }
  catch(e) { return; }

  try {
    const listUrl = cfg.url + "/inbox.json?auth=" + encodeURIComponent(cfg.secret);
    const resp = UrlFetchApp.fetch(listUrl, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log("[drainFirebase] list fail: " + resp.getResponseCode() + " " + resp.getContentText().slice(0, 200));
      return;
    }
    const body = resp.getContentText();
    if (!body || body === "null") return; // inbox ว่าง
    let docs;
    try { docs = JSON.parse(body); } catch(e) { Logger.log("[drainFirebase] bad json"); return; }

    const keys = Object.keys(docs || {});
    if (keys.length === 0) return;
    Logger.log("[drainFirebase] พบ " + keys.length + " docs ใน inbox");

    let drained = 0, failed = 0;
    // จำกัดต่อรอบ กัน execution timeout (6 นาที) — ที่เหลือรอบหน้า
    const MAX_PER_RUN = 200;
    for (let i = 0; i < keys.length && i < MAX_PER_RUN; i++) {
      const key = keys[i];
      const d = docs[key] || {};
      // validate
      const parcelId = String(d.parcelId || "").trim();
      if (!parcelId || parcelId.length > 64) {
        // junk → ลบทิ้ง
        _firebaseDelete(cfg, key);
        continue;
      }
      // ✅ RTDB อาจคืน array เป็น object {"0":..,"1":..} หรือมี null คั่น → normalize เป็น array เสมอ
      //   กัน items หาย (เคยเขียน array แต่ดึงกลับเป็น object → Array.isArray=false → items=[])
      let itemsArr;
      if (Array.isArray(d.items)) itemsArr = d.items.filter(x => x != null);
      else if (d.items && typeof d.items === 'object') itemsArr = Object.values(d.items).filter(x => x != null);
      else itemsArr = [];
      try {
        const res = saveData({
          parcelId: parcelId,
          items: itemsArr,
          orderId: d.orderId || "",
          marketplace: d.marketplace || "",
          remark: d.remark || "",
          idemToken: d.idemToken || "",
          videoEvidence: "no_video",          // video มาทาง direct GAS call เท่านั้น
          videoMimeType: "video/webm"
        });
        if (res && res.success) {
          _firebaseDelete(cfg, key); // เข้า sheet แล้ว → ลบ doc
          drained++;
        } else {
          failed++;
        }
      } catch(e) {
        Logger.log("[drainFirebase] saveData error " + parcelId + ": " + e.message);
        failed++;
      }
    }
    if (drained > 0 || failed > 0) {
      Logger.log("[drainFirebase] drained=" + drained + " failed=" + failed);
      _logSaveAttempt("", "", "firebase_drain", drained, "drained=" + drained + " failed=" + failed);
    }
  } catch(e) {
    Logger.log("[drainFirebase] error: " + e.message);
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

function _firebaseDelete(cfg, key) {
  try {
    const url = cfg.url + "/inbox/" + encodeURIComponent(key) + ".json?auth=" + encodeURIComponent(cfg.secret);
    UrlFetchApp.fetch(url, { method: "delete", muteHttpExceptions: true });
  } catch(e) {
    Logger.log("[_firebaseDelete] " + key + ": " + e.message);
  }
}

// ตั้ง trigger drain ทุก 1 นาที (รันครั้งเดียวใน editor)
function setupFirebaseTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === "drainFirebaseInbox" || fn === "refreshRecentStats" || fn === "refreshPendingCache") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("drainFirebaseInbox").timeBased().everyMinutes(1).create();
  // 📊 อัปเดต stats รายงานเข้า Firebase ทุก 5 นาที (เบื้องหลัง — ไม่แตะ saveData)
  ScriptApp.newTrigger("refreshRecentStats").timeBased().everyMinutes(5).create();
  // 📋 อัปเดต pending orders + products ทุก 5 นาที (ข้ามถ้าข้อมูลไม่เปลี่ยน — กัน quota)
  ScriptApp.newTrigger("refreshPendingCache").timeBased().everyMinutes(5).create();
  Logger.log("✅ Firebase triggers: drain(1m) + stats(5m) + pending(5m)");
}

// ============================================================
// 📋 PENDING CACHE → Firebase — มือถืออ่าน /pending แทนเรียก getAllPendingOrders (ช้า)
//   GAS คำนวณ logic เดิม (ไม่แตะ) แล้วเก็บผลลัพธ์ + product map ลง Firebase
//   มือถืออ่านตรง ~100ms ไม่ต้องรอ scan MarketplaceData + cold start
//   ✅ ข้ามถ้า Orders/MarketplaceData ไม่เปลี่ยนตั้งแต่รอบก่อน — กัน GAS quota หมด
// ============================================================
function refreshPendingCache(force) {
  const cfg = _firebaseCfg();
  if (!cfg.url || !cfg.secret) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ordSheet = ss.getSheetByName(SHEET_ORDERS);
    const mpSheet  = ss.getSheetByName(SHEET_MARKETPLACE);
    const pSheet   = ss.getSheetByName(SHEET_PRODUCTS);
    const sig = (ordSheet ? ordSheet.getLastRow() : 0) + ":" +
                (mpSheet ? mpSheet.getLastRow() : 0) + ":" +
                (pSheet ? pSheet.getLastRow() : 0);

    const props = PropertiesService.getScriptProperties();
    if (!force && props.getProperty('pendingCacheSig') === sig) {
      // ไม่มีอะไรเปลี่ยน → ข้าม (ออกเร็ว <1s กัน quota)
      return;
    }

    const pending = getAllPendingOrders();   // ✅ reuse logic เดิม
    const products = getProductData();

    _fbPut(cfg, "/pending.json", pending);
    _fbPut(cfg, "/products.json", products);
    _fbPut(cfg, "/cacheMeta.json", { ts: Date.now() });
    props.setProperty('pendingCacheSig', sig);
    Logger.log("[refreshPendingCache] pending=" + Object.keys(pending).length +
               " products=" + Object.keys(products).length + " sig=" + sig);
  } catch(e) {
    Logger.log("[refreshPendingCache] error: " + e.message);
  }
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
  let stop = false;
  while (row >= 2 && !stop) {
    const from = Math.max(2, row - CHUNK + 1);
    const n = row - from + 1;
    const data = sheet.getRange(from, 1, n, lastCol).getValues();
    for (let i = data.length - 1; i >= 0; i--) {
      const ts = data[i][0];
      if (!(ts instanceof Date)) continue;
      const dayKey = Utilities.formatDate(ts, tz, "yyyy-MM-dd");
      if (dayKey < minDate) { stop = true; break; } // พ้นช่วงล่างสุดแล้ว
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
  let row = lastRow, stop = false;
  while (row >= 2 && !stop) {
    const from = Math.max(2, row - CHUNK + 1);
    const data = sheet.getRange(from, 1, row - from + 1, lastCol).getValues();
    for (let i = data.length - 1; i >= 0; i--) {
      const ts = data[i][0];
      if (!(ts instanceof Date)) continue;
      const dayKey = Utilities.formatDate(ts, tz, "yyyy-MM-dd");
      if (dayKey < minDate) { stop = true; break; }
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
//    fullScan=true → scan ทั้งชีต (ช้ากว่าแต่หาเจอเสมอ — ใช้ใน uploadVideoForParcel)
//    fullScan=false → scan แค่ 2000 แถวล่าสุด (เร็ว — ใช้ใน saveData hot path)
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
  uploadVideoForParcel: 120,
  reconcileVideoUrls: 6,
  _default: 120
};

const ALLOWED_ACTIONS = new Set([
  "getProductData", "saveData", "searchData", "saveMarketplaceData",
  "getExpectedOrderDetails", "getReportData", "getAllPendingOrders",
  "getSpreadsheetUrl", "getMarketplaceVersionUrl",
  "uploadVideoForParcel", "reconcileVideoUrls"
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
    else if (action === "uploadVideoForParcel")       result = uploadVideoForParcel(body);
    else if (action === "reconcileVideoUrls")         result = reconcileVideoUrls(body);

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
    const WRITE_ACTIONS = new Set(["saveData", "uploadVideoForParcel", "saveMarketplaceData", ""]);
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
// saveData — LOCK-FREE + appendRow + cache-based dedup + audit log
//   เปลี่ยน design: ไม่มี LockService อีกแล้ว
//   - appendRow() ของ Sheets API atomic ระดับ row → ไม่มี overwrite collision
//   - idempotency token + cache → กัน duplicate ส่วนใหญ่
//   - rare duplicates (2 device save parcel เดียวกันใน 200ms) → mergeDuplicateOrders ลบให้
//   - video upload รวมกับ save → ไม่ต้องเก็บใน IDB
// ============================================================
function saveData(body) {
  // --- validate input ---
  const parcelId    = String(body.parcelId || "").trim();
  const orderId     = String(body.orderId || "").slice(0, 128);
  const marketplace = String(body.marketplace || "").slice(0, 32);
  const remark      = String(body.remark || "").slice(0, 500);
  const itemsArr    = Array.isArray(body.items) ? body.items : [];

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

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS) || ss.insertSheet(SHEET_ORDERS);

    // ⚡ Dedup ผ่าน cache + fallback scan (ไม่มี lock)
    //    Race condition rare: 2 saves ของ parcel เดียวกันใน <200ms → อาจมี 2 rows
    //    → mergeDuplicateOrders() กลางคืนจะรวมให้
    const found = _findParcelRow(sheet, parcelId);
    if (found) {
      const matchRow = found.rowIndex;

      // ✅ placeholder → upgrade
      if (found.isPlaceholder) {
        const existingVideoUrl = String(sheet.getRange(matchRow, 5).getValue() || "no_video").trim();
        // upload video ก่อน (ถ้ามี) — outside lock
        let videoUrl = "no_video";
        if (videoBase64 && videoBase64 !== "no_video" && videoBase64 !== "video_too_large") {
          videoUrl = _uploadVideoToDrive(videoBase64, videoMime, videoExt, parcelId);
        }
        const finalVideoUrl = (videoUrl && videoUrl !== "no_video" && videoUrl !== "upload_failed")
          ? videoUrl
          : existingVideoUrl;
        const upgradedRow = [new Date(), orderId, marketplace, parcelId, finalVideoUrl, remark, itemsArr.length, ...itemsArr.slice(0, 500).map(String)];
        sheet.getRange(matchRow, 1, 1, upgradedRow.length).setValues([upgradedRow]);
        _setCachedParcelRow(parcelId, matchRow, false);
        if (idemToken) _markTokenCompleted(idemToken);
        _logSaveAttempt(parcelId, marketplace, "placeholder_upgraded", itemsArr.length, "row " + matchRow);
        return { success: true, note: "placeholder_upgraded", row: matchRow };
      }

      // duplicate ปกติ
      let videoUrl = "no_video";
      if (videoBase64 && videoBase64 !== "no_video" && videoBase64 !== "video_too_large") {
        videoUrl = _uploadVideoToDrive(videoBase64, videoMime, videoExt, parcelId);
      }
      if (videoUrl && videoUrl !== "no_video" && videoUrl !== "upload_failed") {
        try {
          const currentVideoUrl = String(sheet.getRange(matchRow, 5).getValue()).trim();
          if (currentVideoUrl === "no_video") {
            sheet.getRange(matchRow, 5).setValue(videoUrl);
          }
        } catch(e) { Logger.log("[saveData] update existing video error: " + e.message); }
      }
      if (idemToken) _markTokenCompleted(idemToken);
      _logSaveAttempt(parcelId, marketplace, "duplicate_skipped", itemsArr.length, "row " + matchRow);
      return { success: true, note: "duplicate_skipped" };
    }

    // 🎬 Upload video → Drive (ก่อน appendRow เพื่อใส่ URL ลง row)
    let videoUrl = "no_video";
    if (videoBase64 && videoBase64 !== "no_video" && videoBase64 !== "video_too_large") {
      videoUrl = _uploadVideoToDrive(videoBase64, videoMime, videoExt, parcelId);
    } else if (videoBase64 === "video_too_large") {
      videoUrl = "video_too_large";
    }

    const timestamp = new Date();
    const row = [timestamp, orderId, marketplace, parcelId, videoUrl, remark, itemsArr.length, ...itemsArr.slice(0, 500).map(String)];

    // 🚀 appendRow — atomic ระดับ Sheets API, ไม่ต้องใช้ Lock เลย
    sheet.appendRow(row);
    const newRow = sheet.getLastRow();

    if (idemToken) _markTokenCompleted(idemToken);
    _setCachedParcelRow(parcelId, newRow, false);

    _logSaveAttempt(parcelId, marketplace, "success", itemsArr.length, "row " + newRow);
    Logger.log("[saveData] บันทึก: " + parcelId + " | row=" + newRow);

    // PropertiesService update — non-critical
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

    return { success: true, row: newRow };
  } catch (e) {
    Logger.log("Error in saveData: " + e.message);
    _logSaveAttempt(parcelId, marketplace, "exception", itemsArr.length, e.toString());
    return { success: false, error: e.toString() };
  }
}

// ✅ Helper: upload video → Drive, คืน URL (หรือ "upload_failed")
function _uploadVideoToDrive(videoBase64, videoMime, videoExt, parcelId) {
  try {
    const decoded = Utilities.base64Decode(videoBase64);
    const blob = Utilities.newBlob(decoded, videoMime, parcelId + "." + videoExt);
    const folder = DriveApp.getFolderById(TARGET_FOLDER_ID);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch(e) {
    Logger.log("[_uploadVideoToDrive] error: " + e.message);
    return "upload_failed";
  }
}

function _tryUpdateVideoUrl(sheet, rowIndex, parcelId, videoBase64, videoMime, videoExt) {
  try {
    const currentVideoUrl = String(sheet.getRange(rowIndex, 5).getValue()).trim();
    if (currentVideoUrl !== "no_video") return;
    if (videoBase64.length > MAX_VIDEO_BASE64_LEN) return;

    const mime = videoMime || "video/webm";
    const ext  = videoExt  || "webm";
    const decoded = Utilities.base64Decode(videoBase64);
    const blob    = Utilities.newBlob(decoded, mime, parcelId + "_retry." + ext);
    const folder  = DriveApp.getFolderById(TARGET_FOLDER_ID);
    const file    = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    sheet.getRange(rowIndex, 5).setValue(file.getUrl());
    Logger.log("[saveData] อัปเดตวิดีโอให้แถว " + rowIndex + ": " + parcelId);
  } catch(e) {
    Logger.log("[_tryUpdateVideoUrl] error: " + e.message);
  }
}

// ============================================================
// uploadVideoForParcel — phase 2 ของการบันทึก
// frontend จะเรียก saveData ก่อน (ส่งแค่ order, เร็ว) แล้วเรียกฟังก์ชันนี้ตามมา
// (ส่ง video, ช้ากว่า, retry แยกได้)
// flow:
//   1. หา row ของ parcelId ใน Orders sheet (ถ้าไม่พบ → saveData ยังไม่เสร็จ — error)
//   2. ถ้า row มี videoUrl เป็น Drive URL อยู่แล้ว → skip (ส่ง retry เกินมา)
//   3. อัปโหลด video ไป Drive (นอก lock — slow operation)
//   4. ถือ lock แค่ตอน setValue → ปล่อย lock เร็ว
// ============================================================
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

function reconcileVideoUrls(body) {
  body = body || {};
  const sinceDays = Math.max(1, Math.min(90, Number(body.sinceDays) || 7));

  try {
    const folder = DriveApp.getFolderById(TARGET_FOLDER_ID);
    const driveMap = {};
    const files = folder.getFiles();
    let driveCount = 0;
    while (files.hasNext()) {
      const f = files.next();
      const name = f.getName();
      const m = name.match(/^(.+?)(?:_retry)?\.(webm|mp4)$/i);
      if (!m) continue;
      const parcelId = m[1].toUpperCase();
      // เก็บไฟล์ใหม่สุดถ้ามีหลายไฟล์ (orphan retries)
      const ts = f.getDateCreated().getTime();
      if (!driveMap[parcelId] || driveMap[parcelId].ts < ts) {
        driveMap[parcelId] = { url: f.getUrl(), ts };
      }
      driveCount++;
    }
    Logger.log("[reconcileVideoUrls] อ่าน Drive: " + driveCount + " ไฟล์, unique parcels: " + Object.keys(driveMap).length);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS);
    if (!sheet) return { success: false, error: "Orders sheet ไม่พบ" };
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { success: true, fixed: 0, scanned: 0 };

    // อ่าน cols A (ts), D (tracking), E (videoUrl) เพื่อ filter เฉพาะแถวที่ no_video และอยู่ในช่วง sinceDays
    const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    const cutoff = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);

    const updates = []; // { row, url, parcelId }
    let scanned = 0;
    let skippedDateRange = 0;
    let skippedHadVideo = 0;
    let noDriveMatch = 0;

    for (let i = 0; i < data.length; i++) {
      const ts = data[i][0];
      const tracking = String(data[i][3] || "").trim().toUpperCase();
      const videoUrl = String(data[i][4] || "").trim();
      if (!tracking) continue;
      scanned++;

      // skip ถ้าเก่ากว่า sinceDays
      if (ts instanceof Date && ts.getTime() < cutoff) {
        skippedDateRange++;
        continue;
      }
      // skip ถ้ามี Drive URL อยู่แล้ว
      if (videoUrl.indexOf('drive.google.com') !== -1) {
        skippedHadVideo++;
        continue;
      }

      const driveEntry = driveMap[tracking];
      if (!driveEntry) { noDriveMatch++; continue; }

      updates.push({ row: i + 2, url: driveEntry.url, parcelId: tracking });
    }

    Logger.log("[reconcileVideoUrls] scanned=" + scanned + " toFix=" + updates.length +
               " skippedHadVideo=" + skippedHadVideo + " noDriveMatch=" + noDriveMatch +
               " skippedDateRange=" + skippedDateRange);

    // ใช้ lock สั้นๆ ตอน setValue เพื่อกัน race กับ saveData
    const lock = LockService.getScriptLock();
    try { lock.waitLock(30000); }
    catch(e) {
      return { success: false, error: "lock_timeout — server busy, retry", scanned, found: updates.length };
    }
    try {
      let written = 0;
      for (const u of updates) {
        try {
          // re-check ใน lock — กันกรณีอีก request เพิ่ง update
          const current = String(sheet.getRange(u.row, 5).getValue()).trim();
          if (current.indexOf('drive.google.com') !== -1) continue;
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
    } finally {
      lock.releaseLock();
    }
  } catch(e) {
    Logger.log("[reconcileVideoUrls] error: " + e.message);
    return { success: false, error: e.toString() };
  }
}

function uploadVideoForParcel(body) {
  const parcelId    = String(body.parcelId || "").trim();
  const videoBase64 = String(body.videoEvidence || "");
  const videoMimeIn = String(body.videoMimeType || "video/webm").toLowerCase().split(';')[0].trim();

  if (!parcelId) {
    _logSaveAttempt("", "", "video_invalid", 0, "parcelId ว่าง");
    return { success: false, error: "parcelId ว่าง" };
  }
  if (parcelId.length > 64) {
    _logSaveAttempt(parcelId, "", "video_invalid", 0, "parcelId ยาวเกินไป");
    return { success: false, error: "parcelId ยาวเกินไป" };
  }
  if (!videoBase64 || videoBase64 === "no_video") {
    _logSaveAttempt(parcelId, "", "video_invalid", 0, "ไม่มี video");
    return { success: false, error: "ไม่มี video" };
  }
  if (videoBase64.length > MAX_VIDEO_BASE64_LEN) {
    _logSaveAttempt(parcelId, "", "video_invalid", 0, "video too large: " + videoBase64.length);
    return { success: false, error: "Video too large" };
  }

  const ALLOWED_VIDEO_MIMES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
  const videoMime = ALLOWED_VIDEO_MIMES[videoMimeIn] ? videoMimeIn : 'video/webm';
  const videoExt  = ALLOWED_VIDEO_MIMES[videoMime];

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS) || ss.insertSheet(SHEET_ORDERS);

    // ⚡ Fast lookup ด้วย cache (10ms) แทน scan tracking column
    // ใช้ fullScan=true — Phase 2 ไม่ต้องเร็วมาก, ต้องหา row เก่าเจอเสมอ
    const foundExisting = _findParcelRow(sheet, parcelId, true);
    let rowIndex = foundExisting ? foundExisting.rowIndex : -1;

    // ถ้า row มี Drive URL อยู่แล้ว → skip (retry ที่ส่งเกินมา)
    if (rowIndex !== -1) {
      const currentVideoUrl = String(sheet.getRange(rowIndex, 5).getValue()).trim();
      if (currentVideoUrl && currentVideoUrl.indexOf('drive.google.com') !== -1) {
        Logger.log("[uploadVideoForParcel] " + parcelId + " มี video แล้ว skip");
        _logSaveAttempt(parcelId, "", "video_already_uploaded", 0, "row " + rowIndex);
        return { success: true, note: "already_has_video", videoUrl: currentVideoUrl };
      }
    }

    // อัปโหลด Drive (slow — นอก lock)
    //   ✅ ทำ "ก่อน" หา/สร้าง row — video ขึ้น Drive ได้แม้ saveData ยังไม่เสร็จ
    let videoUrl;
    try {
      const decoded = Utilities.base64Decode(videoBase64);
      const blob    = Utilities.newBlob(decoded, videoMime, parcelId + "." + videoExt);
      const folder  = DriveApp.getFolderById(TARGET_FOLDER_ID);
      const file    = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      videoUrl = file.getUrl();
    } catch(uploadErr) {
      Logger.log("[uploadVideoForParcel] อัปโหลด Drive fail: " + uploadErr.message);
      _logSaveAttempt(parcelId, "", "video_drive_fail", 0, uploadErr.message);
      return { success: false, error: "Drive upload fail: " + uploadErr.message };
    }

    // ถือ lock สั้นๆ ตอน setValue
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch(e) {
      Logger.log("[uploadVideoForParcel] ไม่ได้ lock: " + e.message);
      // Drive file อัปไปแล้ว — return videoUrl ให้ client retry แค่ setValue
      return { success: false, error: "Server busy, please retry", _orphanVideoUrl: videoUrl };
    }
    try {
      // re-check ใน lock ด้วย cache (fast) — กัน race condition
      const foundInLock = _findParcelRow(sheet, parcelId, true);
      let r2 = foundInLock ? foundInLock.rowIndex : -1;

      // ✅ ไม่พบ row → สร้าง placeholder row (saveData จะมา upgrade ทีหลัง)
      if (r2 === -1) {
        const ts = new Date();
        const placeholderRow = [ts, "", "", parcelId, videoUrl, PLACEHOLDER_MARKER, 0];
        const startRow = sheet.getLastRow() + 1;
        sheet.getRange(startRow, 1, 1, placeholderRow.length).setValues([placeholderRow]);
        SpreadsheetApp.flush();
        // populate cache → request ถัดไปไม่ต้อง scan
        _setCachedParcelRow(parcelId, startRow, true);
        Logger.log("[uploadVideoForParcel] สร้าง placeholder row " + startRow + " ให้ " + parcelId);
        _logSaveAttempt(parcelId, "", "video_placeholder_created", 0, "row " + startRow);
        return { success: true, note: "placeholder_created", row: startRow, videoUrl };
      }

      const cur = String(sheet.getRange(r2, 5).getValue()).trim();
      if (cur && cur.indexOf('drive.google.com') !== -1) {
        return { success: true, note: "already_has_video", videoUrl: cur };
      }
      sheet.getRange(r2, 5).setValue(videoUrl);
      SpreadsheetApp.flush();
      Logger.log("[uploadVideoForParcel] " + parcelId + " row=" + r2 + " video=" + videoUrl.substring(0, 40));
      _logSaveAttempt(parcelId, "", "video_uploaded", 0, "row " + r2);
      return { success: true, videoUrl, row: r2 };
    } finally {
      lock.releaseLock();
    }
  } catch(e) {
    Logger.log("[uploadVideoForParcel] error: " + e.message);
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
      if (d < cutoff) rowsToDelete.push(i + 2); // sheet row = tsValues index + 2
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
// setupDailyCleanupTrigger — ตั้ง triggers ทั้งหมด
//   01:00 น. → backupOrdersDaily         (สำรอง Orders เก็บย้อนหลัง 30 วัน)
//   02:00 น. → cleanUpOldOrders          (ลบ Orders ที่เก่ากว่า 90 วัน)
//   03:00 น. → cleanUpOldMarketplaceData (ลบ MarketplaceData ที่เก่ากว่า 2 วัน)
// รันฟังก์ชันนี้ครั้งเดียวใน Apps Script editor หลัง deploy
// ============================================================
function setupDailyCleanupTrigger() {
  // ลบ trigger เดิม (กันซ้ำซ้อนถ้ารันหลายรอบ)
  const HANDLERS = ["cleanUpOldOrders", "backupOrdersDaily",
                    "cleanUpOldMarketplaceData", "reconcileSaveLogVsOrders",
                    "mergeDuplicateOrders", "nightlyStatsRebuild", "nightlyVideoReconcile"];
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

  // ✅ เติม videoUrl ให้ row ที่ no_video แต่มีไฟล์ใน Drive (กู้ race ที่ scan พลาด) — 05:00
  ScriptApp.newTrigger("nightlyVideoReconcile")
    .timeBased().everyDays(1).atHour(5).create();

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
  Logger.log("   05:00 น. → nightlyVideoReconcile (เติม videoUrl จาก Drive ให้ row no_video)");
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
