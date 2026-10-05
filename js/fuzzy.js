// fuzzy.js — หาคำที่ "สะกดใกล้เคียง" กับคำค้น (ไม่มีหน้าจอ)
// ใช้เมื่อพิมพ์ผิด หรือ OCR อ่านเพี้ยนไปตัวสองตัว เช่น ค้น "กลยุทธ์" แล้วในไฟล์เป็น "กลยุทธ" (วรรณยุกต์/การันต์หาย)
// นับความต่างเป็นจำนวนตัวอักษรที่ต้อง เพิ่ม / ลบ / เปลี่ยน เพื่อให้เหมือนกัน

const MAX_PATTERN = 32;                   // วิธีที่ใช้เก็บสถานะไว้ในเลข 32 บิต คำค้นที่ยาวกว่านี้ดูแค่ 32 ตัวแรก
const masks = new Int32Array(65536);      // ตัวอักษร → ตำแหน่งที่ตัวนั้นอยู่ในคำค้น (ใช้ซ้ำทุกครั้ง ล้างเมื่อเสร็จ)

// คำค้นคำนี้ยอมให้ต่างได้กี่ตัวอักษร
//   คำสั้นไม่ยอมเลย (ไม่งั้นเจอมั่วไปหมด)  ตัวเลขล้วนก็ไม่ยอม (เลขต่างกันหนึ่งหลักคือคนละเอกสาร)
export function allowance(term) {
  if (!/\p{L}/u.test(term)) return 0;
  return term.length < 5 ? 0 : term.length < 9 ? 1 : 2;
}

// หาตำแหน่งใน low ที่ใกล้เคียงคำค้น pat มากที่สุด โดยต่างได้ไม่เกิน k ตัวอักษร
// คืน { errors, start, end } (end ไม่รวม) หรือ null ถ้าไม่มี
export function nearest(low, pat, k) {
  const exact = low.indexOf(pat);
  if (exact >= 0) return { errors: 0, start: exact, end: exact + pat.length };
  if (!k || low.length < pat.length - k) return null;

  // ไล่อ่านข้อความทีละตัว เก็บไว้ว่าตอนนี้ "ต้นคำค้นยาวเท่าไรบ้าง" ที่ตรงกับท้ายข้อความ โดยผิดไม่เกิน d ตัว (R[d])
  const p = pat.length > MAX_PATTERN ? pat.slice(0, MAX_PATTERN) : pat;
  const m = p.length, top = 1 << (m - 1);
  for (let i = 0; i < m; i++) masks[p.charCodeAt(i)] |= 1 << i;
  const R = [0, 1, 3];
  let limit = k, best = -1, bestEnd = -1;
  for (let i = 0; i < low.length; i++) {
    const mask = masks[low.charCodeAt(i)];
    let prevOld = R[0];
    let cur = ((prevOld << 1) | 1) & mask;
    R[0] = cur;
    let prevNew = cur;
    for (let d = 1; d <= limit; d++) {
      const old = R[d];
      // ตรงกัน | ข้อความมีตัวเกิน | ตัวอักษรต่างกัน หรือ ข้อความขาดไปหนึ่งตัว
      cur = (((old << 1) | 1) & mask) | prevOld | ((prevOld | prevNew) << 1) | 1;
      R[d] = cur;
      prevOld = old;
      prevNew = cur;
    }
    if (R[limit] & top) {                 // เจอแล้ว: จำไว้ แล้วหาต่อเฉพาะที่ผิดน้อยกว่านี้
      let d = limit;
      while (d > 0 && (R[d - 1] & top)) d--;
      best = d;
      bestEnd = i;
      if (d === 0) break;
      limit = d - 1;
    }
  }
  for (let i = 0; i < m; i++) masks[p.charCodeAt(i)] = 0;
  if (best < 0) return null;

  // คำค้นที่ตัวท้ายเป็นพยัญชนะ/สระเต็มตัว: ถ้าขยับท้ายไปอีกตัวแล้วยังผิดเท่าเดิม ให้เอาตัวนั้นด้วย
  // เช่น ค้น "งบประมาน" เจอ "งบประมาณ" จะได้แถบสีครบทั้งคำ ไม่ใช่แค่ "งบประมา"
  // (ถ้าตัวท้ายของคำค้นเป็นวรรณยุกต์/การันต์ เช่น "กลยุทธ์" เจอ "กลยุทธ" ไม่ต้องขยับ)
  let last = bestEnd, start = startOf(low, p, last, best).start;
  while (last + 1 < low.length && last - bestEnd < best && !isThaiMark(p.charCodeAt(m - 1)) &&
         /\p{L}/u.test(low[last + 1]) && !/[เ-ไ]/.test(low[last + 1])) {      // สระหน้า (เ แ โ ใ ไ) คือต้นคำถัดไป ไม่เอา
    const wider = startOf(low, p, last + 1, best);
    if (wider.errors !== best) break;
    last++;
    start = wider.start;
  }
  let end = last + 1;
  while (end < low.length && isThaiMark(low.charCodeAt(end))) end++;    // สระบน/ล่างและวรรณยุกต์ที่เกาะตัวท้ายอยู่ เอามาด้วย แถบสีจะไม่ตัดกลางตัวอักษร
  while (start < end && /\s/.test(low[start])) start++;       // ไม่เอาช่องว่างที่ติดมาหัวท้าย
  while (end > start && /\s/.test(low[end - 1])) end--;
  return { errors: best, start, end };
}

// สระบน/ล่าง วรรณยุกต์ การันต์ (ตัวที่เกาะอยู่กับพยัญชนะ)
const isThaiMark = (code) => code === 0x0e31 || (code >= 0x0e34 && code <= 0x0e3a) || (code >= 0x0e47 && code <= 0x0e4e);

// รู้ตำแหน่งท้ายของคำที่เจอแล้ว หาว่าคำนั้นเริ่มตรงไหน (เทียบย้อนจากท้ายมาหาหัว)
// คืน { start, errors } ของจุดเริ่มที่ผิดน้อยที่สุด
function startOf(low, p, end, errors) {
  const m = p.length;
  const w = end - Math.max(0, end - m - errors + 1) + 1;       // ดูย้อนกลับไปไม่เกินกี่ตัวอักษร
  let prev = new Array(w + 1), cur = new Array(w + 1);
  for (let j = 0; j <= w; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const pc = p.charCodeAt(m - i);
    for (let j = 1; j <= w; j++) {
      const cost = low.charCodeAt(end - j + 1) === pc ? 0 : 1;
      cur[j] = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  let bestLen = 1;
  for (let j = 2; j <= w; j++) {
    if (prev[j] < prev[bestLen] || (prev[j] === prev[bestLen] && Math.abs(j - m) < Math.abs(bestLen - m))) bestLen = j;
  }
  return { start: end - bestLen + 1, errors: prev[bestLen] };
}
