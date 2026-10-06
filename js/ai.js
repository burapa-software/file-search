// ai.js — ช่องทางติดต่อกับ worker ของ AI (embed-worker.js) ใช้ร่วมกันทั้งการค้นตามความหมายและการดูรูป
// worker ถูกสร้างเมื่อมีการใช้ครั้งแรกเท่านั้น คนที่ไม่เปิดสวิตช์ AI จึงไม่ต้องโหลดอะไรเพิ่ม

let ai = null, seq = 0;
const pending = new Map();

// ส่งคำสั่งให้ AI  onProgress รับความคืบหน้าระหว่างโหลดโมเดล
export function ask(message, onProgress) {
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
      for (const job of pending.values()) job.reject(new Error("บูรพาเริ่มทำงานไม่ได้"));
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
