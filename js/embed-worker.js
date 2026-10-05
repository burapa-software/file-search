// embed-worker.js — worker ของ AI: (1) แปลงข้อความเป็น "เวกเตอร์ความหมาย" สำหรับการค้นตามความหมาย  (2) ดูรูปแล้วบอกว่าในภาพมีอะไร
// ทำงานใน worker ของตัวเอง แยกจากตัวทำดัชนี เพราะแต่ละงานใช้เวลาคิดนาน จะได้ไม่ไปขวางการค้นปกติ
// โมเดลทำงานในเครื่องผู้ใช้ทั้งหมด ข้อความและรูปไม่ถูกส่งออกไปไหน  แต่ละโมเดลโหลดเมื่อถูกใช้ครั้งแรกเท่านั้น
//   ข้อความ: paraphrase-multilingual-MiniLM-L12-v2 (รองรับภาษาไทย)
//     (เทียบกับ multilingual-e5-small แล้ว จับคู่ความหมายได้พอกัน แต่ตัวนี้ให้คะแนนต่ำชัดเจนเมื่อคำค้นไม่เกี่ยวกับเอกสาร จึงกรองผลมั่วออกได้)
//   รูป: CLIP ViT-B/32 เฉพาะส่วนดูรูป  ส่วนเข้าใจข้อความถูกใช้ล่วงหน้าตอนพัฒนา เพื่อคำนวณเวกเตอร์ของคลังคำ (labels.bin)

import { env, AutoTokenizer, AutoModel, AutoImageProcessor, CLIPVisionModelWithProjection, RawImage } from "../vendor/transformers/transformers.min.js";

const MODEL = "paraphrase-multilingual-MiniLM-L12-v2";
const VISION = "clip-vit-base-patch32";
const MAX_TOKENS = 128;                   // โมเดลข้อความถูกฝึกกับข้อความสั้น ๆ  ข้อความที่ยาวกว่านี้ดูแค่ช่วงต้น
const DIMS = 384;

// ไฟล์โมเดลก้อนใหญ่: โหลดเองเพื่อแสดงความคืบหน้า และเก็บไว้ในเบราว์เซอร์ (ครั้งต่อไปไม่ต้องโหลดใหม่)
//   parts = ไฟล์ถูกหั่นเป็นกี่ชิ้น (ที่ฝากเว็บรับได้ไม่เกิน 100 MB ต่อไฟล์)  0 = ไม่ได้หั่น
const BIG_FILES = [
  { path: `${MODEL}/onnx/model_quantized.onnx`, parts: 3, bytes: 118308126, cmd: "load" },
  { path: `${VISION}/onnx/vision_model_quantized.onnx`, parts: 0, bytes: 89117001, cmd: "loadVision" },
];
const CACHE = "file-search-models-v1";

const vendor = (path) => new URL(`../vendor/${path}`, import.meta.url).href;
const reporters = {};                     // คำสั่งโหลดโมเดล → ตัวแจ้งความคืบหน้าของคำสั่งนั้น (สองโมเดลโหลดพร้อมกันได้ ต้องไม่ปนกัน)

// (ไลบรารีขอไฟล์เดียวกันมากกว่าหนึ่งครั้ง จึงจำก้อนที่โหลดแล้วไว้ ไม่โหลดซ้ำ)
const blobs = new Map();
function bigFile(url, { parts, bytes, cmd }) {
  if (!blobs.has(url)) {
    blobs.set(url, (async () => {
      const cache = await caches.open(CACHE).catch(() => null);
      const kept = cache && (await cache.match(url));
      if (kept) return kept.blob();

      const pieces = [];
      let loaded = 0;
      for (const from of parts ? Array.from({ length: parts }, (_, i) => `${url}.part${i}`) : [url]) {
        const res = await fetch(from);
        if (!res.ok) throw new Error(`โหลดโมเดลไม่สำเร็จ (${res.status})`);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pieces.push(value);
          loaded += value.length;
          reporters[cmd]?.({ loaded, total: bytes });
        }
      }
      const blob = new Blob(pieces, { type: "application/octet-stream" });
      if (cache) await cache.put(url, new Response(blob)).catch(() => {});  // เก็บไม่ได้ (พื้นที่เต็ม) ก็ยังใช้ได้ แค่ต้องโหลดใหม่ครั้งหน้า
      return blob;
    })().catch((e) => { blobs.delete(url); throw e; }));
  }
  return blobs.get(url).then((blob) => new Response(blob, { headers: { "content-length": String(blob.size) } }));
}

