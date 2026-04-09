// ============================================================
// icons.js — Lamsang Scanner SVG Icon Library
// ใช้แทน emoji ทุกจุดในแอป
// ============================================================

// --- ฟังก์ชัน helper สร้าง SVG string ---
// sz: ขนาด (default "1em"), va: vertical-align (default "-0.15em"), mr: margin-right
function _svg(path, sz, va, mr) {
  sz = sz || '1em';
  va = va !== undefined ? va : '-0.15em';
  const mrStyle = mr ? `margin-right:${mr};` : '';
  return `<svg viewBox="0 0 20 20" fill="none" style="width:${sz};height:${sz};display:inline-block;vertical-align:${va};${mrStyle}">${path}</svg>`;
}
function _svg10(path, sz, va) {
  sz = sz || '0.7em';
  va = va !== undefined ? va : '0.1em';
  return `<svg viewBox="0 0 10 10" fill="none" style="width:${sz};height:${sz};display:inline-block;vertical-align:${va};">${path}</svg>`;
}
function _svg16(path, sz, va, mr) {
  sz = sz || '0.9em';
  va = va !== undefined ? va : '-0.1em';
  const mrStyle = mr ? `margin-right:${mr};` : '';
  return `<svg viewBox="0 0 16 16" fill="none" style="width:${sz};height:${sz};display:inline-block;vertical-align:${va};${mrStyle}">${path}</svg>`;
}
function _svg12(path, sz, va, mr) {
  sz = sz || '0.8em';
  va = va !== undefined ? va : '-0.08em';
  const mrStyle = mr ? `margin-right:${mr};` : '';
  return `<svg viewBox="0 0 12 12" fill="none" style="width:${sz};height:${sz};display:inline-block;vertical-align:${va};${mrStyle}">${path}</svg>`;
}

