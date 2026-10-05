// app.js — หน้าเว็บ: จัดการรายการโฟลเดอร์ ช่องค้นหา และการแสดงผล
// งานหนัก (อ่านไฟล์ ทำดัชนี ค้นหา) อยู่ใน worker.js

import { getAll, put, remove } from "./db.js";
import { FILE_TYPES } from "./types.js";

const PAGE_SIZE = 20;           // แสดงผลครั้งละกี่ไฟล์
const VIEWABLE = new Set([".pdf", ".txt", ".md", ".csv", ".log", ".png", ".jpg", ".jpeg", ".bmp"]);   // เปิดดูในแท็บใหม่ได้เลย

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const num = (n) => n.toLocaleString("en-US");

// ---------------- ติดต่อกับ worker ----------------
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const pending = new Map();
let seq = 0;
let stats = {};                 // โฟลเดอร์ → { total, errors, needsOcr }

function call(cmd, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, cmd, args });
  });
}
worker.onmessage = ({ data }) => {
  const job = pending.get(data.id);
  if (!job) return;
  if (data.progress) return job.onProgress && job.onProgress(data.progress);
  pending.delete(data.id);
  if (data.stats) stats = data.stats;
  if (data.error) job.reject(new Error(data.error));
  else job.resolve(data.result);
};
worker.onerror = () => {
  $("summary").textContent = "ตัวทำดัชนีเริ่มทำงานไม่ได้ ลองโหลดหน้านี้ใหม่";
};

// ---------------- OCR ----------------
// เปิดไว้เป็นค่าเริ่มต้น ผู้ใช้ปิดได้ถ้าโฟลเดอร์มีรูปถ่ายเยอะ ค่าที่เลือกจำไว้ในเบราว์เซอร์
const ocrOn = () => localStorage.getItem("ocr") !== "off";

async function setOcr(on) {
  localStorage.setItem("ocr", on ? "on" : "off");
  await call("setOcr", { on });
  renderFolders();
  if (!on) return;
  // เปิด OCR: อ่านไฟล์ที่รออยู่ของโฟลเดอร์ที่เบราว์เซอร์ยังอนุญาตให้เลย
  for (const folder of folders) {
    const st = stateOf(folder.id);
    if (folder.kind === "handle" && !st.busy && !st.needsPermission && (stats[folder.id] || {}).needsOcr) scan(folder);
  }
}

// ---------------- ค้นตามความหมาย (AI) ----------------
// ปิดไว้เป็นค่าเริ่มต้น เพราะต้องโหลดโมเดลก้อนใหญ่ และ AI ใช้เวลาอ่านเอกสารนาน  ค่าที่เลือกจำไว้ในเบราว์เซอร์
// สวิตช์รวมของฟีเจอร์นี้: ตั้งเป็น false เพื่อซ่อนจากหน้าเว็บทั้งหมด (เช่น ถ้าไฟล์โมเดลใน vendor/models ยังไม่พร้อม)
const SEMANTIC_AVAILABLE = true;
const semOn = () => SEMANTIC_AVAILABLE && localStorage.getItem("semantic") === "on";
let embedBusy = false, embedAgain = false;

async function setSemantic(on) {
  localStorage.setItem("semantic", on ? "on" : "off");
  await call("setSemantic", { on });
  if (on) syncSemantic();
  else $("sem-status").textContent = "";
  runSearch();
}

// ให้ AI อ่านไฟล์ที่ยังไม่ได้อ่าน  เรียกซ้ำได้เรื่อย ๆ (หลังทำดัชนีเสร็จ หลังเปิดสวิตช์) ถ้ากำลังทำอยู่จะจดไว้ว่าต้องวนอีกรอบ
async function syncSemantic() {
  if (!semOn()) return;
  if (embedBusy) { embedAgain = true; return; }
  embedBusy = true;
  const status = $("sem-status");
  status.className = "sem-status";
  try {
    let r;
    do {
      embedAgain = false;
      r = await call("embed", {}, (p) => {
        if (p.model) status.textContent = `กำลังโหลดโมเดล AI ${Math.round(p.model.loaded / 1e6)} / ${Math.round(p.model.total / 1e6)} MB`;
        else status.textContent = `AI กำลังอ่านเอกสาร ${num(p.done + 1)} / ${num(p.total)} · ${p.name}`;
      });
      status.textContent = !semOn() ? "" : r.left ? `AI พักไว้ก่อน เหลืออีก ${num(r.left)} ไฟล์` : "AI อ่านเอกสารครบแล้ว";
      if (r.done) runSearch();
    } while (semOn() && (embedAgain || r.left));    // ถูกพักเพราะมีงานทำดัชนีแทรก: ต่อคิวใหม่ จะได้ทำต่อหลังงานนั้น
  } catch (e) {
    status.classList.add("error");
    status.textContent = `ค้นตามความหมายใช้ไม่ได้: ${e.message}`;
  }
  embedBusy = false;
}

