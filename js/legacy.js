// legacy.js — ดึงข้อความจากไฟล์ Office รุ่นเก่า (.doc และ .ppt ของ Office 97–2003)
// ไฟล์รุ่นเก่าเป็นไฟล์ไบนารี โค้ดนี้อ่านโครงสร้างเองโดยตรง (ย้ายมาจาก legacy_office.py)
// ใช้แค่ตัวเปิด "กล่อง" ชั้นนอกของไฟล์ (CFB) ที่มากับไลบรารี SheetJS

import XLSX from "../vendor/xlsx.mjs";

const utf16 = new TextDecoder("utf-16le");
const latin1 = new TextDecoder("iso-8859-1");
// ตัวอักษรช่วง 0x80–0x9F ของ Windows-1252 (เครื่องหมายคำพูดโค้ง ขีดยาว ฯลฯ) แปลงเองเพื่อให้ได้ผลเหมือนกันทุกที่
const CP1252_HIGH = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
const cp1252 = {
  decode: (bytes) => latin1.decode(bytes).replace(/[\x80-\x9f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80]),
};

export function isOle(bytes) {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

function openStreams(bytes) {
  const cfb = XLSX.CFB.read(bytes, { type: "array" });
  return (name) => {
    const entry = cfb.FileIndex.find((e) => e.type === 2 && e.name === name);
    return entry ? new Uint8Array(entry.content) : null;
  };
}

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// ---------------------------------------------------------------------------
// Word (.doc)
// ---------------------------------------------------------------------------
export function readDoc(bytes) {
  if (!isOle(bytes)) throw new Error("ไม่ใช่ไฟล์ Word 97–2003 (อาจเป็น RTF/HTML ที่ตั้งนามสกุลเป็น .doc)");
  const stream = openStreams(bytes);
  const doc = stream("WordDocument");
  if (!doc) throw new Error("ไม่พบเนื้อหา Word ในไฟล์");
  const dv = view(doc);
  const flags = dv.getUint16(0x0a, true);
  if (dv.getUint16(0, true) !== 0xa5ec || dv.getUint16(2, true) < 0x00c1) {
    throw new Error("ไฟล์ Word รุ่นเก่ากว่า 97 ยังไม่รองรับ");
  }
  if (flags & 0x0100) throw new Error("ไฟล์ใส่รหัสผ่าน");
  const table = stream(flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw new Error("โครงสร้างไฟล์ Word ไม่ถูกต้อง");

  // ข้อความใน .doc ถูกแบ่งเป็น "ชิ้น" ตารางชิ้นบอกว่าแต่ละชิ้นอยู่ตรงไหนของไฟล์ และเข้ารหัสแบบไหน
  const fcClx = dv.getUint32(0x01a2, true);
  const lcbClx = dv.getUint32(0x01a6, true);
  const clx = table.subarray(fcClx, fcClx + lcbClx);
  const cv = view(clx);
  let i = 0;
  while (i < clx.length && clx[i] === 1) i += 3 + cv.getUint16(i + 1, true);   // ข้ามส่วนที่ไม่ใช่ตารางชิ้น
  if (i >= clx.length || clx[i] !== 2) throw new Error("โครงสร้างไฟล์ Word ไม่ถูกต้อง");
  const lcb = cv.getUint32(i + 1, true);
  const plc = clx.subarray(i + 5, i + 5 + lcb);
  const pv = view(plc);
  const n = Math.floor((plc.length - 4) / 12);

  const parts = [];
  for (let k = 0; k < n; k++) {
    const count = pv.getUint32(4 * (k + 1), true) - pv.getUint32(4 * k, true);
    const fc = pv.getUint32(4 * (n + 1) + 8 * k + 2, true);
    if (fc & 0x40000000) {                       // ชิ้นแบบ 1 ไบต์ต่อตัวอักษร (อังกฤษล้วน)
      const start = (fc & 0x3fffffff) >>> 1;
      parts.push(cp1252.decode(doc.subarray(start, start + count)));
    } else {                                     // ชิ้นแบบ Unicode (ภาษาไทยอยู่แบบนี้)
      parts.push(utf16.decode(doc.subarray(fc, fc + count * 2)));
    }
  }
  return cleanDocText(parts.join(""));
}

function cleanDocText(text) {
  // ฟิลด์ของ Word (เช่น ลิงก์ เลขหน้า) เก็บเป็น  \x13 คำสั่ง \x14 ผลที่แสดง \x15  เอาเฉพาะ "ผลที่แสดง"
  let out = "";
  const inCode = [];
  for (const ch of text) {
    if (ch === "\x13") inCode.push(true);
    else if (ch === "\x14") { if (inCode.length) inCode[inCode.length - 1] = false; }
    else if (ch === "\x15") inCode.pop();
    else if (!inCode.includes(true)) out += ch;
  }
  return out
    .replace(/\x07\x07/g, "\n")                  // ท้ายแถวของตาราง
    .replace(/\x07/g, " | ")                     // จบช่องตาราง
    .replace(/[\r\x0b\x0c]/g, "\n")              // จบย่อหน้า / ขึ้นบรรทัด / ขึ้นหน้าใหม่
    .replace(/\x1e/g, "-")
    .replace(/[\x01-\x05\x08\x1f]/g, "");        // ตัวแทนรูปภาพ เชิงอรรถ ฯลฯ
}

// ---------------------------------------------------------------------------
// PowerPoint (.ppt)
// ---------------------------------------------------------------------------
// ไฟล์ .ppt คือ "เรคคอร์ด" เรียงต่อกัน แต่ละอันมีหัว 8 ไบต์ (ชนิด + ความยาว) บางชนิดเป็นกล่องที่มีเรคคอร์ดย่อยข้างใน
const USER_EDIT = 0x0ff5, PERSIST_DIR = 0x1772;
const SLIDE_LIST = 0x0ff0, SLIDE_PERSIST = 0x03f3, NOTES_ATOM = 0x03f1;
const TEXT_CHARS = 0x0fa0, TEXT_BYTES = 0x0fa8, CLIENT_TEXTBOX = 0xf00d;

function* records(data, dv, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    const verInst = dv.getUint16(pos, true);
    const type = dv.getUint16(pos + 2, true);
    const length = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (body + length > end) break;
    yield { type, inst: verInst >> 4, isBox: (verInst & 0xf) === 0xf || type === CLIENT_TEXTBOX, body, length };
    pos = body + length;
  }
}

function textOf(data, rec) {
  let text;
  if (rec.type === TEXT_CHARS) text = utf16.decode(data.subarray(rec.body, rec.body + rec.length));
  else if (rec.type === TEXT_BYTES) text = latin1.decode(data.subarray(rec.body, rec.body + rec.length));
  else return null;
  return text.replace(/[\r\x0b]/g, "\n");
}

function walkTexts(data, dv, start, end, out) {
  for (const rec of records(data, dv, start, end)) {
    if (rec.isBox) walkTexts(data, dv, rec.body, rec.body + rec.length, out);
    else {
      const text = textOf(data, rec);
      if (text && text.trim() && !out.includes(text)) out.push(text);
    }
  }
}

// คืน [{slide: เลขสไลด์ หรือ null ถ้าแยกสไลด์ไม่ได้, text}]
export function readPpt(bytes) {
  if (!isOle(bytes)) throw new Error("ไม่ใช่ไฟล์ PowerPoint 97–2003");
  const stream = openStreams(bytes);
  const data = stream("PowerPoint Document");
  if (!data) throw new Error("ไม่พบเนื้อหา PowerPoint ในไฟล์");
  const current = stream("Current User") || new Uint8Array(0);
  if (current.length >= 20 && view(current).getUint32(12, true) === 0xf3d1c4df) throw new Error("ไฟล์ใส่รหัสผ่าน");

  const dv = view(data);
  let slides = [];
  try {
    slides = pptBySlide(data, dv, view(current));
  } catch (e) {
    if (!(e instanceof RangeError || e instanceof TypeError)) throw e;
  }
  if (slides.length) return slides;
  // โครงสร้างไม่ตรงตามที่คาด: กวาดข้อความทั้งไฟล์แทน (ไม่รู้เลขสไลด์ แต่ยังค้นเจอ)
  const texts = [];
  walkTexts(data, dv, 0, data.length, texts);
  return [{ slide: null, text: texts.join("\n") }];
}

function pptBySlide(data, dv, cur) {
  // 1) สารบัญตำแหน่ง: ทุกครั้งที่บันทึกไฟล์ PowerPoint จะต่อท้ายสารบัญชุดใหม่ ชุดใหม่กว่าชนะ
  let edit = cur.getUint32(16, true);
  const where = new Map();
  const visited = new Set();
  let docRef = null;
  while (edit && !visited.has(edit)) {
    visited.add(edit);
    if (dv.getUint16(edit + 2, true) !== USER_EDIT) break;
    const previous = dv.getUint32(edit + 16, true);
    const directory = dv.getUint32(edit + 20, true);
    if (docRef === null) docRef = dv.getUint32(edit + 24, true);
    if (dv.getUint16(directory + 2, true) !== PERSIST_DIR) break;
    let pos = directory + 8;
    const end = pos + dv.getUint32(directory + 4, true);
    while (pos < end) {
      const entry = dv.getUint32(pos, true);
      pos += 4;
      const first = entry & 0xfffff, count = entry >>> 20;
      for (let j = 0; j < count; j++, pos += 4) {
        if (!where.has(first + j)) where.set(first + j, dv.getUint32(pos, true));
      }
    }
    edit = previous;
  }
  const boxAt = (ref) => {
    const offset = where.get(ref);
    if (offset === undefined) throw new RangeError("ไม่พบกล่อง");
    return [offset + 8, offset + 8 + dv.getUint32(offset + 4, true)];
  };

  // 2) รายการสไลด์ตามลำดับที่นำเสนอ (instance 0) และรายการหน้าโน้ต (instance 2)
  const slides = [], notes = [];
  for (const rec of records(data, dv, ...boxAt(docRef))) {
    if (rec.type !== SLIDE_LIST || (rec.inst !== 0 && rec.inst !== 2)) continue;
    const target = rec.inst === 0 ? slides : notes;
    for (const sub of records(data, dv, rec.body, rec.body + rec.length)) {
      if (sub.type === SLIDE_PERSIST) {
        target.push({ ref: dv.getUint32(sub.body, true), id: dv.getUint32(sub.body + 12, true), texts: [] });
      } else if (target.length) {
        const text = textOf(data, sub);
        if (text && text.trim()) target[target.length - 1].texts.push(text);
      }
    }
  }

  // 3) ข้อความในกล่องข้อความ/ตารางของแต่ละสไลด์
  for (const s of slides) if (where.has(s.ref)) walkTexts(data, dv, ...boxAt(s.ref), s.texts);

  // 4) โน้ตผู้บรรยาย: หน้าโน้ตแต่ละหน้าบอกรหัสสไลด์ที่มันสังกัด
  const byId = new Map(slides.map((s) => [s.id, s.texts]));
  for (const note of notes) {
    if (!where.has(note.ref)) continue;
    const [start, end] = boxAt(note.ref);
    walkTexts(data, dv, start, end, note.texts);
    for (const rec of records(data, dv, start, end)) {
      if (rec.type !== NOTES_ATOM) continue;
      const owner = byId.get(dv.getUint32(rec.body, true));
      if (owner) for (const t of note.texts) if (!owner.includes(t)) owner.push(t);
    }
  }
  return slides.map((s, i) => ({ slide: i + 1, text: s.texts.join("\n") }));
}