// --- Paths ---
const _P = {
  parcel:   `<rect x="2" y="8" width="16" height="11" rx="3" fill="#f4a261"/><path d="M2 8 Q2 5 5 4.5L10 4.5L10 8Z" fill="#e9c46a"/><path d="M10 4.5L15 4.5 Q18 5 18 8L10 8Z" fill="#ffd166"/><path d="M7.5 4.5 Q10 2.5 12.5 4.5" fill="none" stroke="#e07a3a" stroke-width="1.4" stroke-linecap="round"/><rect x="5" y="11" width="2" height="5" rx="1" fill="white" opacity="0.85"/><rect x="8.5" y="11" width="3" height="5" rx="1" fill="white" opacity="0.85"/><rect x="13" y="11" width="2" height="5" rx="1" fill="white" opacity="0.85"/>`,
  parcelSm: `<rect x="2" y="8" width="16" height="11" rx="3" fill="#f4a261"/><path d="M2 8 Q2 5 5 4.5L10 4.5L10 8Z" fill="#e9c46a"/><path d="M10 4.5L15 4.5 Q18 5 18 8L10 8Z" fill="#ffd166"/><rect x="5" y="11" width="2" height="5" rx="1" fill="white" opacity="0.85"/><rect x="9" y="11" width="3" height="5" rx="1" fill="white" opacity="0.85"/><rect x="13" y="11" width="2" height="5" rx="1" fill="white" opacity="0.85"/>`,
  search:   `<circle cx="8.5" cy="8.5" r="6" fill="#a8dadc"/><circle cx="8.5" cy="8.5" r="4.2" fill="#e8f8f8"/><circle cx="8.5" cy="8.5" r="6" fill="none" stroke="#457b9d" stroke-width="1.6"/><circle cx="8.5" cy="8.5" r="4.2" fill="none" stroke="#457b9d" stroke-width="1.1"/><line x1="13" y1="13" x2="18" y2="18" stroke="#457b9d" stroke-width="2.2" stroke-linecap="round"/><line x1="8.5" y1="6" x2="8.5" y2="11" stroke="#457b9d" stroke-width="1.1" stroke-linecap="round"/><line x1="6" y1="8.5" x2="11" y2="8.5" stroke="#457b9d" stroke-width="1.1" stroke-linecap="round"/>`,
  chart:    `<rect x="1" y="3" width="18" height="15" rx="4" fill="#cdb4db"/><rect x="1" y="3" width="18" height="5" rx="4" fill="#d8c3e8"/><rect x="1" y="6" width="18" height="2" fill="#d8c3e8"/><rect x="4" y="13" width="3" height="4" rx="1.5" fill="#f4a261"/><rect x="8.5" y="10" width="3" height="7" rx="1.5" fill="#a8dadc"/><rect x="13" y="8" width="3" height="9" rx="1.5" fill="#b5ead7"/><polyline points="5.5,13 10,10 14.5,8" fill="none" stroke="#9b72cf" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1.5,1.5" opacity="0.9"/><circle cx="5.5" cy="13" r="1.1" fill="#9b72cf"/><circle cx="10" cy="10" r="1.1" fill="#9b72cf"/><circle cx="14.5" cy="8" r="1.1" fill="#9b72cf"/>`,
  upload:   `<circle cx="6.5" cy="12" r="4" fill="#bfdbfe"/><circle cx="11" cy="10.5" r="5" fill="#bfdbfe"/><circle cx="15" cy="12.5" r="3.2" fill="#bfdbfe"/><rect x="2.5" y="12.5" width="15" height="4" fill="#bfdbfe"/><path d="M2.5 14 Q2.5 16.5 4.5 16.5 L15.5 16.5 Q17.5 16.5 17.5 14" fill="none" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round"/><line x1="10" y1="18" x2="10" y2="10" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/><polyline points="6.5,14 10,9.5 13.5,14" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><line x1="7" y1="18" x2="13" y2="18" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="1.5,1.5"/>`,
  bag:      `<rect x="3" y="7" width="14" height="11" rx="3.5" fill="#f4a261"/><path d="M7 7 Q7 3 10 3 Q13 3 13 7" fill="none" stroke="#e07a3a" stroke-width="1.5" stroke-linecap="round"/><rect x="8" y="10" width="4" height="1.5" rx="0.75" fill="white" opacity="0.7"/>`,
  save:     `<rect x="2" y="2" width="16" height="16" rx="4" fill="#b5ead7"/><rect x="5" y="2" width="7" height="6" rx="1" fill="#52b788"/><rect x="7" y="3" width="2" height="3" rx="1" fill="white" opacity="0.7"/><rect x="4" y="10" width="12" height="7" rx="2" fill="#52b788"/><rect x="6" y="12" width="8" height="3" rx="1" fill="#b5ead7" opacity="0.8"/>`,
  refresh:  `<path d="M16.5 10 A6.5 6.5 0 1 1 13 4.2" fill="none" stroke="#a8dadc" stroke-width="2" stroke-linecap="round"/><polyline points="13,1.5 13,4.8 16.3,4.8" fill="none" stroke="#457b9d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  note:     `<rect x="3" y="2" width="14" height="16" rx="3.5" fill="#e9c46a"/><rect x="6" y="6" width="8" height="1.5" rx="0.75" fill="white" opacity="0.8"/><rect x="6" y="9" width="6" height="1.5" rx="0.75" fill="white" opacity="0.8"/><rect x="6" y="12" width="7" height="1.5" rx="0.75" fill="white" opacity="0.8"/>`,
  noteAdd:  `<rect x="3" y="2" width="14" height="16" rx="3.5" fill="#e9c46a"/><rect x="6" y="6" width="8" height="1.5" rx="0.75" fill="white" opacity="0.8"/><rect x="6" y="9" width="6" height="1.5" rx="0.75" fill="white" opacity="0.8"/><rect x="6" y="12" width="7" height="1.5" rx="0.75" fill="white" opacity="0.8"/><circle cx="15" cy="15" r="4" fill="#f4a261"/><line x1="15" y1="12.5" x2="15" y2="17.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/><line x1="12.5" y1="15" x2="17.5" y2="15" stroke="white" stroke-width="1.5" stroke-linecap="round"/>`,
  edit:     `<rect x="2" y="13" width="16" height="2" rx="1" fill="#cdb4db"/><path d="M5 12 L13 4 Q15 2 17 4 Q19 6 17 8 L9 16 Z" fill="#9b72cf"/><path d="M5 12 L13 4" fill="none" stroke="#d8c3e8" stroke-width="1.2"/><rect x="2" y="17" width="16" height="1.5" rx="0.75" fill="#cdb4db" opacity="0.6"/>`,
  editSm:   `<rect x="2" y="2" width="16" height="16" rx="4" fill="#cdb4db"/><path d="M5 12 L13 4 Q15 2 17 4 Q19 6 17 8 L9 16 Z" fill="#9b72cf"/><rect x="2" y="17" width="16" height="1" rx="0.5" fill="#cdb4db" opacity="0.6"/>`,
  trophy:   `<path d="M6 3 H14 V10 Q14 15 10 15 Q6 15 6 10 Z" fill="#e9c46a"/><path d="M3 4 H6 V9 Q3 9 3 6 Z" fill="#ffd166"/><path d="M17 4 H14 V9 Q17 9 17 6 Z" fill="#ffd166"/><rect x="8.5" y="15" width="3" height="2.5" rx="0.5" fill="#d4a82a"/><rect x="6" y="17.5" width="8" height="1.5" rx="0.75" fill="#e9c46a"/><circle cx="10" cy="8" r="2" fill="#fff" opacity="0.4"/>`,
  calendar: `<rect x="2" y="4" width="16" height="14" rx="3.5" fill="#a8dadc"/><rect x="2" y="4" width="16" height="5.5" rx="3.5" fill="#457b9d"/><rect x="2" y="7" width="16" height="2.5" fill="#457b9d"/><circle cx="6.5" cy="2" r="1.5" fill="#cdb4db"/><circle cx="13.5" cy="2" r="1.5" fill="#cdb4db"/><rect x="5.5" y="1" width="1.5" height="3" rx="0.75" fill="#cdb4db"/><rect x="13" y="1" width="1.5" height="3" rx="0.75" fill="#cdb4db"/><rect x="5" y="13" width="2.5" height="2.5" rx="1" fill="white" opacity="0.7"/><rect x="8.75" y="13" width="2.5" height="2.5" rx="1" fill="white" opacity="0.7"/><rect x="12.5" y="13" width="2.5" height="2.5" rx="1" fill="white" opacity="0.7"/>`,
  list:     `<rect x="2" y="2" width="16" height="16" rx="4" fill="#bfdbfe"/><circle cx="5.5" cy="7" r="1.3" fill="#3b82f6"/><rect x="8" y="6.2" width="8" height="1.5" rx="0.75" fill="#3b82f6" opacity="0.7"/><circle cx="5.5" cy="11" r="1.3" fill="#60a5fa"/><rect x="8" y="10.2" width="6" height="1.5" rx="0.75" fill="#60a5fa" opacity="0.7"/><circle cx="5.5" cy="15" r="1.3" fill="#93c5fd"/><rect x="8" y="14.2" width="7" height="1.5" rx="0.75" fill="#93c5fd" opacity="0.7"/>`,
  tip:      `<circle cx="10" cy="10" r="8.5" fill="#ffd166"/><circle cx="10" cy="10" r="8.5" fill="none" stroke="#e9c46a" stroke-width="1.2"/><circle cx="10" cy="7" r="1.3" fill="#9b72cf"/><rect x="9.1" y="10" width="1.8" height="5" rx="0.9" fill="#9b72cf"/>`,
  mailbox:  `<rect x="2" y="7" width="12" height="9" rx="3" fill="#a8dadc"/><path d="M2 10 L8 13.5 L14 10" fill="none" stroke="#457b9d" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><rect x="12" y="3" width="6" height="10" rx="2.5" fill="#e9c46a"/><rect x="14" y="5" width="2" height="1.2" rx="0.6" fill="white" opacity="0.8"/><rect x="14" y="7.5" width="2" height="1.2" rx="0.6" fill="white" opacity="0.8"/>`,
  palette:  `<path d="M10 2 Q17 2 18 8 Q19 13 15 15 Q13 16 12 14 Q11 12 9 13 Q4 14 3 10 Q2 5 7 3 Q8.5 2 10 2Z" fill="#cdb4db"/><circle cx="7" cy="8" r="1.5" fill="#f4a261"/><circle cx="11" cy="5.5" r="1.5" fill="#a8dadc"/><circle cx="14.5" cy="8.5" r="1.5" fill="#b5ead7"/><circle cx="13" cy="13" r="2" fill="#9b72cf"/>`,
  swap:     `<path d="M3 7 H14 L11 4" fill="none" stroke="#f4a261" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 13 H6 L9 16" fill="none" stroke="#a8dadc" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  ribbon:   `<path d="M10 2 L12.5 7.5 L18.5 8 L14 12.5 L15.5 18.5 L10 15.5 L4.5 18.5 L6 12.5 L1.5 8 L7.5 7.5 Z" fill="#ffd166" stroke="#e9c46a" stroke-width="0.8" stroke-linejoin="round"/><circle cx="10" cy="10.5" r="2.5" fill="#fff" opacity="0.4"/>`,
  trash:    `<rect x="3" y="6" width="14" height="11" rx="3" fill="#f4a261"/><path d="M7 6 V4 Q7 2 10 2 Q13 2 13 4 V6" fill="none" stroke="#e07a3a" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="10" x2="8" y2="14" stroke="white" stroke-width="1.4" stroke-linecap="round"/><line x1="12" y1="10" x2="12" y2="14" stroke="white" stroke-width="1.4" stroke-linecap="round"/>`,
  camera:   `<rect x="1" y="5" width="18" height="13" rx="3.5" fill="#a8dadc"/><circle cx="10" cy="11.5" r="3.5" fill="#457b9d"/><circle cx="10" cy="11.5" r="2" fill="#e8f8f8"/><rect x="6" y="3" width="4" height="3" rx="1.5" fill="#cdb4db"/><circle cx="16" cy="7" r="1.5" fill="#e9c46a"/>`,
  doc:      `<rect x="3" y="2" width="14" height="16" rx="3.5" fill="#bfdbfe"/><rect x="6" y="6" width="8" height="1.5" rx="0.75" fill="#3b82f6" opacity="0.7"/><rect x="6" y="9" width="6" height="1.5" rx="0.75" fill="#3b82f6" opacity="0.7"/><rect x="6" y="12" width="7" height="1.5" rx="0.75" fill="#3b82f6" opacity="0.7"/>`,
  store:    `<rect x="1" y="6" width="18" height="12" rx="4" fill="#a8dadc"/><rect x="1" y="6" width="18" height="5" rx="4" fill="#457b9d"/><rect x="1" y="9" width="18" height="2" fill="#457b9d"/><rect x="5" y="2" width="3" height="5" rx="1.5" fill="#cdb4db"/><rect x="12" y="2" width="3" height="5" rx="1.5" fill="#cdb4db"/>`,
  ok20:     `<circle cx="10" cy="10" r="8.5" fill="#b5ead7"/><polyline points="6,10 9,13 14,7" fill="none" stroke="#52b788" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  warn20:   `<path d="M10 2 L18 17 H2 Z" fill="#ffd166" stroke="#e9c46a" stroke-width="1"/><rect x="9.1" y="8" width="1.8" height="5" rx="0.9" fill="#9b72cf"/><circle cx="10" cy="15" r="1.2" fill="#9b72cf"/>`,
  err20:    `<circle cx="10" cy="10" r="8.5" fill="#f4a261"/><line x1="6.5" y1="6.5" x2="13.5" y2="13.5" stroke="white" stroke-width="2" stroke-linecap="round"/><line x1="13.5" y1="6.5" x2="6.5" y2="13.5" stroke="white" stroke-width="2" stroke-linecap="round"/>`,
};

