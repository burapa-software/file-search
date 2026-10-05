// search.js — ค้นหาในดัชนีที่อยู่ในหน่วยความจำ (ไม่มีหน้าจอ)
// ค้นแบบปกติและแบบผ่อนเงื่อนไขใช้กติกาเดียวกับ search_core.py ของเวอร์ชัน Python
// ส่วนการหาคำสะกดใกล้เคียง (fuzzy.js) มีเฉพาะเวอร์ชันเว็บ

import { normalize, terms as splitTerms } from "./normalize.js";
import { FILE_TYPES } from "./types.js";
import { allowance, nearest } from "./fuzzy.js";

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
//   at = เริ่มแสดงจากตำแหน่งนี้เลย (ใช้กับผลค้นตามความหมาย ซึ่งไม่มีคำค้นให้หาในข้อความ)
export function context(rec, chunk, terms, at = null, before = 500, after = 1500) {
  const c = rec.chunks[chunk];
  if (!c) return null;
  if (at !== null) {
    const end = Math.min(c.text.length, at + after);
    return { loc: c.loc, text: c.text.slice(at, end), cutStart: at > 0, cutEnd: end < c.text.length };
  }
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

// หาไฟล์ที่มีคำ "สะกดใกล้เคียง" กับคำค้น (พิมพ์ผิด หรือ OCR อ่านเพี้ยน)
//   ทุกคำค้นต้องเจอในไฟล์ จะตรงตัวหรือใกล้เคียงก็ได้ แต่ต้องมีอย่างน้อยหนึ่งคำที่ไม่ตรงตัว
//   skip = ไฟล์ที่เจอแบบตรงตัวไปแล้ว ไม่ต้องดูซ้ำ
function nearMatches(pool, lows, skip) {
  const allow = lows.map(allowance);
  if (!allow.some(Boolean)) return [];
  const found = [];
  for (const rec of pool) {
    if (skip.has(rec.key)) continue;
    const spots = [];                           // ตำแหน่งที่เจอ { chunk, word } (chunk = -1 คือชื่อไฟล์)
    let errors = 0, all = true;
    for (let t = 0; t < lows.length; t++) {
      const mine = [];
      let best = Infinity;
      const look = (low, chunk) => {
        const hit = nearest(low, lows[t], allow[t]);
        if (!hit || hit.errors > best) return;
        if (hit.errors < best) { best = hit.errors; mine.length = 0; }   // เก็บเฉพาะตำแหน่งที่ใกล้เคียงที่สุดของคำนี้
        mine.push({ chunk, word: low.slice(hit.start, hit.end) });
      };
      rec.low.forEach(look);
      look(rec.nameLow, -1);
      if (best === Infinity) { all = false; break; }
      errors += best;
      spots.push(...mine);
    }
    if (!all || !errors) continue;

    const hits = [];
    const shown = new Set();
    for (const s of spots.sort((a, b) => a.chunk - b.chunk)) {
      if (shown.has(s.chunk)) continue;
      shown.add(s.chunk);
      if (s.chunk < 0) hits.push({ loc: "ชื่อไฟล์", snippet: rec.name });
      else hits.push({ loc: rec.chunks[s.chunk].loc, chunk: s.chunk, snippet: makeSnippet(rec.chunks[s.chunk].text, rec.low[s.chunk], [s.word]) });
    }
    hits.sort((a, b) => (a.chunk ?? Infinity) - (b.chunk ?? Infinity));
    // marks = คำที่เจอจริงในไฟล์ ใช้ใส่แถบสีแทนคำค้น (เพราะสะกดไม่เหมือนคำค้น)
    found.push({ ...result(rec, hits), near: true, errors, marks: [...new Set(spots.map((s) => s.word))] });
  }
  // ไฟล์ที่สะกดต่างน้อยที่สุดขึ้นก่อน
  return found.sort((a, b) => a.errors - b.errors || b.hitCount - a.hitCount || b.mtime - a.mtime);
}

// ค้นหาคำในดัชนี
//   records : ระเบียนไฟล์ทั้งหมด (ผ่าน prepare แล้ว)
//   types   : ชื่อประเภทที่ต้องการ เช่น ["Word", "PDF"]   (ว่าง = ทุกประเภท)
//   folderId: ค้นเฉพาะโฟลเดอร์นี้                         (ว่าง = ทุกโฟลเดอร์)
//   near    : true = หาคำสะกดใกล้เคียงเพิ่มด้วย แม้จะเจอแบบตรงตัวแล้ว
// คืน { results, loose, near, terms, total, nearTotal, canNear }
//   loose = true เมื่อค้นแบบปกติไม่เจอ จึงผ่อนเงื่อนไข: ดูชื่อไฟล์เต็มรวมนามสกุล
//           และยอมให้แต่ละคำอยู่คนละหน้า/สไลด์/ชีต
//   near  = true เมื่อไม่เจอแบบตรงตัวเลย ผลทั้งหมดจึงเป็นคำสะกดใกล้เคียง
//   total = จำนวนไฟล์ที่เจอแบบตรงตัว   nearTotal = จำนวนไฟล์ที่เจอแบบใกล้เคียง (ต่อท้ายใน results)
//   canNear = คำค้นนี้หาคำใกล้เคียงได้ไหม (คำสั้นหรือตัวเลขล้วนหาไม่ได้)
export function search(records, query, { types = null, folderId = null, near = false } = {}) {
  const terms = splitTerms(query);
  if (!terms.length) return { results: [], loose: false, near: false, terms, total: 0, nearTotal: 0, canNear: false };
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
  let loose = false;
  if (!found.length) loose = looseMatches(pool, lows, found);

  // ไม่เจอแบบตรงตัวเลย หรือผู้ใช้ขอให้หาเพิ่ม → หาคำสะกดใกล้เคียง
  const nearList = found.length && !near ? [] : nearMatches(pool, lows, new Set(found.map((r) => r.key)));
  return {
    results: [...ranked(found), ...nearList.slice(0, MAX_FILES)],
    loose, near: !found.length && nearList.length > 0, terms,
    total: found.length, nearTotal: nearList.length, canNear: lows.some(allowance),
  };
}

// แบบผ่อนเงื่อนไข: ไฟล์ที่ "มีครบทุกคำ" โดยแต่ละคำอยู่คนละตำแหน่งได้ หรืออยู่ในชื่อไฟล์เต็มก็ได้
// เติมผลลงใน found  คืน true ถ้าเจอ
function looseMatches(pool, lows, found) {
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
  return found.length > 0;
}
