// The vault: your accounts, encrypted with your master password.
//
// - storage.local holds only ciphertext (AES-256-GCM). The key comes from your password via
//   PBKDF2-SHA256 with 600,000 iterations, so guessing passwords offline is slow.
// - After you unlock, the derived key sits in storage.session, which Firefox keeps in memory
//   only. It never reaches disk and disappears when the browser closes, or sooner via auto-lock.

const FORMAT = 'authtab-vault';
const ITERATIONS = 600_000;
const DEFAULT_SETTINGS = { autoLockMinutes: 15 };

const store = browser.storage;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class LockedError extends Error {
  constructor() {
    super('AuthTab is locked');
    this.name = 'LockedError';
  }
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function newKdf() {
  return { name: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) };
}

async function deriveKey(password, kdf) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(kdf.salt), iterations: kdf.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key, kdf, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  return { format: FORMAT, version: 1, kdf, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

async function unseal(key, blob) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(blob.iv) }, key, fromBase64(blob.data));
  return JSON.parse(decoder.decode(plain));
}

// Returns { key, payload }, or null when the password is wrong.
async function openWithPassword(blob, password) {
  const key = await deriveKey(password, blob.kdf);
  try {
    return { key, payload: await unseal(key, blob) };
  } catch {
    return null;
  }
}

async function readVault() {
  const { vault } = await store.local.get('vault');
  return vault ?? null;
}

async function startSession(key) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  await store.session.set({ session: { key: toBase64(raw), lastActive: Date.now() } });
}

async function sessionKey() {
  const { session } = await store.session.get('session');
  if (!session) return null;
  const { autoLockMinutes } = await getSettings();
  if (autoLockMinutes > 0 && Date.now() - session.lastActive > autoLockMinutes * 60_000) {
    await lock();
    return null;
  }
  return crypto.subtle.importKey('raw', fromBase64(session.key), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

export async function getSettings() {
  const { settings } = await store.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function setSettings(patch) {
  await store.local.set({ settings: { ...(await getSettings()), ...patch } });
}

// 'new' (no vault yet) | 'locked' | 'unlocked'
export async function getState() {
  if (!(await readVault())) return 'new';
  return (await sessionKey()) ? 'unlocked' : 'locked';
}

// Resets the auto-lock timer, but never revives a session that has already expired.
export async function touch() {
  if (!(await sessionKey())) return;
  const { session } = await store.session.get('session');
  await store.session.set({ session: { ...session, lastActive: Date.now() } });
}

export async function lock() {
  await store.session.remove('session');
}

export async function createVault(password) {
  const kdf = newKdf();
  const key = await deriveKey(password, kdf);
  await store.local.set({ vault: await seal(key, kdf, { accounts: [] }) });
  await startSession(key);
}

export async function unlock(password) {
  const blob = await readVault();
  if (!blob) return false;
  const opened = await openWithPassword(blob, password);
  if (!opened) return false;
  await startSession(opened.key);
  return true;
}

export async function loadAccounts() {
  const key = await sessionKey();
  if (!key) throw new LockedError();
  return (await unseal(key, await readVault())).accounts;
}

export async function saveAccounts(accounts) {
  const key = await sessionKey();
  if (!key) throw new LockedError();
  const blob = await readVault();
  await store.local.set({ vault: await seal(key, blob.kdf, { accounts }) });
  await touch();
}

export async function changePassword(current, next) {
  const opened = await openWithPassword(await readVault(), current);
  if (!opened) return false;
  const kdf = newKdf();
  const key = await deriveKey(next, kdf);
  await store.local.set({ vault: await seal(key, kdf, opened.payload) });
  await startSession(key);
  return true;
}

// A backup is just the vault blob, so it stays encrypted with the master password.
export async function exportBackup() {
  if (!(await sessionKey())) throw new LockedError();
  return { ...(await readVault()), exportedAt: new Date().toISOString() };
}

export function isBackup(data) {
  return data?.format === FORMAT && typeof data.kdf?.salt === 'string' && typeof data.iv === 'string' && typeof data.data === 'string';
}

// Returns the backup's accounts, or null when the password is wrong.
export async function decryptBackup(data, password) {
  const opened = await openWithPassword(data, password);
  return opened ? opened.payload.accounts : null;
}

export async function erase() {
  await store.local.remove('vault');
  await lock();
}
