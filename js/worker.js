// worker.js — ทำงานเบื้องหลัง: ไล่อ่านโฟลเดอร์ ทำดัชนี และค้นหา
// แยกจากหน้าเว็บ เพื่อให้หน้าเว็บไม่ค้างระหว่างอ่านไฟล์ใหญ่ ๆ

import { extract, renderPage } from "./extract.js";
import { FILE_TYPES, MAX_SIZE, extOf, readerVersion } from "./types.js";
import { context, prepare, search } from "./search.js";
import { getAll, put, removeMany } from "./db.js";
import { recognize, release } from "./ocr.js";
import { embedRecord, loadModel, needsEmbedding, semanticSearch } from "./semantic.js";
import { TAG_LOC, TAGGABLE, TEXT_IMAGE_CHARS, loadVision, tagImage } from "./tags.js";

// โฟลเดอร์ที่ข้าม ไม่ต้องอ่าน
const SKIP_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "node_modules", "__pycache__"]);

const records = new Map();      // key → ระเบียนไฟล์ (ดัชนีทั้งหมดอยู่ในหน่วยความจำ จะได้ค้นเร็ว)
let ocrOn = false;              // ผู้ใช้เปิด OCR ไว้ไหม (หน้าเว็บส่งมาบอก เปลี่ยนได้แม้ระหว่างทำดัชนี)
let semOn = false;              // ผู้ใช้เปิดการค้นตามความหมายไว้ไหม
let tagsOn = false;             // ผู้ใช้เปิดให้ AI ดูรูปไว้ไหม
let serialWaiting = 0;          // งานแก้ไขดัชนีที่รอคิวอยู่ (ให้ AI หยุดพักเมื่อมีงานอื่นรอ)
let loaded = null;

function load() {
  loaded ??= getAll("files").then((rows) => {
    for (const rec of rows) records.set(rec.key, prepare(rec));
  });
  return loaded;
}

// รูปนี้ยังรอให้ AI ดูอยู่ไหม  ระเบียนที่ทำดัชนีไว้ก่อนมีฟีเจอร์นี้ไม่มีค่า needsTags จึงดูจากเนื้อหาแทน:
// เป็นรูป อ่านได้ และมีตัวหนังสือน้อย (รูปที่ตัวหนังสือเยอะไม่ติดป้ายอยู่แล้ว)
const awaitsTags = (rec) => rec.needsTags ??
  (TAGGABLE.has(rec.ext) && !rec.error && rec.chunks.reduce((n, c) => n + c.text.length, 0) < TEXT_IMAGE_CHARS);

function stats() {
  const out = {};
  for (const rec of records.values()) {
    const s = (out[rec.folderId] ??= { total: 0, errors: 0, needsOcr: 0, needsTags: 0 });
    s.total++;
    if (rec.error) s.errors++;
    if (rec.needsOcr) s.needsOcr++;
    if (awaitsTags(rec)) s.needsTags++;
  }
  return out;
}

// เดินทุกโฟลเดอร์ย่อย คืนไฟล์ที่นามสกุลรองรับ
// โฟลเดอร์ที่เปิดไม่ได้จะถูกจดไว้ใน failedDirs เพื่อไม่ให้ไฟล์ในนั้นถูกเข้าใจผิดว่า "ถูกลบไปแล้ว"
async function* walk(dir, prefix, failedDirs) {
  const entries = [];
  try {
    for await (const entry of dir.values()) entries.push(entry);
  } catch (e) {
    failedDirs.push(prefix);
    return;
  }
  for (const entry of entries) {
    if (entry.kind === "directory") {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walk(entry, prefix + entry.name + "/", failedDirs);
    } else if (!entry.name.startsWith("~$") && FILE_TYPES[extOf(entry.name)]) {
      yield { rel: prefix + entry.name, name: entry.name, getFile: () => entry.getFile() };
    }
  }
}

