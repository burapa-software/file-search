// semantic.js — ค้นตามความหมาย: หาไฟล์ที่ "พูดเรื่องเดียวกับคำค้น" แม้ใช้คำไม่เหมือนกัน
// เช่น ค้น "ค่าเช่าออฟฟิศ" แล้วเจอ "สัญญาเช่าอาคารสำนักงาน"
// วิธีทำ: ให้ AI แปลงข้อความแต่ละตอนของเอกสารเป็นเวกเตอร์ เก็บไว้กับดัชนี ตอนค้นก็แปลงคำค้นแล้วเทียบว่าใกล้ตอนไหนที่สุด
// ตัว AI อยู่ใน embed-worker.js  ไฟล์นี้ดูแลการแบ่งตอน การเก็บเวกเตอร์ และการเทียบ

import { FILE_TYPES, MAX_PASSAGES, PASSAGE_CHARS, SEMANTIC_DIMS as DIMS, SEMANTIC_VERSION } from "./types.js";

const MIN_SCORE = 0.35;         // ใกล้เคียงน้อยกว่านี้ถือว่าไม่เกี่ยว (0 = ไม่เกี่ยวเลย, 1 = ความหมายเดียวกัน)
const MAX_FILES = 5;            // แสดงไม่เกินกี่ไฟล์
// ข้อความสั้น ๆ อย่างชื่อไฟล์ได้คะแนนสูงเกินจริงกับคำค้นแทบทุกคำ จึงหักคะแนนลง และไม่ใช้ชื่อไฟล์ที่สั้นมาก
const NAME_WEIGHT = 0.75;
const NAME_MIN_LETTERS = 8;
const MAX_HITS = 2;             // ตอนที่ใกล้เคียงที่สุดต่อไฟล์ ที่ส่งกลับไปแสดง
const BATCH = 4;                // ส่งให้ AI ครั้งละกี่ตอน (น้อย ๆ คำค้นของผู้ใช้จะได้แทรกคิวได้เร็ว)

// ---------------- ติดต่อกับตัว AI ----------------
let ai = null, seq = 0;
const pending = new Map();

function ask(message, onProgress) {
  if (!ai) {
    ai = new Worker(new URL("./embed-worker.js", import.meta.url), { type: "module" });
    ai.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      if (data.progress) return job.onProgress && job.onProgress(data.progress);
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
    ai.onerror = () => {
      for (const job of pending.values()) job.reject(new Error("ตัว AI เริ่มทำงานไม่ได้"));
      pending.clear();
      ai = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    ai.postMessage({ id, ...message });
  });
}

// โหลดโมเดล (ครั้งแรกดาวน์โหลด ครั้งต่อไปเปิดจากที่เบราว์เซอร์เก็บไว้)  onProgress({ loaded, total }) ระหว่างดาวน์โหลด
export const loadModel = (onProgress) => ask({ cmd: "load" }, onProgress);
const embed = (texts) => ask({ cmd: "embed", texts });

// ---------------- แบ่งเอกสารเป็นตอน ----------------
const letters = (text) => (text.match(/\p{L}/gu) || []).length;

// แบ่งข้อความเป็นตอนสั้น ๆ ตัดตรงช่องว่างหรือขึ้นบรรทัดใหม่ถ้าทำได้  คืน [ตำแหน่งเริ่ม, ความยาว]
function split(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + PASSAGE_CHARS);
    if (end < text.length) {
      const cut = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
      if (cut > start + PASSAGE_CHARS / 2) end = cut;
    }
    if (letters(text.slice(start, end)) >= 12) out.push([start, end - start]);    // ตอนที่แทบไม่มีตัวหนังสือ (ตัวเลขล้วน) ไม่ต้องอ่าน
    start = end;
  }
  return out;
}

