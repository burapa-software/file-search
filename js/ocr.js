// ocr.js — อ่านตัวหนังสือจากรูปภาพ (OCR) ด้วย Tesseract ที่ทำงานในเบราว์เซอร์
// โหลดตัว OCR และข้อมูลภาษา (ไทย + อังกฤษ ราว 9 MB) เมื่อเจอรูปแรกเท่านั้น

import Tesseract from "../vendor/tesseract/tesseract.esm.min.js";

const vendor = (path) => new URL(`../vendor/${path}`, import.meta.url).href;
let engine = null;

// รับรูปเป็น Blob (PNG/JPEG/BMP) คืนข้อความที่อ่านได้
export async function recognize(blob) {
  engine ??= (async () => {
    const worker = await Tesseract.createWorker(["tha", "eng"], 1, {
      workerPath: vendor("tesseract/worker.min.js"),
      corePath: vendor("tesseract/tesseract-core-simd-lstm.wasm.js"),
      langPath: vendor("tessdata"),
      gzip: false,
      cacheMethod: "none",              // ให้เบราว์เซอร์แคชไฟล์ภาษาตามปกติ ไม่ต้องเก็บซ้ำอีกชุด
    });
    // โหมด 4 = มองทั้งหน้าเป็นคอลัมน์เดียว  โหมดอัตโนมัติมักตัดสระบน/วรรณยุกต์ไทยแยกไปเป็นอีกบรรทัด
    await worker.setParameters({ tessedit_pageseg_mode: "4" });
    return worker;
  })();
  let worker;
  try {
    worker = await engine;
  } catch (e) {
    engine = null;                      // โหลดไม่สำเร็จ (เช่น เน็ตหลุด): รอบหน้าลองโหลดใหม่
    throw new Error("โหลดตัว OCR ไม่สำเร็จ");
  }
  const { data } = await worker.recognize(blob);
  return data.text;
}

// คืนหน่วยความจำเมื่อทำดัชนีเสร็จ
export async function release() {
  const pending = engine;
  engine = null;
  if (pending) await pending.then((worker) => worker.terminate(), () => {});
}