// ---------------- โฟลเดอร์ ----------------
let folders = [];               // { id, name, kind: "handle" | "files", handle }
const state = new Map();        // id → สถานะชั่วคราวบนหน้าจอ { busy, progress, needsPermission, note, error }
const sessionFiles = new Map(); // id → Map(rel → File) ของโฟลเดอร์ที่เลือกแบบสำรอง (อยู่ได้แค่จนปิดแท็บ)

const stateOf = (id) => state.get(id) || state.set(id, {}).get(id);

// ปุ่มฟันเฟือง: สวิตช์แสดง/ซ่อนการ์ดโฟลเดอร์ทั้งใบ  ค่าที่เลือกจำไว้ในเบราว์เซอร์
// ถ้ายังไม่มีโฟลเดอร์เลย การ์ดแสดงเสมอ (ไม่งั้นหาปุ่มเพิ่มโฟลเดอร์ไม่เจอ)
const foldersHidden = () => folders.length > 0 && localStorage.getItem("folders-hidden") === "yes";

function renderGear() {
  const hidden = foldersHidden();
  const gear = $("folders-gear");
  $("folders-card").hidden = hidden;
  gear.ariaPressed = String(!hidden);
  gear.title = hidden ? "แสดงการ์ดโฟลเดอร์" : "ซ่อนการ์ดโฟลเดอร์";
  // การ์ดซ่อนอยู่ แต่มีโฟลเดอร์ที่รออนุญาตหรือทำดัชนีไม่สำเร็จ: ขึ้นจุดเตือนให้กดเปิดดู
  gear.classList.toggle("attention", hidden && folders.some((f) => stateOf(f.id).needsPermission || stateOf(f.id).error));
}

function toggleFolders() {
  localStorage.setItem("folders-hidden", foldersHidden() ? "no" : "yes");
  renderGear();
}

function renderFolders() {
  const list = $("folders");
  list.replaceChildren();
  $("no-folders").hidden = folders.length > 0;

  renderGear();
  for (const folder of folders) {
    const st = stateOf(folder.id);
    const s = stats[folder.id] || { total: 0, errors: 0, needsOcr: 0 };
    const status = el("span", { className: "status" });
    const actions = [];

    if (st.busy) {
      const p = st.progress || {};
      if (p.total) {
        status.append(el("progress", { max: p.total, value: p.done }), `กำลังทำดัชนี ${num(p.done)} / ${num(p.total)} · ${p.name}`);
      } else {
        status.append(p.listing ? `กำลังไล่ดูไฟล์ พบแล้ว ${num(p.listing)}` : "กำลังเตรียม");
      }
    } else if (st.needsPermission) {
      status.classList.add("warn");
      status.append(`${num(s.total)} ไฟล์ในดัชนีเดิม · ต้องอนุญาตให้อ่านโฟลเดอร์อีกครั้งเพื่ออัปเดต`);
      actions.push(el("button", { className: "small", textContent: "อนุญาต", onclick: () => grant(folder) }));
    } else {
      const parts = [`${num(s.total)} ไฟล์`];
      if (s.errors) parts.push(`อ่านไม่ได้ ${num(s.errors)}`);
      if (s.needsOcr) parts.push(`รอ OCR ${num(s.needsOcr)} (รูปภาพ/เอกสารสแกน ${ocrOn() ? "กด อัปเดต เพื่ออ่าน" : "ค้นได้แค่ชื่อไฟล์จนกว่าจะเปิด OCR"})`);
      if (st.note) parts.push(st.note);
      status.append(parts.join(" · "));
      if (st.error) { status.classList.add("error"); status.textContent = st.error; }
      if (folder.kind === "handle") {
        actions.push(el("button", { className: "small", textContent: "อัปเดต", onclick: () => scan(folder) }));
      }
    }
    if (!st.busy) {
      actions.push(el("button", { className: "small", textContent: "เอาออก", onclick: () => removeFolder(folder) }));
    }
    const label = folder.kind === "files" ? `${folder.name} (วิธีสำรอง)` : folder.name;
    list.append(el("li", {}, el("span", { className: "name", textContent: label }), status, ...actions));
  }

  const filter = $("folder-filter");
  const chosen = filter.value;
  filter.replaceChildren(el("option", { value: "", textContent: "ทุกโฟลเดอร์" }),
    ...folders.map((f) => el("option", { value: f.id, textContent: f.name })));
  filter.value = folders.some((f) => f.id === chosen) ? chosen : "";
  filter.hidden = folders.length < 2;
}

