// db.js — ฐานข้อมูลในเบราว์เซอร์ (IndexedDB) เก็บรายการโฟลเดอร์และดัชนีข้อความ
// ข้อมูลอยู่ในเครื่องของผู้ใช้เท่านั้น แยกกันตามเบราว์เซอร์และตามเว็บ

const DB_NAME = "file-search";

let dbPromise = null;

export function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("folders", { keyPath: "id" });           // โฟลเดอร์ที่ผู้ใช้เพิ่มไว้
      const files = db.createObjectStore("files", { keyPath: "key" }); // ข้อความของแต่ละไฟล์
      files.createIndex("folderId", "folderId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function getAll(store) {
  return done((await openDb()).transaction(store).objectStore(store).getAll());
}

export async function put(store, value) {
  return done((await openDb()).transaction(store, "readwrite").objectStore(store).put(value));
}

export async function remove(store, key) {
  return done((await openDb()).transaction(store, "readwrite").objectStore(store).delete(key));
}

// ลบหลายรายการในครั้งเดียว
export async function removeMany(store, keys) {
  if (!keys.length) return;
  const tx = (await openDb()).transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const key of keys) os.delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
