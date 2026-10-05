// tags.js — ให้ AI ดูรูปแล้วติดป้ายว่าในภาพมีอะไร เช่น "แมว, ลูกแมว" เก็บเป็นข้อความในดัชนี จึงค้นด้วยช่องค้นปกติได้
// AI (โมเดล CLIP) เทียบรูปกับคลังคำที่เตรียมไว้ล่วงหน้า (vendor/models/clip-vit-base-patch32/labels.json)
// จึงรู้จักเฉพาะสิ่งที่อยู่ในคลังคำ  อยากให้รู้จักคำใหม่ต้องเพิ่มในคลังแล้วคำนวณ labels.bin ใหม่

import { ask } from "./ai.js";

export const TAG_LOC = "ในภาพ (AI)";                                 // ชื่อตำแหน่งที่แสดงในผลค้น
export const TAGGABLE = new Set([".png", ".jpg", ".jpeg", ".bmp"]);  // รูปที่เบราว์เซอร์เปิดได้เอง

// AI ให้คะแนนแต่ละคำเป็น "ส่วนแบ่งความมั่นใจ" (รวมทุกคำในคลัง = 1)
const SURE = 0.18;              // คำอันดับหนึ่งต้องได้อย่างน้อยเท่านี้ ไม่งั้นถือว่า AI ไม่แน่ใจ ไม่ติดป้ายเลย (ดีกว่าติดมั่ว)
const ALSO = 0.08;              // คำรองลงมาที่ได้อย่างน้อยเท่านี้ ติดไปด้วย
const MAX_TAGS = 4;
// รูปที่ OCR อ่านตัวหนังสือได้เยอะ (เอกสารสแกน ภาพหน้าจอ) ไม่ติดป้าย: ค้นจากข้อความได้อยู่แล้ว และ AI ตัวนี้มักเดารูปตัวหนังสือผิด
export const TEXT_IMAGE_CHARS = 80;

// โหลดโมเดลดูรูป (ครั้งแรกดาวน์โหลด ครั้งต่อไปเปิดจากที่เบราว์เซอร์เก็บไว้)
export const loadVision = (onProgress) => ask({ cmd: "loadVision" }, onProgress);

// ดูรูปหนึ่งรูป  คืนข้อความป้าย เช่น "แมว, ลูกแมว · cat, kitten"  หรือ "" ถ้าไม่มีคำไหนเข้ากับรูปพอ
export async function tagImage(blob) {
  const top = await ask({ cmd: "tag", blob });
  if (!top.length || top[0].share < SURE) return "";
  const keep = top.filter((t) => t.share >= ALSO).slice(0, MAX_TAGS);
  return `${keep.map((t) => t.th).join(", ")} · ${keep.map((t) => t.en).join(", ")}`;
}