env.allowRemoteModels = false;            // ใช้เฉพาะไฟล์ที่อยู่กับเว็บนี้ ไม่ไปดึงจากที่อื่น
env.allowLocalModels = true;
env.localModelPath = new URL(vendor("models/")).pathname;   // ต้องเป็นเส้นทาง ไม่ใช่ที่อยู่เต็ม ไลบรารีจึงจะนับว่าเป็นไฟล์ของเว็บนี้
env.useBrowserCache = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = vendor("transformers/");
env.backends.onnx.wasm.numThreads = 1;
env.fetch = (url, options) => {
  const big = BIG_FILES.find((f) => String(url).endsWith(`/${f.path}`));
  return big ? bigFile(String(url), big) : fetch(url, options);
};

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

// ---------------- ดูรูป ----------------
let vision = null;
function loadVision() {
  vision ??= (async () => {
    const processor = await AutoImageProcessor.from_pretrained(VISION);
    const model = await CLIPVisionModelWithProjection.from_pretrained(VISION, { dtype: "q8", device: "wasm" });
    const { labels, dims } = await (await fetch(vendor(`models/${VISION}/labels.json`))).json();
    const vecs = new Int8Array(await (await fetch(vendor(`models/${VISION}/labels.bin`))).arrayBuffer());
    return { processor, model, labels, dims, vecs };
  })().catch((e) => { vision = null; throw e; });
  return vision;
}

// เทียบรูปกับทุกคำในคลัง  คืน 8 คำที่เข้ากับรูปที่สุด [{ th, en, sim, share }]
//   sim = รูปกับคำเข้ากันแค่ไหน (ค่านี้เกาะกลุ่มกันแคบมาก ใช้เรียงลำดับเท่านั้น)
//   share = ส่วนแบ่งความมั่นใจของคำนี้เมื่อเทียบกับคำอื่นทั้งคลัง (รวมทุกคำ = 1) ใช้ตัดสินว่าจะติดป้ายไหม
async function tag(blob) {
  const { processor, model, labels, dims, vecs } = await loadVision();
  const image = await RawImage.fromBlob(blob);
  if (image.width < 64 || image.height < 64) return [];      // ไอคอน/รูปจิ๋ว
  const { pixel_values } = await processor(image);
  const { image_embeds } = await model({ pixel_values });
  const e = image_embeds.data;
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += e[d] * e[d];
  norm = Math.sqrt(norm) || 1;
  const sims = new Float32Array(labels.length);
  let best = -1;
  for (let i = 0; i < labels.length; i++) {
    let dot = 0;
    for (let d = 0, base = i * dims; d < dims; d++) dot += e[d] * vecs[base + d];
    sims[i] = dot / norm / 127;
    if (sims[i] > best) best = sims[i];
  }
  let sum = 0;
  const weight = Array.from(sims, (s) => Math.exp(100 * (s - best)));   // 100 = ค่าขยายที่โมเดล CLIP ใช้ตอนฝึก
  for (const w of weight) sum += w;
  return labels
    .map((label, i) => ({ th: label.th, en: label.en, sim: sims[i], share: weight[i] / sum }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 8);
}

// คำสั่ง: { cmd: "load" } / { cmd: "loadVision" } โหลดโมเดล (แจ้งความคืบหน้าระหว่างโหลด)
//        { cmd: "embed", texts } คืนเวกเตอร์เรียงต่อกัน   { cmd: "tag", blob } คืนคำที่เข้ากับรูป
self.onmessage = async ({ data: { id, cmd, texts, blob } }) => {
  try {
    if (cmd === "load" || cmd === "loadVision") {
      reporters[cmd] = (progress) => self.postMessage({ id, progress });
      await (cmd === "load" ? load() : loadVision());
      return self.postMessage({ id, result: true });
    }
    if (cmd === "tag") return self.postMessage({ id, result: await tag(blob) });
    const out = new Float32Array(texts.length * DIMS);
    for (let i = 0; i < texts.length; i++) out.set(await embedOne(texts[i]), i * DIMS);
    self.postMessage({ id, result: out }, [out.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
