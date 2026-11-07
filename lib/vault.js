// The vault: your accounts, encrypted with your master password.
//
// - storage.local holds only ciphertext (AES-256-GCM). The key comes from your password via
//   PBKDF2-SHA256 with 600,000 iterations, so guessing passwords offline is slow.
// - After you unlock, the derived key sits in storage.session, which Firefox keeps in memory
//   only. It never reaches disk and disappears when the browser closes, or sooner via auto-lock.

import { mergePayloads, normalizePayload, samePayload, stampChanges } from './merge.js';

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

export class NeedsPasswordError extends Error {
  constructor() {
    super('The vault in Google Drive uses a different master password');
    this.name = 'NeedsPasswordError';
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
  return normalizePayload(await unseal(key, await readVault())).accounts;
}

export async function saveAccounts(accounts) {
  const key = await sessionKey();
  if (!key) throw new LockedError();
  const blob = await readVault();
  const previous = normalizePayload(await unseal(key, blob));
  await store.local.set({ vault: await seal(key, blob.kdf, stampChanges(previous, accounts)) });
  await touch();
}

export function getVaultBlob() {
  return readVault();
}

// Merges the vault from Google Drive into this one. Throws NeedsPasswordError when the
// Drive copy was encrypted with a different password (e.g. set up separately elsewhere).
export async function mergeRemote(remoteBlob) {
  const key = await sessionKey();
  if (!key) throw new LockedError();
  const localBlob = await readVault();
  if (remoteBlob.kdf?.salt !== localBlob.kdf.salt) throw new NeedsPasswordError();

  const local = normalizePayload(await unseal(key, localBlob));
  let remote;
  try {
    remote = normalizePayload(await unseal(key, remoteBlob));
  } catch {
    throw new NeedsPasswordError();
  }

  const merged = mergePayloads(local, remote);
  const changedLocal = !samePayload(merged, local);
  const blob = changedLocal ? await seal(key, localBlob.kdf, merged) : localBlob;
  if (changedLocal) await store.local.set({ vault: blob });
  return { blob, changedLocal, needsUpload: !samePayload(merged, remote) };
}

// Opens the Drive vault with its password, folds in anything from this browser, and
// re-encrypts everything under the Drive vault's key so both sides share one password.
// Also used to restore onto a fresh install, where there's no local vault yet.
export async function adoptRemote(remoteBlob, password) {
  const opened = await openWithPassword(remoteBlob, password);
  if (!opened) return false;

  let payload = normalizePayload(opened.payload);
  const localBlob = await readVault();
  if (localBlob) {
    const key = await sessionKey();
    if (!key) throw new LockedError();
    payload = mergePayloads(normalizePayload(await unseal(key, localBlob)), payload);
  }
  await store.local.set({ vault: await seal(opened.key, remoteBlob.kdf, payload) });
  await startSession(opened.key);
  return true;
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
  return opened ? normalizePayload(opened.payload).accounts : null;
}

export async function erase() {
  await store.local.remove('vault');
  await lock();
}