// ============================================================
// SVG_ICONS — ใช้ใน HTML (section-emoji, tab-icon)
// ============================================================
const SVG_ICONS = {
  parcel:   _svg(_P.parcel),
  search:   _svg(_P.search),
  chart:    _svg(_P.chart),
  upload:   _svg(_P.upload),
  bag:      _svg(_P.bag),
  save:     _svg(_P.save),
  refresh:  _svg(_P.refresh),
  note:     _svg(_P.note),
  noteAdd:  _svg(_P.noteAdd),
  edit:     _svg(_P.edit),
  trophy:   _svg(_P.trophy),
  calendar: _svg(_P.calendar),
  list:     _svg(_P.list),
  tip:      _svg(_P.tip),
  mailbox:  _svg(_P.mailbox),
  palette:  _svg(_P.palette),
  swap:     _svg(_P.swap),
  online:   _svg10(`<circle cx="5" cy="5" r="4" fill="#52b788"/><circle cx="5" cy="5" r="2.2" fill="#b5ead7"/>`),
  offline:  _svg10(`<circle cx="5" cy="5" r="4" fill="#e07a3a"/><line x1="3" y1="3" x2="7" y2="7" stroke="white" stroke-width="1.3" stroke-linecap="round"/><line x1="7" y1="3" x2="3" y2="7" stroke="white" stroke-width="1.3" stroke-linecap="round"/>`),
  ribbon:   _svg(_P.ribbon),
  camera:   _svg(_P.camera),
  doc:      _svg(_P.doc),
  store:    _svg(_P.store),
};

