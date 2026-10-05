// embed-worker.js — ตัว AI ที่แปลงข้อความเป็น "เวกเตอร์ความหมาย" สำหรับการค้นตามความหมาย
// ทำงานใน worker ของตัวเอง แยกจากตัวทำดัชนี เพราะแต่ละข้อความใช้เวลาคิดนาน จะได้ไม่ไปขวางการค้นปกติ
// โมเดลคือ paraphrase-multilingual-MiniLM-L12-v2 (รองรับภาษาไทย) ทำงานในเครื่องผู้ใช้ทั้งหมด ข้อความไม่ถูกส่งออกไปไหน
// (เทียบกับ multilingual-e5-small แล้ว จับคู่ความหมายได้พอกัน แต่ตัวนี้ให้คะแนนต่ำชัดเจนเมื่อคำค้นไม่เกี่ยวกับเอกสาร จึงกรองผลมั่วออกได้)

import { env, AutoTokenizer, AutoModel } from "../vendor/transformers/transformers.min.js";

const MODEL = "paraphrase-multilingual-MiniLM-L12-v2";
const MODEL_FILE = "model_quantized.onnx";
const MODEL_BYTES = 118308126;           // ขนาดไฟล์โมเดลทั้งก้อน ใช้แสดงความคืบหน้าตอนโหลด
const MODEL_PARTS = 3;                    // ไฟล์โมเดลถูกหั่นเป็นชิ้น เพราะที่ฝากเว็บรับได้ไม่เกิน 100 MB ต่อไฟล์
const MODEL_CACHE = "file-search-model-" + MODEL;   // เก็บโมเดลที่โหลดแล้วไว้ในเบราว์เซอร์ ครั้งต่อไปไม่ต้องโหลดใหม่
const MAX_TOKENS = 128;                   // โมเดลนี้ถูกฝึกกับข้อความสั้น ๆ  ข้อความที่ยาวกว่านี้ดูแค่ช่วงต้น
const DIMS = 384;

const vendor = (path) => new URL(`../vendor/${path}`, import.meta.url).href;
let report = () => {};                    // ตัวแจ้งความคืบหน้าการโหลดโมเดล

// ประกอบไฟล์โมเดลจากชิ้นย่อย แล้วเก็บทั้งก้อนไว้ในเบราว์เซอร์
// (ไลบรารีขอไฟล์นี้มากกว่าหนึ่งครั้ง จึงจำก้อนที่ประกอบแล้วไว้ ไม่โหลดซ้ำ)
let modelBlob = null;
function modelResponse(url) {
  modelBlob ??= (async () => {
    const cache = await caches.open(MODEL_CACHE).catch(() => null);
    const kept = cache && (await cache.match(url));
    if (kept) return kept.blob();

    const parts = [];
    let loaded = 0;
    const total = MODEL_BYTES;
    for (let i = 0; i < MODEL_PARTS; i++) {
      const res = await fetch(`${url}.part${i}`);
      if (!res.ok) throw new Error(`โหลดโมเดลไม่สำเร็จ (ชิ้นที่ ${i + 1}: ${res.status})`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.length;
        report({ loaded, total });
      }
    }
    const blob = new Blob(parts, { type: "application/octet-stream" });
    if (cache) await cache.put(url, new Response(blob)).catch(() => {});    // เก็บไม่ได้ (พื้นที่เต็ม) ก็ยังใช้ได้ แค่ต้องโหลดใหม่ครั้งหน้า
    return blob;
  })().catch((e) => { modelBlob = null; throw e; });
  return modelBlob.then((blob) => new Response(blob, { headers: { "content-length": String(blob.size) } }));
}

env.allowRemoteModels = false;            // ใช้เฉพาะไฟล์ที่อยู่กับเว็บนี้ ไม่ไปดึงจากที่อื่น
env.allowLocalModels = true;
env.localModelPath = new URL(vendor("models/")).pathname;   // ต้องเป็นเส้นทาง ไม่ใช่ที่อยู่เต็ม ไลบรารีจึงจะนับว่าเป็นไฟล์ของเว็บนี้
env.useBrowserCache = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = vendor("transformers/");
env.backends.onnx.wasm.numThreads = 1;
env.fetch = (url, options) => (String(url).endsWith(MODEL_FILE) ? modelResponse(String(url)) : fetch(url, options));

let ready = null;
function load() {
  ready ??= (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    const model = await AutoModel.from_pretrained(MODEL, { dtype: "q8", device: "wasm" });
    return { tokenizer, model };
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// แปลงข้อความหนึ่งชิ้นเป็นเวกเตอร์ยาว 1 หน่วย (เฉลี่ยทุกคำในข้อความ)
async function embedOne(text) {
  const { tokenizer, model } = await load();
  const inputs = tokenizer([text], { padding: true, truncation: true, max_length: MAX_TOKENS });
  const { last_hidden_state: h } = await model(inputs);
  const [, tokens, dims] = h.dims;
  const out = new Float32Array(dims);
  for (let t = 0; t < tokens; t++) for (let d = 0; d < dims; d++) out[d] += h.data[t * dims + d];
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += out[d] * out[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dims; d++) out[d] /= norm;
  return out;
}

// คำสั่ง: { cmd: "load" } โหลดโมเดล (แจ้งความคืบหน้าระหว่างโหลด)  /  { cmd: "embed", texts } คืนเวกเตอร์เรียงต่อกัน
self.onmessage = async ({ data: { id, cmd, texts } }) => {
  try {
    if (cmd === "load") {
      report = (progress) => self.postMessage({ id, progress });
      await load();
      return self.postMessage({ id, result: true });
    }
    const out = new Float32Array(texts.length * DIMS);
    for (let i = 0; i < texts.length; i++) out.set(await embedOne(texts[i]), i * DIMS);
    self.postMessage({ id, result: out }, [out.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
