// search.js — ค้นหาในดัชนีที่อยู่ในหน่วยความจำ (ไม่มีหน้าจอ)
// กติกาเดียวกับ search_core.py ของเวอร์ชัน Python

import { normalize, terms as splitTerms } from "./normalize.js";
import { FILE_TYPES } from "./types.js";

const MAX_FILES = 200;      // แสดงผลไม่เกินกี่ไฟล์
const MAX_HITS = 30;        // ตำแหน่งที่เจอต่อไฟล์ ที่ส่งกลับไปแสดง

// เตรียมระเบียนไฟล์ให้พร้อมค้น: เก็บข้อความตัวพิมพ์เล็กไว้ล่วงหน้า จะได้ไม่ต้องแปลงทุกครั้งที่ค้น
export function prepare(rec) {
  const dot = rec.name.lastIndexOf(".");
  rec.stem = normalize(dot > 0 ? rec.name.slice(0, dot) : rec.name);
  rec.stemLow = rec.stem.toLowerCase();
  rec.nameLow = normalize(rec.name).toLowerCase();
  rec.low = rec.chunks.map((c) => c.text.toLowerCase());
  return rec;
}

// ข้อความช่วงยาวรอบ ๆ คำที่เจอ สำหรับพรีวิวในการ์ด (ยาวกว่า snippet หลายเท่า แต่ไม่ส่งทั้งไฟล์)
//   chunk = ลำดับชิ้นข้อความในไฟล์  คืน { loc, text, cutStart, cutEnd } หรือ null ถ้าไม่มีข้อความ
export function context(rec, chunk, terms, before = 500, after = 1500) {
  const c = rec.chunks[chunk];
  if (!c) return null;
  const low = rec.low[chunk];
  let pos = Infinity;
  for (const t of terms) {
    const i = low.indexOf(t.toLowerCase());
    if (i >= 0 && i < pos) pos = i;
  }
  if (pos === Infinity) pos = 0;
  const start = Math.max(0, pos - before);
  const end = Math.min(c.text.length, pos + after);
  return { loc: c.loc, text: c.text.slice(start, end), cutStart: start > 0, cutEnd: end < c.text.length };
}

// ตัดข้อความรอบ ๆ คำที่เจอครั้งแรก ไม่ต้องแสดงทั้งหน้า
export function makeSnippet(text, low, terms, width = 90) {
  let pos = Infinity;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && i < pos) pos = i;
  }
  if (pos === Infinity) pos = 0;
  const start = Math.max(0, pos - width);
  const end = Math.min(text.length, pos + width * 2);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\n/g, " ") + (end < text.length ? "…" : "");
}

function result(rec, hits) {
  return {
    key: rec.key, folderId: rec.folderId, rel: rec.rel, name: rec.name,
    type: FILE_TYPES[rec.ext] || rec.ext, mtime: rec.mtime,
    hitCount: hits.length, hits: hits.slice(0, MAX_HITS),
  };
}

// ไฟล์ที่เจอหลายจุดขึ้นก่อน ถ้าเท่ากัน ไฟล์ที่แก้ไขล่าสุดขึ้นก่อน
const ranked = (list) => list.sort((a, b) => b.hitCount - a.hitCount || b.mtime - a.mtime).slice(0, MAX_FILES);

// ค้นหาคำในดัชนี
//   records : ระเบียนไฟล์ทั้งหมด (ผ่าน prepare แล้ว)
//   types   : ชื่อประเภทที่ต้องการ เช่น ["Word", "PDF"]   (ว่าง = ทุกประเภท)
//   folderId: ค้นเฉพาะโฟลเดอร์นี้                         (ว่าง = ทุกโฟลเดอร์)
// คืน { results, loose, terms, total }
//   loose = true เมื่อค้นแบบปกติไม่เจอ จึงผ่อนเงื่อนไข: ดูชื่อไฟล์เต็มรวมนามสกุล
//           และยอมให้แต่ละคำอยู่คนละหน้า/สไลด์/ชีต
export function search(records, query, { types = null, folderId = null } = {}) {
  const terms = splitTerms(query);
  if (!terms.length) return { results: [], loose: false, terms, total: 0 };
  const lows = terms.map((t) => t.toLowerCase());
  const wanted = types && types.length ? new Set(types) : null;
  const pool = [];
  for (const rec of records) {
    if (folderId && rec.folderId !== folderId) continue;
    if (wanted && !wanted.has(FILE_TYPES[rec.ext])) continue;
    pool.push(rec);
  }

  // แบบปกติ: ทุกคำต้องอยู่ในตำแหน่งเดียวกัน (หน้า/สไลด์/ชีตเดียวกัน หรือในชื่อไฟล์)
  let found = [];
  for (const rec of pool) {
    const hits = [];
    rec.low.forEach((low, i) => {
      if (lows.every((t) => low.includes(t))) {
        hits.push({ loc: rec.chunks[i].loc, chunk: i, snippet: makeSnippet(rec.chunks[i].text, low, lows) });
      }
    });
    if (lows.every((t) => rec.stemLow.includes(t))) hits.push({ loc: "ชื่อไฟล์", snippet: rec.stem });
    if (hits.length) found.push(result(rec, hits));
  }
  if (found.length) return { results: ranked(found), loose: false, terms, total: found.length };

  // แบบผ่อนเงื่อนไข: ไฟล์ที่ "มีครบทุกคำ" โดยแต่ละคำอยู่คนละตำแหน่งได้ หรืออยู่ในชื่อไฟล์เต็มก็ได้
  for (const rec of pool) {
    const hits = [];
    const shown = new Set();
    let all = true;
    for (const t of lows) {
      let any = false;
      rec.low.forEach((low, i) => {
        if (!low.includes(t)) return;
        any = true;
        const loc = rec.chunks[i].loc;
        if (!shown.has(loc)) { shown.add(loc); hits.push({ loc, chunk: i, snippet: makeSnippet(rec.chunks[i].text, low, [t]) }); }
      });
      if (rec.nameLow.includes(t)) {
        any = true;
        if (!shown.has("ชื่อไฟล์")) { shown.add("ชื่อไฟล์"); hits.push({ loc: "ชื่อไฟล์", snippet: rec.name }); }
      }
      if (!any) { all = false; break; }
    }
    if (all) found.push(result(rec, hits));
  }
  return { results: ranked(found), loose: found.length > 0, terms, total: found.length };
}
