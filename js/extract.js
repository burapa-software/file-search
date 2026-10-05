// extract.js — ดึงข้อความจากไฟล์แต่ละประเภท ทำงานในเบราว์เซอร์ล้วน ๆ ไฟล์ไม่ถูกส่งออกไปไหน
// ไฟล์นี้ไม่มีหน้าจอ — worker.js เป็นคนเรียกใช้

import { unzipSync, strFromU8 } from "../vendor/fflate.js";
import XLSX from "../vendor/xlsx.mjs";
import * as cptable from "../vendor/cpexcel.full.mjs";
import { normalize, joinThaiLines } from "./normalize.js";
import { readDoc, readPpt } from "./legacy.js";
import { OCR_MAX_PDF_PAGES, OCR_MAX_SIDE, extOf } from "./types.js";

XLSX.set_cptable(cptable);     // ให้อ่าน .xls รุ่นเก่าที่เข้ารหัสภาษาไทยแบบ cp874 ได้

// ---------------------------------------------------------------------------
// ไฟล์ข้อความ
// ---------------------------------------------------------------------------
function readText(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-874").decode(bytes);     // ภาษาไทยของ Windows รุ่นเก่า
  }
  // แบ่งทีละ 50 บรรทัด จะได้บอกได้ว่าเจอแถวบรรทัดไหน
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 50) {
    out.push({ loc: `บรรทัด ${i + 1}`, text: lines.slice(i, i + 50).join("\n") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Word / PowerPoint รุ่นใหม่ (.docx, .pptx) = ไฟล์ zip ที่ข้างในเป็น XML
// ---------------------------------------------------------------------------
function unzip(bytes, wanted) {
  try {
    return unzipSync(bytes, { filter: (f) => wanted.test(f.name) });
  } catch (e) {
    throw new Error("ไฟล์เสีย หรือใส่รหัสผ่าน");
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] !== "#") return ENTITIES[e] ?? m;
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

// ดึงข้อความจาก XML ของ Office: เอาเฉพาะตัวหนังสือในแท็ก <ns:t> ขึ้นบรรทัดใหม่ทุกย่อหน้า
// ตารางออกมาเป็นแถวละบรรทัด คั่นช่องด้วย " | "   (ns = "w" สำหรับ Word, "a" สำหรับ PowerPoint)
function xmlText(xml, ns) {
  xml = xml.replace(/<a:fld\b[^>]*type="slidenum"[\s\S]*?<\/a:fld>/g, "");    // ช่องเลขสไลด์อัตโนมัติ ไม่ใช่เนื้อหา
  const lines = [];
  const tables = [];          // ตารางที่กำลังอ่านอยู่ (ซ้อนกันได้): [{row: [...ช่อง], cell: [...ย่อหน้า]}]
  let para = "", inText = false;
  const tag = new RegExp(`<(/?)${ns}:(t|p|tr|tc|br|cr|tab)(?=[\\s/>])[^>]*?(/?)>|([^<]+)`, "g");
  for (const m of xml.matchAll(tag)) {
    const [, closing, name, selfClosing, chars] = m;
    if (chars !== undefined) {
      if (inText) para += decodeXml(chars);
      continue;
    }
    if (name === "t") inText = !closing && !selfClosing;
    else if (name === "tab") para += "\t";
    else if (name === "br" || name === "cr") para += "\n";
    else if (name === "p" && (closing || selfClosing)) {
      const table = tables[tables.length - 1];
      if (table && table.cell) { if (para.trim()) table.cell.push(para); }
      else lines.push(para);
      para = "";
    } else if (name === "tr" && !closing) tables.push({ row: [], cell: null });
    else if (name === "tc" && !closing && tables.length) tables[tables.length - 1].cell = [];
    else if (name === "tc" && closing && tables.length) {
      const table = tables[tables.length - 1];
      table.row.push((table.cell || []).join(" "));
      table.cell = null;
    } else if (name === "tr" && closing && tables.length) {
      const row = tables.pop().row.join(" | ");
      const outer = tables[tables.length - 1];
      if (outer && outer.cell) outer.cell.push(row);
      else lines.push(row);
    }
  }
  if (para) lines.push(para);
  return lines.join("\n");
}

function readDocx(bytes) {
  const files = unzip(bytes, /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/);
  if (!files["word/document.xml"]) throw new Error("ไม่พบเนื้อหา Word ในไฟล์");
  const names = Object.keys(files).sort((a, b) => (a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)));
  return [{ loc: "เอกสาร", text: names.map((n) => xmlText(strFromU8(files[n]), "w")).join("\n") }];
}

function readPptx(bytes) {
  const files = unzip(bytes, /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml|slides\/_rels\/[^/]+\.rels|notesSlides\/[^/]+\.xml)$/);
  const get = (name) => (files[name] ? strFromU8(files[name]) : "");
  const rels = (xml) => {
    const map = {};
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[0]), target = /\bTarget="([^"]+)"/.exec(m[0]), type = /\bType="([^"]+)"/.exec(m[0]);
      if (id && target) map[id[1]] = { target: target[1], type: type ? type[1] : "" };
    }
    return map;
  };
  // ลำดับสไลด์ตามที่นำเสนอจริง อยู่ใน presentation.xml (ชื่อไฟล์ slide1, slide2 ไม่ได้เรียงตามนั้นเสมอ)
  const presRels = rels(get("ppt/_rels/presentation.xml.rels"));
  let order = [...get("ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((m) => presRels[m[1]] && presRels[m[1]].target.replace(/^\/?(ppt\/)?/, "ppt/"))
    .filter((p) => p && files[p]);
  if (!order.length) {
    const num = (p) => parseInt(/(\d+)\.xml$/.exec(p)[1], 10);
    order = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  }
  if (!order.length) throw new Error("ไม่พบสไลด์ในไฟล์");
  return order.map((path, i) => {
    const parts = [xmlText(get(path), "a")];
    const slideRels = rels(get(path.replace("slides/", "slides/_rels/") + ".rels"));
    for (const rel of Object.values(slideRels)) {                 // โน้ตผู้บรรยาย
      if (!rel.type.endsWith("/notesSlide")) continue;
      const notes = "ppt/notesSlides/" + rel.target.split("/").pop();
      if (files[notes]) parts.push(xmlText(get(notes), "a"));
    }
    return { loc: `สไลด์ ${i + 1}`, text: parts.join("\n") };
  });
}

// ---------------------------------------------------------------------------
// Excel (.xlsx, .xlsm, .xls)
// ---------------------------------------------------------------------------
function readExcel(bytes) {
  let wb;
  try {
    wb = XLSX.read(bytes, { type: "array", cellDates: true, dense: true, cellFormula: false, cellHTML: false, cellStyles: false });
  } catch (e) {
    throw new Error(/password|encrypt/i.test(e.message) ? "ไฟล์ใส่รหัสผ่าน" : `อ่านไฟล์ Excel ไม่ได้: ${e.message}`);
  }
  const pad = (n) => String(n).padStart(2, "0");
  const show = (v) => {
    if (v instanceof Date) {
      const time = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
      if (v.getUTCFullYear() < 1900) return time;      // ช่องที่เก็บแต่เวลา เช่น 10:00:00 (Excel นับเป็นวันที่ศูนย์)
      return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${time}`;
    }
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    return String(v);
  };
  const out = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false, UTC: true });
    const lines = [];
    for (const row of rows) {
      const cells = row.filter((v) => v !== null && v !== undefined && v !== "").map(show);
      if (cells.length) lines.push(cells.join(" | "));
    }
    if (lines.length) out.push({ loc: `ชีต ${name}`, text: lines.join("\n") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF — ใช้ MuPDF (ตัวเดียวกับเวอร์ชัน Python) ซึ่งอ่านภาษาไทยได้ครบกว่าตัวอื่น
// โหลดเมื่อเจอ PDF ไฟล์แรกเท่านั้น เพราะไฟล์ใหญ่ (ราว 10 MB)
// ---------------------------------------------------------------------------
let mupdfPromise = null;
const loadMupdf = () => (mupdfPromise ??= import("../vendor/mupdf/mupdf.js"));

// วาดหน้าเอกสารเป็นรูป PNG ขาวดำ สำหรับส่งให้ OCR (ราว 300 จุดต่อนิ้ว แต่ไม่ให้ใหญ่เกินไป)
function pageImage(mupdf, page) {
  const [x0, y0, x1, y1] = page.getBounds();
  const scale = Math.min(300 / 72, OCR_MAX_SIDE / Math.max(x1 - x0, y1 - y0, 1));
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false);
  const png = pixmap.asPNG();
  pixmap.destroy();
  return new Blob([png], { type: "image/png" });
}

async function readPdf(bytes, ocr) {
  const mupdf = await loadMupdf();
  let doc;
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf");
  } catch (e) {
    throw new Error("ไฟล์ PDF เสียหรือเปิดไม่ได้");
  }
  try {
    if (doc.needsPassword()) throw new Error("ไฟล์ใส่รหัสผ่าน");
    const out = [];
    let scanned = 0;
    const pages = doc.countPages();
    for (let i = 0; i < pages; i++) {
      const page = doc.loadPage(i);
      const stext = page.toStructuredText("preserve-whitespace");
      // อ่านทีละบล็อก (ย่อหน้า / ช่องตาราง / หัวข้อ) ต่อบรรทัดไทยเฉพาะภายในบล็อกเดียวกัน
      const blocks = JSON.parse(stext.asJSON()).blocks
        .filter((b) => b.type === "text")
        .map((b) => joinThaiLines(b.lines.map((l) => l.text).join("\n").trim()));
      stext.destroy();
      let text = blocks.join("\n");
      if (text.trim().length < 10) {                 // หน้าที่แทบไม่มีข้อความ = น่าจะเป็นภาพสแกน
        scanned++;
        if (ocr && scanned <= OCR_MAX_PDF_PAGES) text = joinThaiLines(await ocr(pageImage(mupdf, page)));
      }
      page.destroy();
      out.push({ loc: `หน้า ${i + 1}`, text });
    }
    return { chunks: out, needsOcr: scanned > 0 && !ocr };
  } finally {
    doc.destroy();
  }
}

// วาดหน้าหนึ่งของ PDF หรือ TIFF เป็นรูป PNG สี สำหรับพรีวิวบนหน้าเว็บ  page เริ่มนับที่ 1
export async function renderPage(bytes, ext, page, width = 1100) {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(bytes, ext === ".pdf" ? "application/pdf" : "image/tiff");
  try {
    if (doc.needsPassword()) throw new Error("ไฟล์ใส่รหัสผ่าน");
    const p = doc.loadPage(Math.min(Math.max(page, 1), doc.countPages()) - 1);
    const [x0, , x1] = p.getBounds();
    const scale = Math.min(3, width / Math.max(x1 - x0, 1));
    const pixmap = p.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    const png = pixmap.asPNG();
    pixmap.destroy();
    p.destroy();
    return new Blob([png], { type: "image/png" });
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// รูปภาพ — อ่านได้เมื่อเปิด OCR เท่านั้น
// ---------------------------------------------------------------------------
async function readImage(bytes, ocr, ext) {
  if (!ocr) return { chunks: [], needsOcr: true };

  if (ext === ".tif" || ext === ".tiff") {           // เบราว์เซอร์เปิด TIFF เองไม่ได้ ใช้ MuPDF เปิด (มีได้หลายหน้า)
    const mupdf = await loadMupdf();
    let doc;
    try {
      doc = mupdf.Document.openDocument(bytes, "image/tiff");
    } catch (e) {
      throw new Error("ไฟล์รูปเสียหรือไม่รองรับ");
    }
    try {
      const pages = doc.countPages();
      const out = [];
      for (let i = 0; i < pages; i++) {
        const page = doc.loadPage(i);
        const text = joinThaiLines(await ocr(pageImage(mupdf, page)));
        page.destroy();
        out.push({ loc: pages > 1 ? `หน้า ${i + 1}` : "รูปภาพ", text });
      }
      return { chunks: out, needsOcr: false };
    } finally {
      doc.destroy();
    }
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
  } catch (e) {
    throw new Error("ไฟล์รูปเสียหรือไม่รองรับ");
  }
  const { width, height } = bitmap;
  if (width < 100 || height < 30) {                  // ไอคอน/รูปจิ๋ว ไม่มีข้อความให้อ่าน
    bitmap.close();
    return { chunks: [], needsOcr: false };
  }
  // วาดลงผืนผ้าใบก่อน: ย่อรูปถ่ายขนาดใหญ่ลง และได้ PNG ที่ตัว OCR อ่านได้แน่นอน
  const scale = Math.min(1, OCR_MAX_SIDE / Math.max(width, height));
  const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";                            // รูปพื้นโปร่งใสให้เป็นพื้นขาว
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const text = joinThaiLines(await ocr(await canvas.convertToBlob({ type: "image/png" })));
  return { chunks: [{ loc: "รูปภาพ", text }], needsOcr: false };
}

// ---------------------------------------------------------------------------
const READERS = {
  ".txt": readText, ".md": readText, ".csv": readText, ".log": readText,
  ".docx": readDocx,
  ".doc": (b) => [{ loc: "เอกสาร", text: readDoc(b) }],
  ".xlsx": readExcel, ".xlsm": readExcel, ".xls": readExcel,
  ".pptx": readPptx,
  ".ppt": (b) => readPpt(b).map((s) => ({ loc: s.slide ? `สไลด์ ${s.slide}` : "งานนำเสนอ", text: s.text })),
  ".pdf": readPdf,
  ".png": readImage, ".jpg": readImage, ".jpeg": readImage,
  ".tif": readImage, ".tiff": readImage, ".bmp": readImage,
};

// ดึงข้อความจากไฟล์  คืน { chunks: [{loc, text}], needsOcr }
//   ocr      : ฟังก์ชันอ่านตัวหนังสือจากรูป (Blob → ข้อความ)  ไม่ส่งมา = ไม่ใช้ OCR
//   needsOcr : true เมื่อไฟล์มีส่วนที่ต้องใช้ OCR แต่รอบนี้ไม่ได้ใช้ (จะถูกอ่านใหม่เมื่อเปิด OCR)
// ถ้าอ่านไม่ได้ (ไฟล์เสีย / ใส่รหัสผ่าน) จะ throw Error พร้อมสาเหตุ
export async function extract(name, bytes, ocr = null) {
  const ext = extOf(name);
  const reader = READERS[ext];
  if (!reader) return { chunks: [], needsOcr: false };
  const result = await reader(bytes, ocr, ext);
  const chunks = Array.isArray(result) ? result : result.chunks;
  return {
    chunks: chunks.map((c) => ({ loc: c.loc, text: normalize(c.text) })).filter((c) => c.text),
    needsOcr: !Array.isArray(result) && result.needsOcr,
  };
}