// ============================================================
// _S — ใช้ใน setStatus() และ JS innerHTML (มี margin-right)
// ============================================================
const _S = {
  parcel: _svg(_P.parcelSm, '1em', '-0.12em', '3px'),
  edit:   _svg(_P.editSm,   '1em', '-0.12em', '3px'),
  ok:     _svg(_P.ok20,     '1em', '-0.12em', '3px'),
  warn:   _svg(_P.warn20,   '1em', '-0.12em', '3px'),
  err:    _svg(_P.err20,    '1em', '-0.12em', '3px'),
  save:   _svg(_P.save,     '1em', '-0.12em', '3px'),
  bag:    _svg(_P.bag,      '1em', '-0.12em', '3px'),
};

// ============================================================
// _ICO — inline icons สำหรับ Swal popup / dynamic HTML
// ============================================================
const _ICO = {
  ok16:     _svg16(`<circle cx="8" cy="8" r="7" fill="#b5ead7"/><polyline points="4.5,8 7,10.5 11.5,5.5" fill="none" stroke="#52b788" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`, '0.9em', '-0.1em', '3px'),
  warn16:   _svg16(`<path d="M8 1.5 L14.5 13.5 H1.5 Z" fill="#ffd166" stroke="#e9c46a" stroke-width="0.8"/><rect x="7.3" y="6" width="1.4" height="4" rx="0.7" fill="#9b72cf"/><circle cx="8" cy="11.5" r="1" fill="#9b72cf"/>`, '0.9em', '-0.1em', '3px'),
  save16:   _svg16(`<rect x="2" y="2" width="12" height="12" rx="3" fill="#b5ead7"/><rect x="3.5" y="2" width="5" height="4.5" rx="0.8" fill="#52b788"/><rect x="5" y="2.5" width="1.5" height="2.5" rx="0.5" fill="white" opacity="0.7"/><rect x="3" y="7.5" width="10" height="5" rx="1.5" fill="#52b788"/><rect x="4.5" y="9" width="7" height="2.5" rx="1" fill="#b5ead7" opacity="0.8"/>`, '0.9em', '-0.1em', '4px'),
  note16:   _svg16(`<rect x="2" y="1.5" width="12" height="13" rx="2.5" fill="#e9c46a"/><rect x="4.5" y="4.5" width="7" height="1.2" rx="0.6" fill="white" opacity="0.8"/><rect x="4.5" y="7" width="5.5" height="1.2" rx="0.6" fill="white" opacity="0.8"/><rect x="4.5" y="9.5" width="6" height="1.2" rx="0.6" fill="white" opacity="0.8"/>`, '0.9em', '-0.1em', '4px'),
  parcel16: _svg16(`<rect x="1.5" y="6" width="13" height="9" rx="2.5" fill="#f4a261"/><path d="M1.5 6 Q1.5 3.5 4 3L8 3L8 6Z" fill="#e9c46a"/><path d="M8 3L12 3 Q14.5 3.5 14.5 6L8 6Z" fill="#ffd166"/><rect x="3.5" y="8.5" width="1.8" height="4" rx="0.9" fill="white" opacity="0.85"/><rect x="6.5" y="8.5" width="2.5" height="4" rx="0.9" fill="white" opacity="0.85"/><rect x="10.5" y="8.5" width="1.8" height="4" rx="0.9" fill="white" opacity="0.85"/>`, '0.9em', '-0.1em', '3px'),
  bag16:    _svg16(`<rect x="2" y="5.5" width="12" height="9" rx="3" fill="#f4a261"/><path d="M5.5 5.5 Q5.5 2.5 8 2.5 Q10.5 2.5 10.5 5.5" fill="none" stroke="#e07a3a" stroke-width="1.3" stroke-linecap="round"/><rect x="6" y="8" width="4" height="1.3" rx="0.65" fill="white" opacity="0.7"/>`, '0.9em', '-0.1em', '3px'),
  palette16:`<svg viewBox="0 0 20 20" fill="none" style="width:1em;height:1em;display:inline-block;vertical-align:-0.12em"><path d="M10 2 Q17 2 18 8 Q19 13 15 15 Q13 16 12 14 Q11 12 9 13 Q4 14 3 10 Q2 5 7 3 Q8.5 2 10 2Z" fill="#cdb4db"/><circle cx="7" cy="8" r="1.5" fill="#f4a261"/><circle cx="11" cy="5.5" r="1.5" fill="#a8dadc"/><circle cx="14.5" cy="8.5" r="1.5" fill="#b5ead7"/><circle cx="13" cy="13" r="2" fill="#9b72cf"/></svg>`,
  swap16:   `<svg viewBox="0 0 20 20" fill="none" style="width:1em;height:1em;display:inline-block;vertical-align:-0.12em"><path d="M3 7 H14 L11 4" fill="none" stroke="#f4a261" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 13 H6 L9 16" fill="none" stroke="#a8dadc" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  mailbox16:`<svg viewBox="0 0 20 20" fill="none" style="width:1em;height:1em;display:inline-block;vertical-align:-0.12em"><rect x="2" y="7" width="12" height="9" rx="3" fill="#a8dadc"/><path d="M2 10 L8 13.5 L14 10" fill="none" stroke="#457b9d" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><rect x="12" y="3" width="6" height="10" rx="2.5" fill="#e9c46a"/></svg>`,
  edit16:   `<svg viewBox="0 0 20 20" fill="none" style="width:1em;height:1em;display:inline-block;vertical-align:-0.12em"><rect x="2" y="2" width="16" height="16" rx="4" fill="#cdb4db"/><path d="M5 12 L13 4 Q15 2 17 4 Q19 6 17 8 L9 16 Z" fill="#9b72cf"/></svg>`,
  // calendar cell mini icons
  calOk:    _svg12(`<circle cx="6" cy="6" r="5" fill="#b5ead7"/><polyline points="3.5,6 5.2,7.8 8.5,4.2" fill="none" stroke="#52b788" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`, '0.8em', '-0.08em'),
  calWarn:  _svg12(`<circle cx="6" cy="6" r="5" fill="#ffd166"/><rect x="5.3" y="3.5" width="1.4" height="3" rx="0.7" fill="#9b72cf"/><circle cx="6" cy="8.5" r="0.9" fill="#9b72cf"/>`, '0.8em', '-0.08em'),
  calBox:   _svg12(`<rect x="1" y="4.5" width="10" height="7" rx="2" fill="#f4a261"/><path d="M1 4.5 Q1 3 3 2.8L6 2.8L6 4.5Z" fill="#e9c46a"/><path d="M6 2.8L9 2.8 Q11 3 11 4.5L6 4.5Z" fill="#ffd166"/>`, '0.75em', '-0.08em', '1px'),
  calStar:  _svg12(`<path d="M6 1 L7.5 4.5 L11 5 L8.5 7.5 L9.2 11 L6 9.3 L2.8 11 L3.5 7.5 L1 5 L4.5 4.5 Z" fill="#ffd166" stroke="#e9c46a" stroke-width="0.5" stroke-linejoin="round"/>`, '0.75em', '-0.08em', '1px'),
  dotGreen: _svg10(`<circle cx="5" cy="5" r="4" fill="#52b788"/>`, '0.7em', '0.05em'),
  dotYellow:_svg10(`<circle cx="5" cy="5" r="4" fill="#e9c46a"/>`, '0.7em', '0.05em'),
  dotGray:  `<svg viewBox="0 0 10 10" fill="none" style="width:0.7em;height:0.7em;display:inline-block;vertical-align:0.05em;"><circle cx="5" cy="5" r="4" fill="var(--border2)"/></svg>`,
};

// ============================================================
// spawnTabEmoji SVG map — ใช้ใน spawnTabEmoji()
// ============================================================
const _TAB_SVG = {
  scan:   `<svg viewBox="0 0 20 20" fill="none">${_P.parcel}</svg>`,
  search: `<svg viewBox="0 0 20 20" fill="none">${_P.search}</svg>`,
  dash:   `<svg viewBox="0 0 20 20" fill="none">${_P.chart}</svg>`,
  upload: `<svg viewBox="0 0 20 20" fill="none">${_P.upload}</svg>`,
};

// ============================================================
// Remark reasons — ใช้ใน showRemarkPopup() และ showManualFinishConfirm()
// ============================================================
const REMARK_REASONS = [
  { ico: SVG_ICONS.parcel,  label: 'สินค้าหมด' },
  { ico: SVG_ICONS.palette, label: 'ลูกค้าแจ้งเปลี่ยนสี' },
  { ico: SVG_ICONS.swap,    label: 'ลูกค้าแจ้งเปลี่ยนรุ่น' },
  { ico: SVG_ICONS.mailbox, label: 'ใช้พัสดุเดิม' },
  { ico: SVG_ICONS.edit,    label: 'อื่นๆ' },
];