async function run(folder, cmd, args) {
  const st = stateOf(folder.id);
  Object.assign(st, { busy: true, progress: null, error: null, note: null, needsPermission: false });
  renderFolders();
  try {
    const r = await call(cmd, { folderId: folder.id, ...args }, (progress) => {
      st.progress = progress;
      renderFolders();
    });
    if (r.failedDirs.length) st.note = `เปิดโฟลเดอร์ย่อยไม่ได้ ${num(r.failedDirs.length)} แห่ง ใช้ดัชนีเดิมของส่วนนั้นไปก่อน`;
  } catch (e) {
    st.error = `ทำดัชนีไม่สำเร็จ: ${e.message}`;
  }
  st.busy = false;
  renderFolders();
  runSearch();
  syncSemantic();                                 // ไฟล์ใหม่หรือไฟล์ที่เปลี่ยน ให้ AI อ่านต่อ
}

const scan = (folder) => run(folder, "scan", { handle: folder.handle });

async function grant(folder) {
  if ((await folder.handle.requestPermission({ mode: "read" })) === "granted") scan(folder);
}

async function addHandle(handle) {
  for (const f of folders) {
    if (f.kind === "handle" && (await f.handle.isSameEntry(handle))) return scan(f);   // เพิ่มไว้แล้ว: แค่อัปเดต
  }
  const folder = { id: crypto.randomUUID(), name: handle.name || "โฟลเดอร์", kind: "handle", handle };
  await put("folders", folder);
  folders.push(folder);
  return scan(folder);
}

async function addFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "read" });
  } catch (e) {
    if (e.name !== "AbortError") $("summary").textContent = `เลือกโฟลเดอร์ไม่สำเร็จ: ${e.message}`;
    return;                                     // ผู้ใช้กดยกเลิก
  }
  await addHandle(handle);
}

// วิธีสำรอง: ช่องเลือกโฟลเดอร์แบบเก่าของเบราว์เซอร์ ได้รายการไฟล์มาครั้งเดียว อ่านซ้ำเองไม่ได้
async function addFallback(fileList) {
  const picked = [...fileList];
  if (!picked.length) return;
  const top = picked[0].webkitRelativePath.split("/")[0];
  const files = picked.map((file) => ({
    rel: file.webkitRelativePath.split("/").slice(1).join("/"), name: file.name, file,
  }));
  await addFiles(top, files);
}

async function addFiles(top, files) {
  let folder = folders.find((f) => f.kind === "files" && f.name === top);
  if (!folder) {
    folder = { id: crypto.randomUUID(), name: top, kind: "files" };
    await put("folders", folder);
    folders.push(folder);
  }
  sessionFiles.set(folder.id, new Map(files.map((f) => [f.rel, f.file])));
  await run(folder, "scanFiles", { files });
}

async function removeFolder(folder) {
  if (!confirm(`เอา "${folder.name}" ออกจากการค้นหา?\nไฟล์จริงในเครื่องไม่ถูกลบ`)) return;
  await call("removeFolder", { folderId: folder.id });
  await remove("folders", folder.id);
  folders = folders.filter((f) => f !== folder);
  sessionFiles.delete(folder.id);
  renderFolders();
  runSearch();
}

// ---------------- ค้นหา ----------------
const selectedTypes = new Set();
let last = { results: [], terms: [] };
let shown = 0;
let searchSeq = 0;

function renderTypes() {
  for (const name of [...new Set(Object.values(FILE_TYPES))]) {
    const chip = el("button", { textContent: name, ariaPressed: "false" });
    chip.onclick = () => {
      selectedTypes.has(name) ? selectedTypes.delete(name) : selectedTypes.add(name);
      chip.ariaPressed = String(selectedTypes.has(name));
      runSearch();
    };
    $("types").append(chip);
  }
}