// ตอนที่จะให้ AI อ่านของไฟล์หนึ่ง: ชื่อไฟล์ + ตอนต้นของทุกหน้า/สไลด์/ชีตก่อน แล้วค่อยตอนถัด ๆ ไป จนครบโควตา
// คืน [{ chunk, pos, len }]  (chunk = -1 คือชื่อไฟล์)
function passagesOf(rec) {
  const out = letters(rec.stem) >= NAME_MIN_LETTERS ? [{ chunk: -1, pos: 0, len: rec.stem.length }] : [];
  const perChunk = rec.chunks.map((c) => split(c.text));
  for (let round = 0; out.length < MAX_PASSAGES; round++) {
    let any = false;
    for (let i = 0; i < perChunk.length && out.length < MAX_PASSAGES; i++) {
      if (round >= perChunk[i].length) continue;
      any = true;
      out.push({ chunk: i, pos: perChunk[i][round][0], len: perChunk[i][round][1] });
    }
    if (!any) break;
  }
  return out;
}

const textOf = (rec, p) => (p.chunk < 0 ? rec.stem : rec.chunks[p.chunk].text.slice(p.pos, p.pos + p.len));

// ไฟล์นี้ยังต้องให้ AI อ่านไหม
export const needsEmbedding = (rec) => !rec.error && (!rec.sem || rec.sem.v !== SEMANTIC_VERSION);

// ให้ AI อ่านไฟล์หนึ่ง  คืนข้อมูลที่จะเก็บไว้กับระเบียนไฟล์: { v, at: [[chunk, pos, len], ...], vecs }
// vecs เก็บเป็นเลข -127..127 (แทนทศนิยม) เล็กลง 4 เท่า ความแม่นแทบไม่ต่าง
export async function embedRecord(rec) {
  const passages = passagesOf(rec);
  const vecs = new Int8Array(passages.length * DIMS);
  for (let i = 0; i < passages.length; i += BATCH) {
    const part = passages.slice(i, i + BATCH);
    const out = await embed(part.map((p) => textOf(rec, p)));
    for (let k = 0; k < out.length; k++) vecs[i * DIMS + k] = Math.max(-127, Math.min(127, Math.round(out[k] * 127)));
  }
  return { v: SEMANTIC_VERSION, at: passages.map((p) => [p.chunk, p.pos, p.len]), vecs };
}

// ---------------- ค้น ----------------
// หาไฟล์ที่ความหมายใกล้คำค้นที่สุด  skip = ไฟล์ที่เจอด้วยการค้นแบบคำไปแล้ว ไม่ต้องแสดงซ้ำ
// คืน [{ ...ผลค้นแบบเดียวกับ search.js, sem: true, score, marks: [] }] เรียงจากใกล้ที่สุด
export async function semanticSearch(records, query, { types = null, folderId = null, skip = [] } = {}) {
  if (letters(query) < 2) return [];
  const q = await embed([query.trim()]);
  const wanted = types && types.length ? new Set(types) : null;
  const skipped = new Set(skip);
  const found = [];
  for (const rec of records) {
    if (!rec.sem || rec.sem.v !== SEMANTIC_VERSION || skipped.has(rec.key)) continue;
    if (folderId && rec.folderId !== folderId) continue;
    if (wanted && !wanted.has(FILE_TYPES[rec.ext])) continue;
    const { at, vecs } = rec.sem;
    const close = [];
    for (let p = 0; p < at.length; p++) {
      let dot = 0;
      for (let k = 0, base = p * DIMS; k < DIMS; k++) dot += q[k] * vecs[base + k];
      const score = (dot / 127) * (at[p][0] < 0 ? NAME_WEIGHT : 1);
      if (score >= MIN_SCORE) close.push({ p, score });
    }
    if (!close.length) continue;
    close.sort((a, b) => b.score - a.score);
    const hits = close.slice(0, MAX_HITS).map(({ p }) => {
      const [chunk, pos, len] = at[p];
      if (chunk < 0) return { loc: "ชื่อไฟล์", snippet: rec.name };
      const c = rec.chunks[chunk];
      const text = c.text.slice(pos, pos + len).replace(/\n/g, " ").trim();
      return { loc: c.loc, chunk, pos, snippet: (pos > 0 ? "…" : "") + text + (pos + len < c.text.length ? "…" : "") };
    });
    found.push({
      key: rec.key, folderId: rec.folderId, rel: rec.rel, name: rec.name,
      type: FILE_TYPES[rec.ext] || rec.ext, mtime: rec.mtime,
      hitCount: close.length, hits, sem: true, score: close[0].score, marks: [],
    });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, MAX_FILES);
}
