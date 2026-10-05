// types.js — ค่าคงที่ที่ใช้ร่วมกันทั้งหน้าเว็บและตัวทำดัชนี

// นามสกุลที่รองรับ และชื่อเรียกที่แสดงบนหน้าเว็บ
export const FILE_TYPES = {
  ".txt": "ข้อความ", ".md": "ข้อความ", ".csv": "ข้อความ", ".log": "ข้อความ",
  ".docx": "Word", ".doc": "Word",
  ".xlsx": "Excel", ".xlsm": "Excel", ".xls": "Excel",
  ".pptx": "PowerPoint", ".ppt": "PowerPoint",
  ".pdf": "PDF",
  ".png": "รูปภาพ", ".jpg": "รูปภาพ", ".jpeg": "รูปภาพ",
  ".tif": "รูปภาพ", ".tiff": "รูปภาพ", ".bmp": "รูปภาพ",
};

// รุ่นของตัวอ่านแต่ละนามสกุล  เมื่อเปลี่ยนวิธีอ่านไฟล์ประเภทไหน ให้เพิ่มเลขของนามสกุลนั้น
// ไฟล์ประเภทนั้นจะถูกอ่านใหม่เองในการทำดัชนีรอบถัดไป (นามสกุลที่ไม่ได้ระบุ = รุ่น 1)
export const READER_VERSIONS = { ".pdf": 2 };      // 2 = จดไว้ด้วยว่า PDF ไฟล์ไหนมีหน้าสแกนที่รอ OCR
export const readerVersion = (ext) => READER_VERSIONS[ext] || 1;

export const MAX_SIZE = 100 * 1024 * 1024;       // ข้ามไฟล์ใหญ่เกิน 100 MB
export const OCR_MAX_PDF_PAGES = 200;            // OCR ช้า จึงจำกัดจำนวนหน้าต่อไฟล์ PDF
export const OCR_MAX_SIDE = 3500;                // รูปที่ใหญ่กว่านี้ (พิกเซล) ย่อลงก่อน OCR

export function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}
