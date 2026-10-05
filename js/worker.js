// worker.js — ทำงานเบื้องหลัง: ไล่อ่านโฟลเดอร์ ทำดัชนี และค้นหา
// แยกจากหน้าเว็บ เพื่อให้หน้าเว็บไม่ค้างระหว่างอ่านไฟล์ใหญ่ ๆ

import { extract, renderPage } from "./extract.js";
import { FILE_TYPES, MAX_SIZE, extOf, readerVersion } from "./types.js";
import { context, prepare, search } from "./search.js";
import { getAll, put, removeMany } from "./db.js";
import { recognize, release } from "./ocr.js";

// โฟลเดอร์ที่ข้าม ไม่ต้องอ่าน
const SKIP_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "node_modules", "__pycache__"]);

const records = new Map();      // key → ระเบียนไฟล์ (ดัชนีทั้งหมดอยู่ในหน่วยความจำ จะได้ค้นเร็ว)
let ocrOn = false;              // ผู้ใช้เปิด OCR ไว้ไหม (หน้าเว็บส่งมาบอก เปลี่ยนได้แม้ระหว่างทำดัชนี)
let loaded = null;

function load() {
  loaded ??= getAll("files").then((rows) => {
    for (const rec of rows) records.set(rec.key, prepare(rec));
  });
  return loaded;
}

function stats() {
  const out = {};
  for (const rec of records.values()) {
    const s = (out[rec.folderId] ??= { total: 0, errors: 0, needsOcr: 0 });
    s.total++;
    if (rec.error) s.errors++;
    if (rec.needsOcr) s.needsOcr++;
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
    // ไฟล์ที่รอ OCR อยู่ จะถูกอ่านใหม่เมื่อเปิด OCR
    if (unchanged && !old.error && !(old.needsOcr && ocrOn)) {
      count.unchanged++;
      continue;
    }

    let error = null, chunks = [], needsOcr = false;
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
          ({ chunks, needsOcr } = await extract(item.name, bytes, ocrOn ? recognize : null));
        } catch (e) {                           // ไฟล์เสีย / ใส่รหัสผ่าน / รูปแบบแปลก
          error = String(e.message || e).slice(0, 300);
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
      error, needsOcr, chunks,
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

  async search({ query, types, folderId }) {
    return search(records.values(), query, { types, folderId });
  },

  // ข้อความช่วงยาวรอบ ๆ คำที่เจอ สำหรับพรีวิวในการ์ด
  async context({ key, chunk, terms }) {
    const rec = records.get(key);
    return rec ? context(rec, chunk, terms) : null;
  },

  // วาดหน้าหนึ่งของ PDF / TIFF เป็นรูป สำหรับพรีวิว
  async renderPage({ file, ext, page }) {
    return renderPage(new Uint8Array(await file.arrayBuffer()), ext, page);
  },
};

// งานที่แก้ไขดัชนีทำทีละงาน ต่อคิวกัน  ส่วนการค้นหาแทรกได้ทันที
let queue = Promise.resolve();
const SERIAL = new Set(["scan", "scanFiles", "removeFolder"]);

self.onmessage = (event) => {
  const { id, cmd, args } = event.data;
  const run = async () => {
    await load();
    const progress = (info) => self.postMessage({ id, progress: info });
    return commands[cmd](args || {}, progress);
  };
  const job = SERIAL.has(cmd) ? (queue = queue.then(run, run)) : run();
  job.then(
    (result) => self.postMessage({ id, result, stats: stats() }),
    (error) => self.postMessage({ id, error: String(error && error.message || error) }),
  );
};
