// auth.js — ล็อกอินด้วย LINE และ Google
// ล็อกอินแล้วเว็บได้ "ชื่อที่แสดง" กับ "รูปโปรไฟล์" มาแสดงบนหน้า และจำไว้ในเบราว์เซอร์เครื่องนี้
// เฉพาะการล็อกอินด้วย LINE: ถ้าตั้งค่า LOGIN_RECORD_URL ไว้ จะส่งหลักฐานการล็อกอินไปให้ฟังก์ชันบน Supabase
// (supabase/functions/line-login) ซึ่งตรวจกับ LINE แล้วบันทึกรหัสผู้ใช้ ชื่อ รูป และเวลาเข้าใช้ ลงตาราง line_users
// ข้อควรรู้: นี่ไม่ใช่ระบบกั้นสิทธิ์ ใครเปิดลิงก์ก็ยังใช้เว็บได้โดยไม่ล็อกอิน (โค้ดอยู่ฝั่งผู้ใช้ทั้งหมด จึงกั้นจริงไม่ได้)
//
// ต้องตั้งค่าก่อนใช้ (เจ้าของเว็บสร้างเองในหน้าของผู้ให้บริการ แล้วนำรหัสมาใส่ตรงนี้ รหัสสองตัวนี้เปิดเผยได้ ไม่ใช่ความลับ):
//   GOOGLE_CLIENT_ID : Google Cloud Console > APIs & Services > Credentials > OAuth client ID (ชนิด Web application)
//                      ใส่ที่อยู่เว็บใน Authorized JavaScript origins เช่น https://burapa-software.github.io
//   LINE_LIFF_ID     : LINE Developers Console > ช่อง LINE Login > LIFF > Add  ใส่ที่อยู่เว็บเต็มเป็น Endpoint URL
//   LOGIN_RECORD_URL : ที่อยู่ของ Edge Function เช่น https://<โปรเจกต์>.supabase.co/functions/v1/line-login
//                      เว้นว่าง = ไม่บันทึกอะไรลงฐานข้อมูล  (LIFF ต้องเปิด scope "openid" ด้วย จึงจะได้หลักฐานการล็อกอิน)
const GOOGLE_CLIENT_ID = "";
const LINE_LIFF_ID = "2011973350-3eXaYD2f";
const LOGIN_RECORD_URL = "";

const KEY = "account";          // { provider: "line" | "google", name, picture }
const PENDING = "line-login";   // ตั้งไว้ก่อนเด้งไปหน้า LINE จะได้รู้ว่าต้องทำต่อเมื่อเด้งกลับมา

export const configured = { google: !!GOOGLE_CLIENT_ID, line: !!LINE_LIFF_ID, record: !!LOGIN_RECORD_URL };

export function currentUser() {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch (e) {
    return null;
  }
}

function setUser(user) {
  localStorage.setItem(KEY, JSON.stringify(user));
  return user;
}

// โหลดตัวช่วยของผู้ให้บริการเมื่อผู้ใช้กดล็อกอินเท่านั้น คนที่ไม่ล็อกอินจะไม่มีการติดต่อ Google หรือ LINE เลย
const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const tag = Object.assign(document.createElement("script"), { src, onload: resolve });
      tag.onerror = () => { scripts.delete(src); reject(new Error("โหลดตัวช่วยล็อกอินไม่สำเร็จ ตรวจการเชื่อมต่ออินเทอร์เน็ต")); };
      document.head.append(tag);
    }));
  }
  return scripts.get(src);
}

// Google: เปิดหน้าต่างเลือกบัญชี แล้วขอชื่อกับรูปโปรไฟล์
export async function loginGoogle() {
  if (!configured.google) throw new Error("ยังไม่ได้ตั้งค่าการล็อกอินด้วย Google (เจ้าของเว็บต้องใส่ Client ID ก่อน)");
  await loadScript("https://accounts.google.com/gsi/client");
  const token = await new Promise((resolve, reject) => {
    window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: "openid profile",
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r.access_token)),
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "ปิดหน้าต่างล็อกอินก่อนเสร็จ" : e.message || e.type)),
    }).requestAccessToken();
  });
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("อ่านข้อมูลบัญชี Google ไม่สำเร็จ");
  const info = await res.json();
  return setUser({ provider: "google", name: info.name || "ผู้ใช้ Google", picture: info.picture || "" });
}

async function line() {
  await loadScript("https://static.line-scdn.net/liff/edge/2/sdk.js");
  await window.liff.init({ liffId: LINE_LIFF_ID });
  return window.liff;
}

// LINE: เด้งไปหน้าล็อกอินของ LINE แล้วเด้งกลับมาหน้านี้ (ทำต่อใน resumeLogin)  คืน null เมื่อกำลังเด้งออกไป
export async function loginLine() {
  if (!configured.line) throw new Error("ยังไม่ได้ตั้งค่าการล็อกอินด้วย LINE (เจ้าของเว็บต้องใส่ LIFF ID ก่อน)");
  const liff = await line();
  if (!liff.isLoggedIn()) {
    localStorage.setItem(PENDING, "1");
    liff.login({ redirectUri: location.href });
    return null;
  }
  const profile = await liff.getProfile();
  const user = setUser({ provider: "line", name: profile.displayName || "ผู้ใช้ LINE", picture: profile.pictureUrl || "" });
  if (LOGIN_RECORD_URL) await recordLogin(liff.getIDToken());
  return user;
}

// ส่งหลักฐานการล็อกอิน (ID token ที่ LINE ออกให้) ไปให้ฟังก์ชันบน Supabase บันทึก
// ส่งเฉพาะ token ไม่ส่งชื่อหรือรหัสผู้ใช้เอง ฟังก์ชันจะถาม LINE โดยตรง หน้าเว็บจึงปลอมเป็นคนอื่นไม่ได้
async function recordLogin(idToken) {
  let ok = false;
  try {
    const res = await fetch(LOGIN_RECORD_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
    ok = res.ok;
  } catch (e) { /* เน็ตหลุด หรือฟังก์ชันไม่ตอบ */ }
  if (!ok) throw new Error("เข้าสู่ระบบแล้ว แต่บันทึกลงฐานข้อมูลไม่สำเร็จ ลองออกจากระบบแล้วเข้าใหม่");
}

// เรียกตอนเปิดหน้า: ถ้าเพิ่งเด้งกลับมาจากหน้าล็อกอินของ LINE ให้ทำต่อจนได้ชื่อผู้ใช้
export async function resumeLogin() {
  if (!localStorage.getItem(PENDING)) return currentUser();
  localStorage.removeItem(PENDING);
  const liff = await line();
  return liff.isLoggedIn() ? loginLine() : currentUser();
}

export function logout() {
  const user = currentUser();
  localStorage.removeItem(KEY);
  if (user && user.provider === "line" && window.liff && window.liff.isLoggedIn()) window.liff.logout();
}
