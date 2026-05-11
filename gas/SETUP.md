# GAS Backend Setup (v3.1)

## ครั้งแรก — Deploy + ตั้ง API key

1. เปิด https://script.google.com แล้วเข้าโปรเจกต์ Apps Script ที่ผูกกับ Google Sheet ของคุณ
2. ลบโค้ดเก่าออก แล้วก็อปเนื้อหา `Code.gs` ในโฟลเดอร์นี้ลงไปแทน
3. ตั้ง API key (ครั้งเดียว):
   - เปิดไฟล์ `Code.gs` ใน editor
   - หาฟังก์ชัน `setupApiKey()` ที่บรรทัด ~50
   - แทนที่ `"PASTE-NEW-API-KEY-HERE"` ด้วย key เดียวกับใน `index.html` (`GAS_API_KEY`)
   - กดเลือกฟังก์ชัน `setupApiKey` → กด **Run** (เบราว์เซอร์อาจขอ permission ครั้งแรก)
   - ดู Logs → ต้องเห็น `✅ API key ถูกตั้งแล้ว`
   - **ลบ key ออกจากโค้ด** หรือคืนค่าเป็น `"PASTE-NEW-API-KEY-HERE"` แล้ว Save (กัน key ค้างใน editor history)
4. Deploy:
   - กด **Deploy** → **Manage deployments** → ✏️ Edit deployment เดิม
   - **Version** = New version
   - **Execute as** = Me
   - **Who has access** = Anyone
   - กด **Deploy**
   - ถ้า URL ไม่เปลี่ยน → จบ; ถ้าเปลี่ยน → ก็อป URL ใหม่ใส่ `GAS_URL` ใน `index.html`

## วิธีหมุน (rotate) API key เมื่อ leak

1. สร้าง key ใหม่ (Mac):
   ```bash
   openssl rand -hex 32
   ```
2. อัปเดต `GAS_API_KEY` ใน `index.html` → commit → push
3. ใน GAS editor: แก้ `setupApiKey()` ให้ใส่ key ใหม่ → Run → ลบออกจากโค้ด → Save
4. ไม่ต้อง re-deploy

## สิ่งที่ v3.1 เพิ่ม

- ✅ API key check (ต้องส่ง `apiKey` field ใน body ทุก request)
- ✅ Rate limit ต่อ action ต่อนาที (CacheService)
- ✅ จำกัดขนาด video upload (~14MB base64 ≈ raw 10MB)
- ✅ Input validation ทุก action (length cap, type check)
- ✅ Action allowlist
- ✅ Constant-time compare ป้องกัน timing attack
- ✅ ไม่คืน error stack ให้ client เห็น

## ❌ ข้อจำกัดที่ระดับนี้แก้ไม่ได้

- `GAS_API_KEY` อยู่ใน `index.html` (public repo) → ใครเปิด View Source ก็เห็น
  - ป้องกันได้: bot สแกน, ใครที่ได้แค่ URL ของ GAS แต่ไม่รู้จักเว็บ
  - ป้องกันไม่ได้: คนที่ตั้งใจจะดูโค้ดเว็บ
- ถ้าต้องการ proper auth → ใช้ Google OAuth (Level 3)
