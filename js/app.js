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

// รูปสัญลักษณ์บนปุ่ม (ลายเส้นจากชุด Feather สัญญาอนุญาต MIT)  เป็นข้อความคงที่ในโค้ด ไม่ได้มาจากไฟล์ของผู้ใช้
const ICONS = {
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
};
function icon(name) {
  const holder = document.createElement("span");
  holder.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return holder.firstChild;
}
// ปุ่มที่เป็นรูปสัญลักษณ์อย่างเดียว  label = คำอธิบายที่ขึ้นเมื่อเอาเมาส์ชี้ และที่โปรแกรมอ่านจออ่านให้ฟัง
const iconButton = (name, label, onclick) => el("button", { className: "icon-btn", title: label, ariaLabel: label, onclick }, icon(name));

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

// ---------------- ให้ AI ดูรูป ----------------
// ปิดไว้เป็นค่าเริ่มต้น เพราะต้องโหลดโมเดลก้อนใหญ่  ค่าที่เลือกจำไว้ในเบราว์เซอร์
const tagsOn = () => localStorage.getItem("tags") === "on";

async function setTags(on) {
  localStorage.setItem("tags", on ? "on" : "off");
  await call("setTags", { on });
  const status = $("tags-status");
  status.className = "sem-status";
  status.textContent = "";
  renderFolders();
  if (!on) return;
  try {
    await call("loadVision", {}, (p) => { status.textContent = `กำลังโหลดโมเดลดูรูป ${Math.round(p.loaded / 1e6)} / ${Math.round(p.total / 1e6)} MB`; });
    status.textContent = "";
  } catch (e) {
    status.classList.add("error");
    status.textContent = `AI ดูรูปใช้ไม่ได้: ${e.message}`;
    return;
  }
  // ให้ AI ดูรูปที่รออยู่ ของโฟลเดอร์ที่เบราว์เซอร์ยังอนุญาตให้เลย
  for (const folder of folders) {
    const st = stateOf(folder.id);
    if (folder.kind === "handle" && !st.busy && !st.needsPermission && (stats[folder.id] || {}).needsTags) scan(folder);
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
    const s = stats[folder.id] || { total: 0, errors: 0, needsOcr: 0, needsTags: 0 };
    const status = el("span", { className: "status" });
    const actions = [];

    if (st.busy) {
      // แถบความคืบหน้าขึ้นเฉพาะตอนมีไฟล์ใหม่หรือไฟล์ที่เปลี่ยนให้อ่านจริง ๆ (นับเฉพาะไฟล์พวกนั้น)
      // ตอนที่แค่ตรวจว่ามีอะไรเปลี่ยนไหม แสดงจำนวนไฟล์ตามปกติ ต่อท้ายด้วยข้อความสั้น ๆ
      const p = st.progress || {};
      if (p.name !== undefined) {
        status.append(el("progress", { max: p.total, value: p.done }), `กำลังอ่านไฟล์ที่ใหม่หรือเปลี่ยน ${num(p.done + 1)} / ${num(p.total)} · ${p.name}`);
      } else if (s.total) {
        status.append(`${num(s.total)} ไฟล์ · กำลังตรวจหาไฟล์ใหม่`);
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
      if (s.needsTags && tagsOn()) parts.push(`รอ AI ดูรูป ${num(s.needsTags)} (กด อัปเดต)`);
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
    if (dupesView) return showDuplicates();       // กำลังดูหน้ารวมไฟล์ซ้ำอยู่ (ดัชนีเพิ่งเปลี่ยน): แสดงหน้านั้นใหม่ ไม่ใช่ล้างทิ้ง
    last = { results: [], terms: [] };
    summary.textContent = "";
    return renderResults(true);
  }
  setDupesView(false);                            // พิมพ์คำค้น = กลับมาหน้าผลค้น
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
  addDupBadges(mine);
  if (semOn() && total) addSemantic(query, mine);
}

// ---------------- ไฟล์ซ้ำ/คล้ายกัน ----------------
const formatSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// แถวของไฟล์หนึ่งในรายการไฟล์ซ้ำ/คล้าย  tag = ป้ายหน้าแถว (ข้อความ หรือ null)  newest = ติดป้าย "ใหม่สุด"
function dupRow(file, tag, newest) {
  const folder = folders.find((f) => f.id === file.folderId);
  const open = el("button", { className: "small", textContent: "เปิดไฟล์", onclick: () => openFile(file, open) });
  return el("div", { className: "dup-row" },
    ...(tag ? [el("span", { className: "dup-tag", textContent: tag })] : []),
    el("span", { className: "who" },
      el("span", { className: "name", textContent: file.name }),
      el("span", { className: "where", textContent: `${folder ? folder.name : "?"}/${file.rel} · ${file.type} · แก้ไขล่าสุด ${formatDate(file.mtime)} · ${formatSize(file.size)}` })),
    ...(newest ? [el("span", { className: "dup-tag newest", textContent: "ใหม่สุด" })] : []),
    open);
}

// ติดปุ่ม "ซ้ำ n · คล้าย m" บนการ์ดผลค้นที่มีไฟล์ซ้ำ/คล้าย  กดแล้วกางรายการไฟล์พวกนั้น
function addDupBadge(item, r) {
  const list = last.dups && last.dups[r.key];
  if (!list || item.querySelector(".dup-badge")) return;
  const exact = list.filter((x) => x.exact).length, similar = list.length - exact;
  const label = [exact ? `ซ้ำ ${num(exact)} ไฟล์` : "", similar ? `คล้าย ${num(similar)} ไฟล์` : ""].filter(Boolean).join(" · ");
  let panel = null;
  const badge = el("button", { className: "small dup-badge", textContent: `มีไฟล์${label}`, ariaExpanded: "false" });
  badge.onclick = () => {
    if (!panel) {
      const newest = Math.max(r.mtime, ...list.map((x) => x.mtime));
      panel = el("div", { className: "dup-list" },
        ...list.map((x) => dupRow(x, x.exact ? "ซ้ำ" : `คล้าย ${Math.round(x.sim * 100)}%`, x.mtime === newest && x.mtime > r.mtime)));
      badge.after(panel);
    } else panel.hidden = !panel.hidden;
    badge.ariaExpanded = String(!panel.hidden);
  };
  item.querySelector(".path").after(badge);
}

// ถามตัวทำดัชนีว่าผลค้นชุดนี้ไฟล์ไหนมีไฟล์ซ้ำ/คล้ายบ้าง แล้วติดป้ายให้การ์ดที่แสดงอยู่ (มาช้ากว่าผลค้นเล็กน้อย)
async function addDupBadges(mine) {
  if (!last.results.length) return;
  let dups;
  try {
    dups = await call("neighbors", { keys: last.results.map((x) => x.key) });
  } catch (e) {
    return;                                       // เทียบไม่สำเร็จ: ไม่มีป้าย แต่ผลค้นยังใช้ได้ตามปกติ
  }
  if (mine !== searchSeq) return;
  last.dups = dups;
  for (const item of $("results").querySelectorAll("li[data-key]")) {
    const r = last.results.find((x) => x.key === item.dataset.key);
    if (r) addDupBadge(item, r);
  }
}

// หน้ารวม: แสดงทุกกลุ่มไฟล์ที่ซ้ำ/คล้ายกันในดัชนี แทนที่ผลค้น  ปุ่ม "ไฟล์ซ้ำ/คล้ายกัน" กดเปิด กดอีกครั้งปิด
let dupesView = false;
function setDupesView(on) {
  dupesView = on;
  $("show-dupes").ariaPressed = String(on);
}

function toggleDuplicates() {
  if (!dupesView) return showDuplicates();
  setDupesView(false);
  runSearch();
}

async function showDuplicates() {
  const mine = ++searchSeq;
  const summary = $("summary");
  setDupesView(true);
  $("query").value = "";
  last = { results: [], terms: [] };
  renderResults(true);
  summary.className = "summary";
  summary.textContent = "กำลังเทียบไฟล์";
  let r;
  try {
    r = await call("duplicates");
  } catch (e) {
    summary.textContent = `เทียบไฟล์ไม่สำเร็จ: ${e.message}`;
    return;
  }
  if (mine !== searchSeq) return;
  if (!r.totalGroups) {
    summary.textContent = "ไม่พบไฟล์ที่ข้อความซ้ำกันหรือคล้ายกันมาก";
    return;
  }
  summary.textContent = `พบ ${num(r.totalGroups)} กลุ่มไฟล์ที่ซ้ำหรือคล้ายกัน รวม ${num(r.totalFiles)} ไฟล์` +
    (r.totalGroups > r.groups.length ? ` (แสดง ${num(r.groups.length)} กลุ่มใหญ่สุด)` : "") + " · เทียบจากข้อความในไฟล์ เว็บไม่ลบไฟล์ให้";
  $("results").replaceChildren(...r.groups.map((g, i) => el("li", {},
    el("div", { className: "name-line" },
      el("span", { className: "order", textContent: `(${num(i + 1)}/${num(r.groups.length)})` }),
      el("span", { className: "title", textContent: g.exact ? `ข้อความซ้ำกันทุกตัวอักษร ${num(g.files.length)} ไฟล์` : `คล้ายกัน ${num(g.files.length)} ไฟล์ · เหมือนกันราว ${Math.round(g.sim * 100)}% ขึ้นไป` })),
    el("div", { className: "dup-list" }, ...g.files.map((f, j) => dupRow(f, null, j === 0 && f.mtime > g.files[g.files.length - 1].mtime))))));
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
  addDupBadges(mine);                             // ผลที่เพิ่งต่อท้ายก็อาจมีไฟล์ซ้ำ/คล้าย
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
    const open = iconButton("file", "เปิดไฟล์", () => openFile(r, open));
    // ปุ่มเปิดโฟลเดอร์: เฉพาะโฟลเดอร์ที่เพิ่มด้วยปุ่ม "เพิ่มโฟลเดอร์" (วิธีสำรองไม่มีตัวจับไฟล์จริง)
    const folderHint = el("div", { className: "folder-hint", hidden: true });
    const canOpenFolder = folder && folder.kind === "handle" && "showOpenFilePicker" in window;
    const openDir = iconButton("folder", "เปิดโฟลเดอร์ที่เก็บไฟล์นี้", () => openFolder(r, openDir, folderHint));
    // ปุ่มพรีวิว: กดครั้งแรกสร้างแผงพรีวิวต่อท้ายการ์ด กดอีกครั้งซ่อน
    let panel = null;
    const preview = iconButton("eye", "พรีวิว", () => {
      if (!panel) item.append((panel = previewPanel(r)));
      else panel.hidden = !panel.hidden;
      preview.replaceChildren(icon(panel.hidden ? "eye" : "eyeOff"));       // ตาปิด = กดเพื่อซ่อนพรีวิว
      preview.title = preview.ariaLabel = panel.hidden ? "พรีวิว" : "ซ่อนพรีวิว";
      preview.ariaExpanded = String(!panel.hidden);
    });
    preview.ariaExpanded = "false";
    const item = el("li", {},
      el("div", { className: "row between top-row" },
        el("span", { className: "name-line" },
          el("span", { className: "order", textContent: `(${num(shown + i + 1)}/${num(last.results.length)})` }),   // ลำดับไฟล์ในผลค้น
          el("span", { className: "title" }, highlight(r.name, marks)),
          ...(group === "exact" ? [] : [el("span", {
            className: `near-tag ${group}`, textContent: GROUP_TAG[group],
            title: r.sem ? `ความใกล้เคียง ${Math.round(r.score * 100)}%` : `ในไฟล์สะกดว่า ${r.marks.join(", ")}`,
          })])),
        el("span", { className: "row actions" }, preview, open, ...(canOpenFolder ? [openDir] : []))),
      el("div", { className: "meta", textContent: `${r.type} · แก้ไขล่าสุด ${formatDate(r.mtime)} · เจอ ${num(r.hitCount)} ตำแหน่ง` }),
      el("div", { className: "path", textContent: `${folder ? folder.name : "?"}/${r.rel}` }),
      folderHint,
      ...r.hits.slice(0, 3).map((h) => hitLine(h, marks)),
    );
    if (r.hits.length > 3) {
      item.append(el("details", {}, el("summary", { textContent: `ดูอีก ${num(r.hits.length - 3)} ตำแหน่ง` }),
        ...r.hits.slice(3).map((h) => hitLine(h, marks))));
    }
    item.dataset.key = r.key;
    addDupBadge(item, r);                         // (ถ้ารู้แล้วว่าไฟล์นี้มีไฟล์ซ้ำ/คล้าย เช่น ตอนกด "แสดงเพิ่ม")
    list.append(item);
  }
  shown += next.length;
  $("more").hidden = shown >= last.results.length;
}

// หา "ตัวจับ" ของไฟล์จริงในเครื่อง สำหรับผลค้นจากโฟลเดอร์ที่เพิ่มด้วยปุ่ม "เพิ่มโฟลเดอร์" (ขออนุญาตอ่านโฟลเดอร์ถ้าจำเป็น)
// ผู้ใช้ไม่อนุญาต = คืน null
async function handleOf(r) {
  const folder = folders.find((f) => f.id === r.folderId);
  if ((await folder.handle.queryPermission({ mode: "read" })) !== "granted" &&
      (await folder.handle.requestPermission({ mode: "read" })) !== "granted") return null;
  const parts = r.rel.split("/");
  let dir = folder.handle;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return dir.getFileHandle(parts[parts.length - 1]);
}

// หาไฟล์จริงของผลค้นรายการหนึ่ง  ผู้ใช้ไม่อนุญาต = คืน null
async function fileOf(r) {
  const folder = folders.find((f) => f.id === r.folderId);
  if (folder.kind === "handle") {
    const handle = await handleOf(r);
    return handle && handle.getFile();
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

// เปิดหน้าต่างโฟลเดอร์ที่เก็บไฟล์นี้ (แทนการดาวน์โหลดสำเนา)
// เว็บสั่งเปิด File Explorer / Finder ตรง ๆ ไม่ได้ ที่ทำได้คือเปิดหน้าต่าง "เลือกไฟล์" ของระบบ ให้ไปเริ่มที่โฟลเดอร์ของไฟล์นี้
// ในหน้าต่างนั้นผู้ใช้เห็นไฟล์จริง คลิกขวาเพื่อเปิดด้วยโปรแกรมได้ (ได้ไฟล์ตัวจริง ไม่ใช่สำเนา) เสร็จแล้วกดยกเลิก
// เว็บใส่ชื่อไฟล์ลงในช่องค้นหาของหน้าต่างนั้นให้ไม่ได้ จึงช่วยสองทาง: คัดลอกชื่อไฟล์ไว้ให้ผู้ใช้กดวาง (Ctrl+V) เอง
// และกรองหน้าต่างให้เห็นเฉพาะไฟล์ชนิดเดียวกัน โดยใช้ชื่อไฟล์เป็นชื่อตัวกรอง จะได้เห็นชื่อที่ต้องหาอยู่ในหน้าต่างด้วย
const FOLDER_HINT = "หน้าต่างโฟลเดอร์เปิดอยู่ · คัดลอกชื่อไฟล์ไว้ให้แล้ว: กด Ctrl+V ในช่องค้นหาของหน้าต่างเพื่อหาไฟล์ จากนั้นคลิกขวาที่ไฟล์เพื่อเปิดด้วยโปรแกรม (ได้ไฟล์ตัวจริง ไม่ใช่สำเนา) เสร็จแล้วกดยกเลิก (Cancel)";
async function openFolder(r, button, hint) {
  let handle;
  try {
    handle = await handleOf(r);
  } catch (e) {
    button.textContent = fileProblem(e);
    button.title = e.message;
    return;
  }
  if (!handle) return;
  hint.textContent = FOLDER_HINT;               // คำแนะนำนี้แสดงค้างไว้ใต้การ์ดระหว่างที่หน้าต่างของระบบเปิดอยู่
  hint.hidden = false;
  navigator.clipboard?.writeText(r.name).catch(() => {});     // คัดลอกไม่ได้ก็ไม่เป็นไร ยังหาไฟล์ด้วยตาได้
  const ext = extOfName(r.name);
  const sameType = /^\.[a-z0-9]+$/.test(ext) ? { types: [{ description: r.name, accept: { "application/octet-stream": [ext] } }] } : {};
  try {
    await window.showOpenFilePicker({ startIn: handle, ...sameType });
    hint.hidden = true;                         // ผู้ใช้เลือกไฟล์แล้วกด Open ในหน้าต่างนั้น: ไม่ต้องทำอะไรต่อ
  } catch (e) {
    if (e.name === "AbortError") hint.hidden = true;                                                      // ปิดหน้าต่างแล้ว
    else if (e.name === "SecurityError") hint.textContent = "เบราว์เซอร์ขอให้กดปุ่ม เปิดโฟลเดอร์ อีกครั้ง";  // เพิ่งกดอนุญาตอ่านโฟลเดอร์ไป จึงต้องกดใหม่
    else hint.textContent = `เปิดโฟลเดอร์ไม่ได้: ${e.message}`;
  }
}

// ---------------- ค้นด้วยเสียง ----------------
// ใช้ตัวแปลงเสียงเป็นข้อความที่มากับเบราว์เซอร์ (Chrome / Edge) ซึ่งส่งเสียงไปแปลงที่เซิร์ฟเวอร์ของผู้ผลิตเบราว์เซอร์ จึงต้องต่อเน็ต
// นี่เป็นส่วนเดียวของเว็บที่มีข้อมูลออกจากเครื่อง (เฉพาะเสียงคำค้น ไม่ใช่เอกสาร) จึงบอกผู้ใช้ทุกครั้งที่เริ่มฟัง
const speechApi = () => window.SpeechRecognition || window.webkitSpeechRecognition;
const VOICE_ERRORS = {
  "not-allowed": "เบราว์เซอร์ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน กดรูปแม่กุญแจข้างที่อยู่เว็บเพื่ออนุญาต แล้วลองใหม่",
  "service-not-allowed": "เบราว์เซอร์นี้ไม่เปิดให้แปลงเสียงเป็นข้อความ",
  "audio-capture": "ไม่พบไมโครโฟนในเครื่องนี้",
  "network": "ค้นด้วยเสียงต้องต่ออินเทอร์เน็ต ตรวจการเชื่อมต่อแล้วลองใหม่",
  "no-speech": "ไม่ได้ยินเสียง ลองกดไมโครโฟนแล้วพูดใหม่",
  "language-not-supported": "เบราว์เซอร์นี้แปลงเสียงภาษาไทยไม่ได้",
};
let listening = null;           // ตัวฟังเสียงที่กำลังทำงานอยู่ (ไม่มี = ไม่ได้ฟัง)

function toggleVoice() {
  if (listening) return listening.stop();       // กดซ้ำระหว่างฟัง = หยุดฟัง
  const mic = $("mic"), summary = $("summary");
  const rec = new (speechApi())();
  rec.lang = "th-TH";
  rec.interimResults = true;                    // แสดงคำที่ได้ยินในช่องค้นระหว่างพูด
  let heard = false, failed = false;
  rec.onstart = () => {
    listening = rec;
    mic.classList.add("listening");
    mic.ariaPressed = "true";
    summary.className = "summary";
    summary.textContent = "กำลังฟัง พูดคำที่ต้องการค้นได้เลย (เสียงคำค้นถูกส่งไปแปลงเป็นข้อความที่ Google)";
  };
  rec.onresult = (event) => {
    const text = [...event.results].map((r) => r[0].transcript).join("").trim();
    if (!text) return;
    heard = true;
    $("query").value = text;
  };
  rec.onerror = (event) => {
    if (event.error === "aborted") return;      // ผู้ใช้กดหยุดเอง
    failed = true;
    summary.textContent = VOICE_ERRORS[event.error] || `ค้นด้วยเสียงไม่สำเร็จ (${event.error})`;
  };
  rec.onend = () => {
    listening = null;
    mic.classList.remove("listening");
    mic.ariaPressed = "false";
    if (heard) runSearch();
    else if (!failed) summary.textContent = VOICE_ERRORS["no-speech"];
  };
  try {
    rec.start();
  } catch (e) {
    summary.textContent = `ค้นด้วยเสียงไม่สำเร็จ (${e.message})`;
  }
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
  $("mic").hidden = !speechApi();
  $("mic").onclick = toggleVoice;
  $("show-dupes").onclick = toggleDuplicates;
  $("add-fallback").onclick = () => $("fallback-input").click();
  $("fallback-input").onchange = (e) => addFallback(e.target.files).finally(() => { e.target.value = ""; });
  $("more").onclick = () => renderResults(false);
  $("folder-filter").onchange = runSearch;
  let timer;
  $("query").oninput = () => { clearTimeout(timer); timer = setTimeout(runSearch, 150); };
  renderTypes();
  $("ocr").checked = ocrOn();
  $("ocr").onchange = (e) => setOcr(e.target.checked);

  $("tags").checked = tagsOn();
  $("tags").onchange = (e) => setTags(e.target.checked);
  $("semantic").closest("label").hidden = !SEMANTIC_AVAILABLE;
  $("semantic").checked = semOn();
  $("semantic").onchange = (e) => setSemantic(e.target.checked);

  folders = await getAll("folders");
  await call("setOcr", { on: ocrOn() });
  await call("setSemantic", { on: semOn() });
  await call("setTags", { on: tagsOn() });
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
