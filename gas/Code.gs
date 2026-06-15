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
  _default: 120
};

const ALLOWED_ACTIONS = new Set([
  "getProductData", "saveData", "searchData", "saveMarketplaceData",
  "getExpectedOrderDetails", "getReportData", "getAllPendingOrders",
  "getSpreadsheetUrl", "getMarketplaceVersionUrl"
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
      return _json({ error: "Empty body" });
    }
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return _json({ error: "Bad JSON" });
    }

    if (!body || typeof body !== 'object') {
      return _json({ error: "Bad body" });
    }

    if (!_checkApiKey(body)) {
      Utilities.sleep(500); // slow down brute force a bit
      return _json({ error: "Unauthorized" });
    }

    const action = String(body.action || "");
    if (!ALLOWED_ACTIONS.has(action)) {
      return _json({ error: "Unknown action" });
    }

    if (!_checkRateLimit(action)) {
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

    return _json(result);

  } catch (err) {
    Logger.log("[doPost] error: " + err.toString());
    return _json({ error: "Server error" }); // ไม่คืน stack ให้ client เห็น
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
// saveData — Dedup + LockService + size limit + input validation + verify + audit log
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

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch(e) {
    Logger.log("[saveData] ไม่ได้ lock ภายใน 10s: " + e.message);
    _logSaveAttempt(parcelId, marketplace, "lock_timeout", itemsArr.length, e.message);
    return { success: false, error: "Server busy, please retry" };
  }

  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_ORDERS) || ss.insertSheet(SHEET_ORDERS);

    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const trackingCol = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
      for (let i = 0; i < trackingCol.length; i++) {
        const existing = numToStr(trackingCol[i][0]).toUpperCase();
        if (existing === parcelId.toUpperCase()) {
          Logger.log("[saveData] Duplicate skipped: " + parcelId);
          if (videoBase64 && videoBase64 !== "no_video" && videoBase64 !== "video_too_large") {
            _tryUpdateVideoUrl(sheet, i + 2, parcelId, videoBase64, videoMime, videoExt);
          }
          _logSaveAttempt(parcelId, marketplace, "duplicate_skipped", itemsArr.length, "row " + (i + 2));
          return { success: true, note: "duplicate_skipped" };
        }
      }
    }

    let videoUrl = "no_video";
    if (videoBase64 && videoBase64 !== "no_video" && videoBase64 !== "video_too_large") {
      try {
        const decoded = Utilities.base64Decode(videoBase64);
        const blob    = Utilities.newBlob(decoded, videoMime, parcelId + "." + videoExt);
        const folder  = DriveApp.getFolderById(TARGET_FOLDER_ID);
        const file    = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        videoUrl = file.getUrl();
      } catch (videoErr) {
        Logger.log("Video upload error: " + videoErr.message);
        videoUrl = "upload_failed";
      }
    } else if (videoBase64 === "video_too_large") {
      videoUrl = "video_too_large";
    }

    const timestamp = new Date();
    const row = [timestamp, orderId, marketplace, parcelId, videoUrl, remark, itemsArr.length, ...itemsArr.slice(0, 500).map(String)];

    // ✅ เขียนด้วย setValues (กำหนด startRow ชัดเจน) แทน appendRow
    //    → verify ได้แม่นยำกว่าใน lock เดียวกัน
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush(); // ✅ บังคับ commit ทันที — กัน partial write

    // ✅ Verify — อ่านกลับมาเช็คว่า tracking ตรงกับที่เพิ่งเขียน
    const verifyTracking = numToStr(sheet.getRange(startRow, 4).getValue()).toUpperCase();
    if (verifyTracking !== parcelId.toUpperCase()) {
      Logger.log("[saveData] verify FAIL: expected " + parcelId + " got '" + verifyTracking + "' at row " + startRow);
      _logSaveAttempt(parcelId, marketplace, "verify_failed", itemsArr.length,
                      "expected " + parcelId + " got '" + verifyTracking + "' at row " + startRow);
      return { success: false, error: "Write verification failed — please retry" };
    }

    Logger.log("[saveData] บันทึก: " + parcelId + " | row=" + startRow + " | video: " + videoUrl.substring(0, 40));

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

    _logSaveAttempt(parcelId, marketplace, "success", itemsArr.length, "row " + startRow);
    return { success: true, row: startRow };
  } catch (e) {
    Logger.log("Error in saveData: " + e.message);
    _logSaveAttempt(parcelId, marketplace, "exception", itemsArr.length, e.toString());
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
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
  const HANDLERS = ["cleanUpOldOrders", "backupOrdersDaily", "cleanUpOldMarketplaceData"];
  ScriptApp.getProjectTriggers().forEach(t => {
    if (HANDLERS.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

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
  Logger.log("   01:00 น. → backupOrdersDaily (เก็บ " + ORDERS_BACKUP_KEEP_DAYS + " วัน)");
  Logger.log("   02:00 น. → cleanUpOldOrders (เก็บ " + CLEANUP_ORDERS_RETENTION_DAYS + " วัน)");
  Logger.log("   03:00 น. → cleanUpOldMarketplaceData (เก็บ 2 วัน)");
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