// ทำดัชนีโฟลเดอร์หนึ่ง  items = รายการไฟล์ทั้งหมดในโฟลเดอร์ (จาก walk หรือจากที่ผู้ใช้เลือกแบบสำรอง)
async function index(folderId, items, failedDirs, progress) {
  const seen = new Set();
  const count = { added: 0, updated: 0, unchanged: 0, removed: 0, failed: 0, kept: 0 };
  let lastReport = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = folderId + "/" + item.rel;
    const ext = extOf(item.name);
    const old = records.get(key);
    seen.add(key);
    if (performance.now() - lastReport > 150) {
      lastReport = performance.now();
      progress({ done: i, total: items.length, name: item.name });
    }

    let file;
    try {
      file = await item.getFile();
    } catch (e) {
      count.failed++;                           // เปิดไม่ได้ตอนนี้ (ถูกล็อก / หายไประหว่างทาง) ลองใหม่รอบหน้า
      continue;
    }
    const unchanged = old && old.mtime === file.lastModified && old.size === file.size && old.v === readerVersion(ext);
    // ไฟล์ไม่เปลี่ยนและรอบก่อนอ่านได้ปกติ ไม่ต้องอ่านใหม่ (ไฟล์ที่รอบก่อนอ่านไม่ได้ จะลองใหม่ทุกรอบ)
    // ไฟล์ที่รอ OCR อยู่ จะถูกอ่านใหม่เมื่อเปิด OCR  รูปที่รอให้ AI ดู ก็เช่นกันเมื่อเปิดสวิตช์นั้น
    const textStillGood = unchanged && !old.error && !(old.needsOcr && ocrOn);
    if (textStillGood && !(tagsOn && awaitsTags(old))) {
      count.unchanged++;
      continue;
    }

    let error = null, chunks = [], needsOcr = false, needsTags = false;
    if (file.size > MAX_SIZE) {
      error = "ไฟล์ใหญ่เกินกำหนด";
    } else {
      let bytes;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch (e) {
        if (old) { count.failed++; continue; }  // เคยอ่านได้: เก็บดัชนีเดิมไว้ แล้วลองใหม่รอบหน้า
        error = "เปิดไฟล์ไม่ได้";
      }
      if (bytes) {
        try {
          if (textStillGood) {                  // ข้อความเดิมยังใช้ได้ แค่ยังไม่ได้ให้ AI ดูรูป ไม่ต้อง OCR ซ้ำ
            chunks = old.chunks.filter((c) => c.loc !== TAG_LOC);
            needsOcr = old.needsOcr;
          } else {
            ({ chunks, needsOcr } = await extract(item.name, bytes, ocrOn ? recognize : null));
          }
        } catch (e) {                           // ไฟล์เสีย / ใส่รหัสผ่าน / รูปแบบแปลก
          error = String(e.message || e).slice(0, 300);
        }
        // รูปภาพ: ให้ AI ติดป้ายว่าในภาพมีอะไร เก็บเป็นข้อความอีกชิ้น จะได้ค้นเจอด้วยคำนั้น
        if (!error && TAGGABLE.has(ext) && chunks.reduce((n, c) => n + c.text.length, 0) < TEXT_IMAGE_CHARS) {
          if (!tagsOn) needsTags = true;
          else {
            try {
              const text = await tagImage(new Blob([bytes]));
              if (text) chunks.push({ loc: TAG_LOC, text });
            } catch (e) {
              needsTags = true;                 // AI ใช้ไม่ได้ตอนนี้ (เช่น โหลดโมเดลไม่สำเร็จ) ลองใหม่รอบหน้า
            }
          }
        }
      }
    }
    if (unchanged && error && old.error === error) {   // ยังอ่านไม่ได้ด้วยสาเหตุเดิม ไม่ต้องเขียนซ้ำ
      count.failed++;
      continue;
    }

    const rec = {
      key, folderId, rel: item.rel, name: item.name, ext,
      size: file.size, mtime: file.lastModified, v: readerVersion(ext),
      error, needsOcr, needsTags, chunks,
    };
    await put("files", rec);
    records.set(key, prepare(rec));
    if (error) count.failed++;
    if (old) count.updated++; else count.added++;
  }

  // ไฟล์ที่เคยอยู่ในโฟลเดอร์นี้แต่ตอนนี้หายไปแล้ว → ลบออกจากดัชนี
  // ยกเว้นไฟล์ใต้โฟลเดอร์ที่รอบนี้เปิดไม่ได้: ไม่รู้ว่าหายจริงหรือแค่เข้าไม่ถึง จึงเก็บไว้ก่อน
  const gone = [];
  for (const rec of records.values()) {
    if (rec.folderId !== folderId || seen.has(rec.key)) continue;
    if (failedDirs.some((dir) => rec.rel.startsWith(dir))) count.kept++;
    else gone.push(rec.key);
  }
  await removeMany("files", gone);
  for (const key of gone) records.delete(key);
  count.removed = gone.length;
  await release();                              // คืนหน่วยความจำของตัว OCR
  return { ...count, failedDirs };
}