// opts.near = true: ผู้ใช้กดขอให้หาคำสะกดใกล้เคียงเพิ่ม (ถ้าไม่เจอแบบตรงตัวเลย ระบบหาให้เองอยู่แล้ว)
async function runSearch(opts) {
  const near = opts?.near === true;
  const query = $("query").value;
  const mine = ++searchSeq;
  const summary = $("summary");
  summary.className = "summary";
  if (!query.trim()) {
    last = { results: [], terms: [] };
    summary.textContent = "";
    return renderResults(true);
  }
  const r = await call("search", { query, types: [...selectedTypes], folderId: $("folder-filter").value || null, near });
  if (mine !== searchSeq) return;               // มีการพิมพ์ใหม่แล้ว ทิ้งผลชุดเก่า
  last = r;
  const total = Object.values(stats).reduce((sum, s) => sum + s.total, 0);
  if (!total) summary.textContent = "ยังไม่มีไฟล์ในดัชนี ให้เพิ่มโฟลเดอร์ก่อน";
  else if (!r.results.length) summary.textContent = `ไม่พบคำว่า “${query.trim()}”` + (r.canNear ? " และไม่พบคำที่สะกดใกล้เคียง" : "");
  else if (r.near) {
    summary.classList.add("loose");
    summary.textContent = `ไม่พบ “${query.trim()}” แบบตรงตัว จึงแสดง ${num(r.nearTotal)} ไฟล์ที่มีคำสะกดใกล้เคียง`;
  } else if (r.loose && r.terms.length === 1) {
    summary.classList.add("loose");
    summary.textContent = `ไม่พบ “${query.trim()}” ในเนื้อหา แต่พบในชื่อไฟล์ ${num(r.total)} ไฟล์`;
  } else if (r.loose) {
    summary.classList.add("loose");
    summary.textContent = `ไม่พบทุกคำในตำแหน่งเดียวกัน จึงแสดง ${num(r.total)} ไฟล์ที่มีครบทุกคำ โดยแต่ละคำอยู่คนละหน้า/สไลด์/ชีต หรืออยู่ในชื่อไฟล์`;
  } else {
    const exact = r.results.filter((x) => !x.near);
    const hits = exact.reduce((sum, x) => sum + x.hitCount, 0);
    summary.textContent = `พบใน ${num(r.total)} ไฟล์ รวม ${num(hits)} ตำแหน่ง` + (r.total > exact.length ? ` (แสดง ${num(exact.length)} ไฟล์แรก)` : "");
  }
  // เจอแบบตรงตัวแล้ว: มีปุ่มให้หาไฟล์ที่สะกดคำนี้เพี้ยนไปเพิ่มได้ (เช่น เอกสารสแกนที่ OCR อ่านวรรณยุกต์ตก)
  if (r.total && r.canNear) {
    if (!near) summary.append(" ", el("button", { className: "small", textContent: "หาคำสะกดใกล้เคียงเพิ่ม", onclick: () => runSearch({ near: true }) }));
    else summary.append(r.nearTotal ? ` · และคำสะกดใกล้เคียงอีก ${num(r.nearTotal)} ไฟล์` : " · ไม่พบคำสะกดใกล้เคียงเพิ่ม");
  }
  renderResults(true);
  if (semOn() && total) addSemantic(query, mine);
}

// ต่อท้ายผลค้นด้วยไฟล์ที่ "ความหมายใกล้เคียง" (AI) มาช้ากว่าผลค้นแบบคำเล็กน้อย จึงเติมทีหลัง
async function addSemantic(query, mine) {
  const note = el("span", { textContent: " · กำลังหาตามความหมาย…" });
  $("summary").append(note);
  let r;
  try {
    r = await call("semantic", { query, types: [...selectedTypes], folderId: $("folder-filter").value || null, skip: last.results.map((x) => x.key) });
  } catch (e) {
    if (mine === searchSeq) note.textContent = " · ค้นตามความหมายไม่สำเร็จ";
    return;
  }
  if (mine !== searchSeq) return;                 // มีการพิมพ์ใหม่แล้ว
  const before = last.results.length;
  note.textContent = !r.results.length ? "" : before ? ` · และความหมายใกล้เคียงอีก ${num(r.results.length)} ไฟล์` : ` · แต่พบ ${num(r.results.length)} ไฟล์ที่ความหมายใกล้เคียง`;
  if (!r.results.length) return;
  last.results.push(...r.results);
  if (shown === before) renderResults(false);     // แสดงครบอยู่แล้ว: ต่อท้ายได้เลย การ์ดเดิม (และพรีวิวที่เปิดไว้) ไม่ถูกแตะ
  else $("more").hidden = false;
  $("results").querySelectorAll(".order").forEach((badge, i) => { badge.textContent = `(${num(i + 1)}/${num(last.results.length)})`; });
}

