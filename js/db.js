// db.js — IndexedDB data layer for Travel Memories
// Designed to be sync-ready (Supabase later): every record has a UUID id,
// updatedAt timestamp, and a soft-delete flag so a future sync engine can
// reconcile changes across devices without losing data.

const DB_NAME = 'travel-memories';
const DB_VERSION = 1;
const STORE_MEMORIES = 'memories';
const STORE_PHOTOS = 'photos';

// ---- id helper -------------------------------------------------------------
function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---- connection ------------------------------------------------------------
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_MEMORIES)) {
        const store = db.createObjectStore(STORE_MEMORIES, { keyPath: 'id' });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('deleted', 'deleted', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        // Photos stored as Blobs, keyed by their own id, linked to a memory.
        const pstore = db.createObjectStore(STORE_PHOTOS, { keyPath: 'id' });
        pstore.createIndex('memoryId', 'memoryId', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(storeNames, mode) {
  return openDB().then((db) => {
    const t = db.transaction(storeNames, mode);
    return t;
  });
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Memories CRUD ---------------------------------------------------------

// Create or update a memory. Accepts a plain object; fills in id/timestamps.
async function saveMemory(memory) {
  const now = new Date().toISOString();
  const record = {
    id: memory.id || uuid(),
    title: memory.title || '',
    date: memory.date || now.slice(0, 10),
    place: memory.place || '',
    lat: memory.lat ?? null,
    lng: memory.lng ?? null,
    memo: memory.memo || '',
    rating: memory.rating ?? 0,
    tags: Array.isArray(memory.tags) ? memory.tags : [],
    photoIds: Array.isArray(memory.photoIds) ? memory.photoIds : [],
    createdAt: memory.createdAt || now,
    updatedAt: now,
    deleted: memory.deleted ? 1 : 0,
  };

  const t = await tx(STORE_MEMORIES, 'readwrite');
  const store = t.objectStore(STORE_MEMORIES);
  await reqAsPromise(store.put(record));
  return record;
}

// Get one memory by id.
async function getMemory(id) {
  const t = await tx(STORE_MEMORIES, 'readonly');
  return reqAsPromise(t.objectStore(STORE_MEMORIES).get(id));
}

// List all non-deleted memories, newest date first.
async function listMemories() {
  const t = await tx(STORE_MEMORIES, 'readonly');
  const all = await reqAsPromise(t.objectStore(STORE_MEMORIES).getAll());
  return all
    .filter((m) => !m.deleted)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// Soft-delete: keep the record but mark deleted so sync can propagate it.
async function deleteMemory(id) {
  const existing = await getMemory(id);
  if (!existing) return;
  existing.deleted = 1;
  existing.updatedAt = new Date().toISOString();
  const t = await tx(STORE_MEMORIES, 'readwrite');
  await reqAsPromise(t.objectStore(STORE_MEMORIES).put(existing));
  // Photos are kept until a real purge; harmless for a local MVP.
}

// ---- Photos ----------------------------------------------------------------

// Store a photo Blob, return its generated id.
async function savePhoto(memoryId, blob) {
  const record = { id: uuid(), memoryId, blob, updatedAt: new Date().toISOString() };
  const t = await tx(STORE_PHOTOS, 'readwrite');
  await reqAsPromise(t.objectStore(STORE_PHOTOS).put(record));
  return record.id;
}

// Get a photo Blob by id.
async function getPhoto(id) {
  const t = await tx(STORE_PHOTOS, 'readonly');
  const rec = await reqAsPromise(t.objectStore(STORE_PHOTOS).get(id));
  return rec ? rec.blob : null;
}

// Delete a photo by id.
async function deletePhoto(id) {
  const t = await tx(STORE_PHOTOS, 'readwrite');
  await reqAsPromise(t.objectStore(STORE_PHOTOS).delete(id));
}

// ---- Export / Import (handy before sync exists) ----------------------------

// Export everything (memories only; photos are large, exported as base64).
async function exportAll() {
  const memories = await listMemories();
  const out = [];
  for (const m of memories) {
    const photos = [];
    for (const pid of m.photoIds) {
      const blob = await getPhoto(pid);
      if (blob) photos.push({ id: pid, dataUrl: await blobToDataUrl(blob) });
    }
    out.push({ ...m, photos });
  }
  return { version: DB_VERSION, exportedAt: new Date().toISOString(), memories: out };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

window.TMDB = {
  uuid,
  saveMemory,
  getMemory,
  listMemories,
  deleteMemory,
  savePhoto,
  getPhoto,
  deletePhoto,
  exportAll,
};