const commands = {
  async stats() {
    return stats();
  },

  async setOcr({ on }) {
    ocrOn = on;
  },

  // ทำดัชนีจากโฟลเดอร์ที่ผู้ใช้เลือกด้วยปุ่ม "เพิ่มโฟลเดอร์" (อ่านซ้ำได้เรื่อย ๆ)
  async scan({ folderId, handle }, progress) {
    const failedDirs = [];
    const items = [];
    for await (const item of walk(handle, "", failedDirs)) {
      items.push(item);
      if (items.length % 200 === 0) progress({ done: 0, total: 0, listing: items.length });
    }
    return index(folderId, items, failedDirs, progress);
  },

  // ทำดัชนีจากรายการไฟล์ที่ได้จากการเลือกแบบสำรอง (ได้ไฟล์มาครั้งเดียว อ่านซ้ำเองไม่ได้)
  async scanFiles({ folderId, files }, progress) {
    const items = files
      .filter((f) => !f.name.startsWith("~$") && FILE_TYPES[extOf(f.name)] && !f.rel.split("/").some((p) => p.startsWith(".") || SKIP_DIRS.has(p)))
      .map((f) => ({ rel: f.rel, name: f.name, getFile: async () => f.file }));
    return index(folderId, items, [], progress);
  },

  async removeFolder({ folderId }) {
    const keys = [...records.values()].filter((r) => r.folderId === folderId).map((r) => r.key);
    await removeMany("files", keys);
    for (const key of keys) records.delete(key);
  },

  async setTags({ on }) {
    tagsOn = on;
  },

  // โหลดโมเดลดูรูปล่วงหน้า (จะได้แสดงความคืบหน้าการดาวน์โหลดก่อนเริ่มทำดัชนี)
  async loadVision(_, progress) {
    await loadVision(progress);
  },

  async setSemantic({ on }) {
    semOn = on;
  },

  // ให้ AI อ่านไฟล์ที่ยังไม่ได้อ่าน (งานนาน ทำทีละไฟล์ เก็บผลทันที ปิดแท็บแล้วมาทำต่อได้)
  // หยุดเองเมื่อผู้ใช้ปิดสวิตช์ หรือมีงานทำดัชนีรอคิวอยู่  คืน { done, left, stopped }
  async embed(_, progress) {
    if (!semOn) return { done: 0, left: 0, stopped: true };
    await loadModel((model) => progress({ model }));
    const todo = [...records.values()].filter(needsEmbedding);
    let done = 0;
    for (const rec of todo) {
      if (!semOn || serialWaiting > 0) return { done, left: todo.length - done, stopped: true };
      progress({ done, total: todo.length, name: rec.name });
      const sem = await embedRecord(rec);
      done++;
      if (records.get(rec.key) !== rec) continue;         // ไฟล์ถูกเอาออกไประหว่างที่ AI อ่านอยู่
      rec.sem = sem;
      const { stem, stemLow, nameLow, low, ...plain } = rec;   // ไม่เก็บส่วนที่ prepare() สร้างขึ้นเอง
      await put("files", plain);
    }
    return { done, left: 0, stopped: false };
  },

  // ค้นตามความหมาย  skip = ไฟล์ที่การค้นแบบคำเจอไปแล้ว
  async semantic({ query, types, folderId, skip }) {
    if (!semOn) return { results: [] };
    await loadModel();
    return { results: await semanticSearch(records.values(), query, { types, folderId, skip }) };
  },

  async search({ query, types, folderId, near }) {
    return search(records.values(), query, { types, folderId, near });
  },

  // ข้อความช่วงยาวรอบ ๆ คำที่เจอ สำหรับพรีวิวในการ์ด
  async context({ key, chunk, terms, at }) {
    const rec = records.get(key);
    return rec ? context(rec, chunk, terms, at ?? null) : null;
  },

  // วาดหน้าหนึ่งของ PDF / TIFF เป็นรูป สำหรับพรีวิว
  async renderPage({ file, ext, page }) {
    return renderPage(new Uint8Array(await file.arrayBuffer()), ext, page);
  },
};

// งานที่แก้ไขดัชนีทำทีละงาน ต่อคิวกัน  ส่วนการค้นหาแทรกได้ทันที
let queue = Promise.resolve();
const SERIAL = new Set(["scan", "scanFiles", "removeFolder", "embed"]);

self.onmessage = (event) => {
  const { id, cmd, args } = event.data;
  const serial = SERIAL.has(cmd);
  if (serial) serialWaiting++;
  const run = async () => {
    if (serial) serialWaiting--;
    await load();
    const progress = (info) => self.postMessage({ id, progress: info });
    return commands[cmd](args || {}, progress);
  };
  const job = serial ? (queue = queue.then(run, run)) : run();
  job.then(
    (result) => self.postMessage({ id, result, stats: stats() }),
    (error) => self.postMessage({ id, error: String(error && error.message || error) }),
  );
};