// ผลค้นแต่ละรายการอยู่กลุ่มไหน: ตรงตัว / คำสะกดใกล้เคียง / ความหมายใกล้เคียง
const groupOf = (r) => (r.sem ? "sem" : r.near ? "near" : "exact");
const GROUP_TITLE = { near: "คำสะกดใกล้เคียง", sem: "ความหมายใกล้เคียง · AI เลือกให้ อาจไม่ตรงทุกไฟล์" };
const GROUP_TAG = { near: "ใกล้เคียง", sem: "ความหมาย" };

// ใส่แถบสีให้คำที่ค้น  สร้างเป็นโหนดข้อความ ไม่ใช้ innerHTML ข้อความในไฟล์จึงแทรกโค้ดในหน้าเว็บไม่ได้
function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  if (!terms.length) { frag.append(text); return frag; }
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let pos = 0;
  for (const m of text.matchAll(pattern)) {
    frag.append(text.slice(pos, m.index), el("mark", { textContent: m[0] }));
    pos = m.index + m[0].length;
  }
  frag.append(text.slice(pos));
  return frag;
}

function formatDate(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// คำที่ใช้ใส่แถบสีในผลค้นรายการหนึ่ง: ปกติคือคำค้น  ถ้าเป็นคำสะกดใกล้เคียง ใช้คำที่เจอจริงในไฟล์
const marksOf = (r) => r.marks || last.terms;

function hitLine(hit, terms) {
  return el("div", { className: "hit" }, el("b", { textContent: hit.loc }), " — ", highlight(hit.snippet, terms));
}

function renderResults(reset) {
  const list = $("results");
  if (reset) { list.replaceChildren(); shown = 0; }
  const next = last.results.slice(shown, shown + PAGE_SIZE);
  for (const [i, r] of next.entries()) {
    const folder = folders.find((f) => f.id === r.folderId);
    const marks = marksOf(r);
    // ขึ้นหัวข้อคั่นก่อนไฟล์แรกของกลุ่ม "คำสะกดใกล้เคียง" และ "ความหมายใกล้เคียง"
    // (คำสะกดใกล้เคียงที่ขึ้นเป็นกลุ่มแรก ไม่ต้องมีหัวข้อ เพราะบรรทัดสรุปด้านบนบอกไว้แล้ว)
    const group = groupOf(r), at = shown + i;
    if (group !== "exact" && (at === 0 ? group === "sem" : groupOf(last.results[at - 1]) !== group)) {
      list.append(el("li", { className: `divider ${group}`, textContent: GROUP_TITLE[group] }));
    }
    const open = el("button", { className: "small", textContent: "เปิดไฟล์", onclick: () => openFile(r, open) });
    // ปุ่มพรีวิว: กดครั้งแรกสร้างแผงพรีวิวต่อท้ายการ์ด กดอีกครั้งซ่อน
    let panel = null;
    const preview = el("button", { className: "small", textContent: "พรีวิว", ariaExpanded: "false" });
    preview.onclick = () => {
      if (!panel) item.append((panel = previewPanel(r)));
      else panel.hidden = !panel.hidden;
      preview.textContent = panel.hidden ? "พรีวิว" : "ซ่อนพรีวิว";
      preview.ariaExpanded = String(!panel.hidden);
    };
    const item = el("li", {},
      el("div", { className: "row between top-row" },
        el("span", { className: "name-line" },
          el("span", { className: "order", textContent: `(${num(shown + i + 1)}/${num(last.results.length)})` }),   // ลำดับไฟล์ในผลค้น
          el("span", { className: "title" }, highlight(r.name, marks)),
          ...(group === "exact" ? [] : [el("span", {
            className: `near-tag ${group}`, textContent: GROUP_TAG[group],
            title: r.sem ? `ความใกล้เคียง ${Math.round(r.score * 100)}%` : `ในไฟล์สะกดว่า ${r.marks.join(", ")}`,
          })])),
        el("span", { className: "row actions" }, preview, open)),
      el("div", { className: "meta", textContent: `${r.type} · แก้ไขล่าสุด ${formatDate(r.mtime)} · เจอ ${num(r.hitCount)} ตำแหน่ง` }),
      el("div", { className: "path", textContent: `${folder ? folder.name : "?"}/${r.rel}` }),
      ...r.hits.slice(0, 3).map((h) => hitLine(h, marks)),
    );
    if (r.hits.length > 3) {
      item.append(el("details", {}, el("summary", { textContent: `ดูอีก ${num(r.hits.length - 3)} ตำแหน่ง` }),
        ...r.hits.slice(3).map((h) => hitLine(h, marks))));
    }
    list.append(item);
  }
  shown += next.length;
  $("more").hidden = shown >= last.results.length;
}

// หาไฟล์จริงของผลค้นรายการหนึ่ง (ขออนุญาตอ่านโฟลเดอร์ถ้าจำเป็น)  ผู้ใช้ไม่อนุญาต = คืน null
async function fileOf(r) {
  const folder = folders.find((f) => f.id === r.folderId);
  if (folder.kind === "handle") {
    if ((await folder.handle.queryPermission({ mode: "read" })) !== "granted" &&
        (await folder.handle.requestPermission({ mode: "read" })) !== "granted") return null;
    const parts = r.rel.split("/");
    let dir = folder.handle;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  }
  const file = sessionFiles.get(folder.id)?.get(r.rel);
  if (!file) throw new Error("ต้องเลือกโฟลเดอร์นี้ด้วยวิธีสำรองอีกครั้งก่อน จึงจะเปิดไฟล์ได้");
  return file;
}

const fileProblem = (e) => (e.name === "NotFoundError" ? "ไม่พบไฟล์แล้ว" : "เปิดไม่ได้");
const extOfName = (name) => name.slice(name.lastIndexOf(".")).toLowerCase();

// เปิดไฟล์จากผลค้น: PDF รูป และไฟล์ข้อความ เปิดในแท็บใหม่  ไฟล์ Office ดาวน์โหลดสำเนาไปเปิดด้วยโปรแกรม
async function openFile(r, button) {
  let file;
  try {
    file = await fileOf(r);
  } catch (e) {
    button.textContent = fileProblem(e);
    button.title = e.message;
    return;
  }
  if (!file) return;
  const url = URL.createObjectURL(file);
  if (VIEWABLE.has(extOfName(r.name))) window.open(url, "_blank");
  else el("a", { href: url, download: r.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------- พรีวิวในการ์ด ----------------
const PAGE_IMAGE = new Set([".pdf", ".tif", ".tiff"]);              // วาดภาพหน้าจริงด้วย MuPDF
const PLAIN_IMAGE = new Set([".png", ".jpg", ".jpeg", ".bmp"]);     // เบราว์เซอร์แสดงรูปได้เอง

// สร้างแผงพรีวิวของผลค้นรายการหนึ่ง: ข้อความช่วงยาวรอบคำที่เจอ เลื่อนดูทีละตำแหน่งได้
// ถ้าเป็น PDF หรือรูปภาพ มีปุ่มให้ดูภาพหน้าจริงด้วย
function previewPanel(r) {
  const ext = extOfName(r.name);
  const spots = r.hits.filter((h) => h.chunk !== undefined);        // ตำแหน่งในเนื้อหา (ไม่นับที่เจอในชื่อไฟล์)
  if (!spots.length) spots.push({ chunk: 0 });                      // เจอแค่ชื่อไฟล์: พรีวิวต้นเอกสารแทน
  let index = 0;
  let imageUrl = null;

  const where = el("span", { className: "where" });
  const prev = el("button", { className: "small", textContent: "‹", ariaLabel: "ตำแหน่งก่อนหน้า", onclick: () => show(index - 1) });
  const next = el("button", { className: "small", textContent: "›", ariaLabel: "ตำแหน่งถัดไป", onclick: () => show(index + 1) });
  const text = el("div", { className: "preview-text" });
  const imageButton = el("button", { className: "small", textContent: "ดูภาพหน้านี้", onclick: () => showImage() });
  const imageBox = el("div", { className: "preview-image" });
  const canImage = PAGE_IMAGE.has(ext) || PLAIN_IMAGE.has(ext);
  const panel = el("div", { className: "preview" },
    el("div", { className: "row between" }, where, el("span", { className: "row" }, ...(canImage ? [imageButton] : []), prev, next)),
    text, imageBox);
  let pageNow = 1;

  async function show(i) {
    index = Math.min(Math.max(i, 0), spots.length - 1);
    prev.hidden = next.hidden = spots.length < 2;
    prev.disabled = index === 0;
    next.disabled = index === spots.length - 1;
    imageBox.replaceChildren();
    if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
    imageButton.hidden = false;

    const c = await call("context", { key: r.key, chunk: spots[index].chunk, terms: marksOf(r), at: r.sem ? spots[index].pos : null });
    pageNow = c ? parseInt((/^หน้า (\d+)$/.exec(c.loc) || [])[1] || "1", 10) : 1;
    where.textContent = c ? `${spots.length > 1 ? `ตำแหน่งที่ ${index + 1} จาก ${spots.length} · ` : ""}${c.loc}` : "";
    text.replaceChildren();
    if (!c) {
      text.append(el("span", { className: "muted", textContent: "ไฟล์นี้ไม่มีข้อความให้พรีวิว" }));
      return;
    }
    text.append(c.cutStart ? "… " : "", highlight(c.text, marksOf(r)), c.cutEnd ? " …" : "");
    const mark = text.querySelector("mark");
    text.scrollTop = 0;
    if (mark) text.scrollTop = mark.getBoundingClientRect().top - text.getBoundingClientRect().top - 48;   // เลื่อนให้เห็นคำที่เจอ
  }

  async function showImage() {
    imageButton.hidden = true;
    imageBox.replaceChildren(el("span", { className: "muted", textContent: "กำลังเตรียมภาพ" }));
    try {
      const file = await fileOf(r);
      if (!file) { imageButton.hidden = false; return imageBox.replaceChildren(); }
      const blob = PAGE_IMAGE.has(ext) ? await call("renderPage", { file, ext, page: pageNow }) : file;
      imageUrl = URL.createObjectURL(blob);
      imageBox.replaceChildren(el("img", { src: imageUrl, alt: `ภาพของ ${r.name}` }));
    } catch (e) {
      imageBox.replaceChildren(el("span", { className: "muted", textContent: e.name === "NotFoundError" ? "ไม่พบไฟล์แล้ว" : `แสดงภาพไม่ได้: ${e.message}` }));
    }
  }

  show(0);
  return panel;
}

// ---------------- เริ่มต้น ----------------
async function start() {
  $("unsupported").hidden = "showDirectoryPicker" in window;
  $("add-folder").disabled = !("showDirectoryPicker" in window);
  $("add-folder").onclick = addFolder;
  $("folders-gear").onclick = toggleFolders;
  $("add-fallback").onclick = () => $("fallback-input").click();
  $("fallback-input").onchange = (e) => addFallback(e.target.files).finally(() => { e.target.value = ""; });
  $("more").onclick = () => renderResults(false);
  $("folder-filter").onchange = runSearch;
  let timer;
  $("query").oninput = () => { clearTimeout(timer); timer = setTimeout(runSearch, 150); };
  renderTypes();
  $("ocr").checked = ocrOn();
  $("ocr").onchange = (e) => setOcr(e.target.checked);

  $("semantic").closest("label").hidden = !SEMANTIC_AVAILABLE;
  $("semantic").checked = semOn();
  $("semantic").onchange = (e) => setSemantic(e.target.checked);

  folders = await getAll("folders");
  await call("setOcr", { on: ocrOn() });
  await call("setSemantic", { on: semOn() });
  renderFolders();

  // โฟลเดอร์ที่เบราว์เซอร์ยังอนุญาตอยู่ อัปเดตดัชนีให้เองตอนเปิดหน้า  ที่เหลือรอให้ผู้ใช้กด "อนุญาต"
  for (const folder of folders) {
    if (folder.kind !== "handle") continue;
    if ((await folder.handle.queryPermission({ mode: "read" })) === "granted") scan(folder);
    else { stateOf(folder.id).needsPermission = true; renderFolders(); }
  }
  syncSemantic();                                 // ต่อคิวหลังการอัปเดตดัชนีข้างบน
}

// สำหรับการทดสอบอัตโนมัติ: เพิ่มโฟลเดอร์จาก handle โดยไม่ผ่านหน้าต่างเลือกโฟลเดอร์
window.__fileSearch = { addHandle, addFiles };

start();
