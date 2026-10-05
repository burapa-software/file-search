// dupes.js — หาไฟล์ที่ซ้ำกันหรือคล้ายกัน จากข้อความที่ทำดัชนีไว้แล้ว (ไม่มีหน้าจอ ไม่ต้องอ่านไฟล์ใหม่ ไม่ใช้ AI)
//   ซ้ำ   = ข้อความเหมือนกันทุกตัวอักษร (ไม่นับช่องว่างและตัวพิมพ์เล็ก/ใหญ่) แม้ชื่อไฟล์หรือชนิดไฟล์ต่างกัน
//   คล้าย = ข้อความส่วนใหญ่เหมือนกัน เช่น เอกสารเดียวกันที่แก้ไปบางจุด หรือ Word กับ PDF ของเรื่องเดียวกัน
// วิธีเทียบ "คล้าย": หั่นข้อความเป็นช่วงสั้น ๆ ซ้อนกัน (ช่วงละ 5 ตัวอักษร) แล้วดูว่าสองไฟล์มีช่วงที่เหมือนกันกี่เปอร์เซ็นต์
// เพื่อให้เร็ว แต่ละไฟล์เก็บไว้แค่ "ลายนิ้วมือ" คือช่วงตัวอย่าง 128 ช่วง (เลือกแบบเดียวกันทุกไฟล์) แล้วเทียบกันจากลายนิ้วมือ

import { FILE_TYPES } from "./types.js";
import { TAG_LOC } from "./tags.js";

const GRAM = 5;                 // ความยาวของแต่ละช่วง (ตัวอักษร)
const K = 128;                  // จำนวนช่วงตัวอย่างในลายนิ้วมือ
const SIMILAR = 0.85;           // เหมือนกันอย่างน้อยเท่านี้จึงนับว่า "คล้าย" (ตั้งสูงไว้ เอกสารคนละฉบับที่ใช้แม่แบบเดียวกันจะได้ไม่ติดมาง่าย ๆ)
const MIN_EXACT = 40;           // ข้อความสั้นกว่านี้ไม่เทียบเลย (ไฟล์แทบว่างจะซ้ำกันมั่วไปหมด)
const MIN_SIMILAR = 200;        // ข้อความสั้นกว่านี้เทียบแค่ "ซ้ำ" ไม่เทียบ "คล้าย"
const SAMPLE_ABOVE = 4096;      // ไฟล์ที่มีช่วงมากกว่านี้ พิจารณาเฉพาะช่วงที่ค่าแฮชต่ำ (ราว 1 ใน 16) จะได้ไม่ต้องเรียงทั้งหมด
const SAMPLE_LIMIT = 0x10000000;
const MAX_SHARED = 400;         // ช่วงที่โผล่ในไฟล์มากกว่านี้คือข้อความสำเร็จรูป (หัวกระดาษ ฯลฯ) ไม่ใช้หาคู่
const MAX_NEIGHBORS = 20;       // ไฟล์ซ้ำ/คล้ายที่ส่งกลับต่อหนึ่งไฟล์
const MAX_GROUPS = 100;         // กลุ่มที่ส่งกลับในหน้ารวม

