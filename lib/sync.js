// Keeps this browser's vault and the copy in Google Drive in step.
// Config lives in storage.local under `sync`: { clientId, email, status, message, lastSync }.
// status: 'ok' | 'signin' (Google needs you to sign in again) | 'password' | 'error'.

import * as vault from './vault.js';
import * as drive from './gdrive.js';

let running = null;
let queued = null;

export async function getConfig() {
  const { sync } = await browser.storage.local.get('sync');
  return sync ?? null;
}

// Re-reads before writing so a sync finishing late can't undo a sign-out.
async function updateConfig(patch) {
  const config = await getConfig();
  if (config) await browser.storage.local.set({ sync: { ...config, ...patch } });
}

function statusOf(err) {
  if (err instanceof drive.SignInRequiredError) return 'signin';
  if (err instanceof vault.NeedsPasswordError) return 'password';
  return 'error';
}

// Returns 'off' | 'locked' | 'ok' | 'updated' (this browser received changes) | a problem status.
// A request made mid-sync gets one more run afterwards, since the running one may have
// read the vault before the change that prompted the request.
export function syncNow() {
  if (!running) {
    running = run().finally(() => {
      running = null;
    });
    return running;
  }
  queued ??= running.then(() => {
    queued = null;
    return syncNow();
  });
  return queued;
}

async function run() {
  const config = await getConfig();
  if (!config) return 'off';
  if ((await vault.getState()) !== 'unlocked') return 'locked';
  try {
    let updated = false;
    const remote = await drive.download(config);
    if (!remote) {
      await drive.upload(config, await vault.getVaultBlob());
    } else {
      const { blob, changedLocal, needsUpload } = await vault.mergeRemote(remote);
      if (needsUpload) await drive.upload(config, blob);
      updated = changedLocal;
    }
    await updateConfig({ status: 'ok', message: '', lastSync: Date.now() });
    return updated ? 'updated' : 'ok';
  } catch (err) {
    const status = statusOf(err);
    await updateConfig({ status, message: err.message });
    return status;
  }
}

// Interactive Google sign-in. Must be started from a click in a full tab (not the popup,
// which closes as soon as the Google window takes focus).
export async function connect(clientId) {
  const account = { clientId };
  await drive.signIn(account, true);
  const email = await drive.getEmail(account);
  await browser.storage.local.set({ sync: { clientId, email, status: 'ok', message: '', lastSync: 0 } });
}

export async function reconnect() {
  const config = await getConfig();
  await drive.signIn(config, true);
  await updateConfig({ status: 'ok', message: '' });
  return syncNow();
}

// For a fresh install: signs in and fetches the vault from Drive, if there is one.
export async function fetchForRestore(clientId) {
  await connect(clientId);
  return drive.download(await getConfig());
}

// Resolves 'password' status: the Drive vault's password unlocks it and becomes this browser's too.
export async function adoptWithPassword(password) {
  const config = await getConfig();
  const remote = await drive.download(config);
  if (!remote) return syncNow().then(() => true);
  if (!(await vault.adoptRemote(remote, password))) return false;
  await syncNow();
  return true;
}

// After a password change Drive must take this browser's copy as-is; other computers
// will then ask for the new password once.
export async function replaceRemote() {
  const config = await getConfig();
  if (!config) return;
  try {
    await syncNow();
    await drive.upload(config, await vault.getVaultBlob());
    await updateConfig({ status: 'ok', message: '', lastSync: Date.now() });
  } catch (err) {
    await updateConfig({ status: statusOf(err), message: err.message });
  }
}

export async function disconnect({ deleteRemote }) {
  const config = await getConfig();
  if (config && deleteRemote) await drive.removeFile(config);
  await drive.signOut();
  await browser.storage.local.remove('sync');
}