function hash(text, from, to, seed) {
  let h = seed;
  for (let i = from; i < to; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);    // เกลี่ยบิตให้กระจาย ค่าต่ำสุดจะได้เป็นตัวอย่างที่ไม่เอียง
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// ลายนิ้วมือของไฟล์หนึ่ง  คืน { id, vals, full } หรือ null ถ้าข้อความสั้นเกินไป
//   id   = รหัสของข้อความทั้งก้อน (สองไฟล์ id เท่ากัน = ข้อความเหมือนกันทุกตัวอักษร)
//   vals = ค่าแฮชของช่วงตัวอย่าง เรียงจากน้อยไปมาก (null ถ้าสั้นเกินจะเทียบ "คล้าย")
//   full = vals คือทุกช่วงของไฟล์ ไม่ได้ตัดให้เหลือ K
const prints = new WeakMap();   // จำไว้ต่อระเบียน  ระเบียนที่ถูกทำดัชนีใหม่เป็นวัตถุใหม่ จึงถูกคิดใหม่เอง
function fingerprint(rec) {
  if (prints.has(rec)) return prints.get(rec);
  let text = "";
  rec.chunks.forEach((c, i) => { if (c.loc !== TAG_LOC) text += rec.low[i]; });   // ไม่นับป้ายที่ AI ติดให้รูป
  text = text.replace(/\s+/g, "");
  let print = null;
  if (text.length >= MIN_EXACT) {
    print = { id: `${text.length}:${hash(text, 0, text.length, 2166136261)}:${hash(text, 0, text.length, 84696351)}`, vals: null, full: false };
    if (text.length >= MIN_SIMILAR) {
      const count = text.length - GRAM + 1;
      const sample = count > SAMPLE_ABOVE;
      const all = [];
      for (let i = 0; i < count; i++) {
        const h = hash(text, i, i + GRAM, 2166136261);
        if (!sample || h < SAMPLE_LIMIT) all.push(h);
      }
      const sorted = Uint32Array.from(all).sort();
      let n = 0;
      for (let i = 0; i < sorted.length && n < K; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[n++] = sorted[i];
      print.vals = sorted.slice(0, n);
      print.full = !sample && n < K;
    }
  }
  prints.set(rec, print);
  return print;
}

// สัดส่วนช่วงที่เหมือนกันของสองไฟล์ (0–1) ประมาณจากลายนิ้วมือ
function similarity(a, b) {
  // ช่วงตัวอย่างของไฟล์ที่ถูกตัดให้เหลือ K รู้แค่ถึงค่าสูงสุดที่เก็บไว้ จึงเทียบได้ถึงค่านั้นเท่านั้น
  const limit = Math.min(a.full ? Infinity : a.vals[a.vals.length - 1], b.full ? Infinity : b.vals[b.vals.length - 1]);
  let i = 0, j = 0, seen = 0, both = 0;
  while (seen < K && (i < a.vals.length || j < b.vals.length)) {
    const x = i < a.vals.length ? a.vals[i] : Infinity, y = j < b.vals.length ? b.vals[j] : Infinity;
    if (Math.min(x, y) > limit) break;
    if (x === y) { both++; i++; j++; } else if (x < y) i++; else j++;
    seen++;
  }
  return seen ? both / seen : 0;
}

const info = (rec) => ({
  key: rec.key, folderId: rec.folderId, rel: rec.rel, name: rec.name,
  type: FILE_TYPES[rec.ext] || rec.ext, mtime: rec.mtime, size: rec.size,
});

// เทียบทุกไฟล์ในดัชนี  คืน { neighbors, groups, totalGroups, totalFiles }
//   neighbors : Map(key → [{ ...ข้อมูลไฟล์, exact, sim }])  ไฟล์ที่ซ้ำ/คล้ายกับไฟล์นั้น (ซ้ำก่อน แล้วเรียงจากคล้ายมาก)
//   groups    : [{ exact, sim, files }]  ไฟล์ที่โยงถึงกัน จัดเป็นกลุ่ม (exact = ทั้งกลุ่มซ้ำกันหมด, sim = คู่ที่คล้ายน้อยสุดในกลุ่ม)
export function findDuplicates(records) {
  const recs = [], fps = [];
  for (const rec of records) {
    if (rec.error) continue;
    const print = fingerprint(rec);
    if (print) { recs.push(rec); fps.push(print); }
  }
  const N = recs.length;
  const edges = new Map();                        // a * N + b (a < b) → { exact, sim }

  // ซ้ำ: id เดียวกัน
  const byId = new Map();
  fps.forEach((p, i) => { if (!byId.has(p.id)) byId.set(p.id, []); byId.get(p.id).push(i); });
  for (const list of byId.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) edges.set(list[x] * N + list[y], { exact: true, sim: 1 });
  }

  // คล้าย: หาคู่ที่มีช่วงตัวอย่างตรงกันหลายช่วงก่อน แล้วค่อยเทียบละเอียดเฉพาะคู่นั้น
  const byVal = new Map();
  fps.forEach((p, i) => { if (p.vals) for (const v of p.vals) { if (!byVal.has(v)) byVal.set(v, []); byVal.get(v).push(i); } });
  const shared = new Map();
  for (const list of byVal.values()) {
    if (list.length < 2 || list.length > MAX_SHARED) continue;
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const key = list[x] * N + list[y];
      shared.set(key, (shared.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of shared) {
    if (edges.has(key)) continue;
    const a = Math.floor(key / N), b = key % N;
    if (count < 0.3 * Math.min(fps[a].vals.length, fps[b].vals.length)) continue;
    const sim = similarity(fps[a], fps[b]);
    if (sim >= SIMILAR) edges.set(key, { exact: false, sim });
  }

  // รายการเพื่อนบ้านของแต่ละไฟล์ และจัดกลุ่มไฟล์ที่โยงถึงกัน
  const near = Array.from({ length: N }, () => []);
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const [key, edge] of edges) {
    const a = Math.floor(key / N), b = key % N;
    near[a].push({ other: b, ...edge });
    near[b].push({ other: a, ...edge });
    parent[find(a)] = find(b);
  }
  const neighbors = new Map();
  const members = new Map();
  for (let i = 0; i < N; i++) {
    if (!near[i].length) continue;
    near[i].sort((x, y) => y.exact - x.exact || y.sim - x.sim || recs[y.other].mtime - recs[x.other].mtime);
    neighbors.set(recs[i].key, near[i].slice(0, MAX_NEIGHBORS).map((n) => ({ ...info(recs[n.other]), exact: n.exact, sim: n.sim })));
    const root = find(i);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(i);
  }
  const groups = [...members.values()].map((list) => ({
    exact: list.every((i) => fps[i].id === fps[list[0]].id),
    sim: Math.min(...list.flatMap((i) => near[i].map((n) => n.sim))),
    files: list.map((i) => info(recs[i])).sort((a, b) => b.mtime - a.mtime),
  })).sort((a, b) => b.files.length - a.files.length || b.exact - a.exact || b.sim - a.sim);

  return {
    neighbors,
    groups: groups.slice(0, MAX_GROUPS),
    totalGroups: groups.length,
    totalFiles: groups.reduce((sum, g) => sum + g.files.length, 0),
  };
}
