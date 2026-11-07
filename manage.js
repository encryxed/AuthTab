import * as vault from './lib/vault.js';
import * as sync from './lib/sync.js';
import * as drive from './lib/gdrive.js';
import { makeAccount } from './lib/otp.js';
import { parseText } from './lib/migration.js';
import { decodeImage, UnreadableImageError } from './lib/qr.js';

const $ = (id) => document.getElementById(id);

let accounts = [];
let pending = [];              // { account, selected, duplicate }
let importErrors = [];
const seenCodes = new Set();   // QR/link texts already handled, so the webcam doesn't re-add them
const batches = new Map();     // batch id -> { size, seen: Set<index> }
let restoreData = null;
let stream = null;
let toastTimer;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function labelOf(account) {
  return account.issuer || account.name || 'Unnamed';
}

const keyOf = (account) => `${account.type}:${account.secret}`;

function show(view) {
  for (const name of ['setup', 'locked', 'main']) $(`view-${name}`).hidden = name !== view;
  $('lockBtn').hidden = view !== 'main';
}

// The form's own submit button, also when the form was submitted without a click.
function submitButton(event) {
  return event.submitter ?? event.target.querySelector('button[type="submit"]');
}

async function busy(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// Runs a vault operation; if the vault locked itself meanwhile, drop back to the unlock screen.
async function withVault(task) {
  try {
    await task();
    return true;
  } catch (err) {
    if (err instanceof vault.LockedError) {
      toast('🔒 AuthTab locked itself. Unlock to continue');
      await init();
    } else {
      console.error(err);
      toast(`⚠️ ${err.message}`);
    }
    return false;
  }
}

// Always re-read before writing, so changes made from the popup aren't overwritten.
function mutate(change) {
  return withVault(async () => {
    accounts = await vault.loadAccounts();
    change(accounts);
    await vault.saveAccounts(accounts);
    renderAccounts();
    runSync();
  });
}

async function init() {
  const state = await vault.getState();
  if (state === 'new') {
    show('setup');
    $('newPassword').focus();
  } else if (state === 'locked') {
    stopCamera();
    accounts = [];
    show('locked');
    $('password').focus();
  } else {
    await showMain();
  }
}

async function showMain() {
  accounts = await vault.loadAccounts();
  renderAccounts();
  renderPreview();
  $('autoLock').value = String((await vault.getSettings()).autoLockMinutes);
  show('main');
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  runSync();
}

// ---------- Setup & unlock ----------

$('setupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('newPassword').value;
  $('setupError').textContent = '';
  if (password.length < 8) return void ($('setupError').textContent = 'Use at least 8 characters.');
  if (password !== $('confirmPassword').value) return void ($('setupError').textContent = "Those passwords don't match.");
  await busy($('setupBtn'), 'Creating…', () => vault.createVault(password));
  $('setupForm').reset();
  await showMain();
  $('import').scrollIntoView();
  toast('🎉 Vault created. Now bring your codes over!');
});

$('unlockForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('unlockError').textContent = '';
  const ok = await busy($('unlockBtn'), 'Unlocking…', () => vault.unlock($('password').value));
  if (ok) {
    $('password').value = '';
    await showMain();
  } else {
    $('unlockError').textContent = 'Wrong password 🙅';
    $('password').select();
  }
});

$('lockBtn').addEventListener('click', async () => {
  await vault.lock();
  await init();
});

// ---------- Import ----------

// `quiet` is for the webcam, which sees the same QR code many times a second.
function handleText(text, source, { quiet = false } = {}) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (seenCodes.has(trimmed)) {
    if (!quiet) {
      toast('👀 Already read that one. Its accounts are in the list below');
      $('preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return 0;
  }
  seenCodes.add(trimmed);

  const result = parseText(trimmed);
  for (const batch of result.batches) {
    const entry = batches.get(batch.id) ?? { size: batch.size, seen: new Set() };
    entry.seen.add(batch.index);
    batches.set(batch.id, entry);
  }
  importErrors.push(...result.errors);
  const added = addPending(result.accounts);
  renderPreview();

  if (added) {
    toast(`✨ Found ${plural(added, 'account')} in ${source}`);
    $('preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else if (result.errors.length) {
    toast(`⚠️ ${result.errors[0]}`);
  } else {
    toast('👍 You already have those accounts');
  }
  return added;
}

// Queues accounts for the preview; returns how many are genuinely new (not already saved).
function addPending(found) {
  const existing = new Set(accounts.map(keyOf));
  const queued = new Set(pending.map((item) => keyOf(item.account)));
  let fresh = 0;
  for (const account of found) {
    const key = keyOf(account);
    if (queued.has(key)) continue;
    queued.add(key);
    const duplicate = existing.has(key);
    pending.push({ account, duplicate, selected: !duplicate });
    if (!duplicate) fresh++;
  }
  return fresh;
}

function renderPreview() {
  $('preview').hidden = pending.length === 0 && importErrors.length === 0;
  $('previewTitle').textContent = pending.length ? `Found ${plural(pending.length, 'account')} ✨` : 'Nothing imported';

  $('pendingList').replaceChildren(
    ...pending.map((item) => {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.selected;
      box.addEventListener('change', () => {
        item.selected = box.checked;
        updateCommit();
      });
      const label = el('label');
      label.append(box, el('span', 'issuer', labelOf(item.account)));
      if (item.account.issuer && item.account.name) label.append(el('span', 'name', item.account.name));
      if (item.duplicate) label.append(el('span', 'tag', 'already added'));
      else if (item.account.type === 'hotp') label.append(el('span', 'tag', 'counter-based'));
      const li = el('li');
      li.append(label);
      return li;
    }),
  );

  $('importErrors').replaceChildren(...[...new Set(importErrors)].map((message) => el('li', '', message)));

  const missing = [...batches.values()].filter((batch) => batch.seen.size < batch.size);
  $('batchNotice').hidden = missing.length === 0;
  if (missing.length) {
    const { size, seen } = missing[0];
    $('batchNotice').textContent = `📦 This export is split into ${size} QR codes and you've scanned ${seen.size}. Tap Next in Google Authenticator and add the rest too.`;
  }
  updateCommit();
}

function updateCommit() {
  const count = pending.filter((item) => item.selected).length;
  $('commitBtn').disabled = count === 0;
  $('commitBtn').textContent = count ? `Add ${plural(count, 'account')}` : 'Nothing selected';
}

function resetImport() {
  pending = [];
  importErrors = [];
  batches.clear();
  seenCodes.clear();
  renderPreview();
}

$('commitBtn').addEventListener('click', async () => {
  const chosen = pending.filter((item) => item.selected).map((item) => item.account);
  if (await mutate((list) => list.push(...chosen))) {
    resetImport();
    stopCamera();
    toast(`🎉 Added ${plural(chosen.length, 'account')}. Click the AuthTab toolbar icon to see the codes`);
  }
});

$('discardBtn').addEventListener('click', resetImport);

// Any file is attempted: pasted images and some downloads arrive without a file type.
async function handleFiles(files) {
  if (files.length === 0) {
    toast("📋 That wasn't an image. Copy the QR code picture itself, or a screenshot of it");
    return;
  }
  for (const file of files) {
    if (/^(video|audio|text)\//.test(file.type) || file.type === 'application/pdf') {
      toast(`⚠️ "${file.name}" isn't an image. Use a screenshot or photo of the QR code`);
      continue;
    }
    // Clipboard images get generic names like "image.png"; don't echo those back.
    const generic = !file.name || /^(image\.\w+|pasted image)$/i.test(file.name);
    const label = generic ? 'the image' : `"${file.name}"`;
    dropZone.classList.add('reading');
    toast('🔍 Reading the QR code…');
    try {
      const text = await decodeImage(file, file.name || 'image');
      if (text) handleText(text, label);
      else toast(`😕 No QR code found in ${label}. Try a sharper shot with the whole code in view`);
    } catch (err) {
      toast(`⚠️ ${err instanceof UnreadableImageError ? err.message : `Couldn't read ${label}`}`);
    } finally {
      dropZone.classList.remove('reading');
    }
  }
}

// Text from the clipboard: an otpauth link, an image as a data: URL, or an image's web address.
async function handlePastedText(text) {
  const trimmed = text.trim();
  if (/^data:image\//i.test(trimmed)) {
    const blob = await (await fetch(trimmed)).blob();
    return handleFiles([new File([blob], 'pasted image', { type: blob.type })]);
  }
  if (/^https?:\/\/\S+$/i.test(trimmed) && !/otpauth/i.test(trimmed)) {
    toast('📋 That copied the image\'s address. Right-click the QR code, choose "Copy Image", and paste again');
    return;
  }
  handleText(trimmed, 'the clipboard');
}

$('fileInput').addEventListener('change', async () => {
  await handleFiles([...$('fileInput').files]);
  $('fileInput').value = '';
});

const dropZone = $('dropZone');
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('over');
  const files = [...event.dataTransfer.files];
  // An image dragged from a web page may arrive only as its address.
  if (files.length === 0 && event.dataTransfer.getData('text/plain')) handlePastedText(event.dataTransfer.getData('text/plain'));
  else handleFiles(files);
});

document.addEventListener('paste', (event) => {
  if ($('view-main').hidden) return;
  // clipboardData.items catches images that clipboardData.files misses in some copy sources.
  const files = [...event.clipboardData.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length) {
    event.preventDefault();
    handleFiles(files);
    return;
  }
  if (event.target.closest('input, textarea')) return;
  const text = event.clipboardData.getData('text/plain');
  event.preventDefault();
  if (text) handlePastedText(text);
  else toast('📋 Nothing to paste. Copy the QR code image first');
});

// For when Ctrl+V doesn't reach the page. Firefox may show a small "Paste" button to confirm.
$('pasteBtn').addEventListener('click', async () => {
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch {
    toast('📋 Firefox didn\'t allow reading the clipboard. Click this page and press Ctrl+V instead');
    return;
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return handleFiles([new File([await item.getType(type)], 'pasted image', { type })]);
  }
  for (const item of items) {
    if (item.types.includes('text/plain')) return handlePastedText(await (await item.getType('text/plain')).text());
  }
  toast('📋 Your clipboard is empty. Copy the QR code image first');
});

$('linkBtn').addEventListener('click', () => {
  if (handleText($('linkInput').value, 'the link')) $('linkInput').value = '';
});

// ---------- Webcam ----------

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } });
  } catch (err) {
    toast(`📷 Couldn't open the camera (${err.name})`);
    return;
  }
  const video = $('video');
  video.srcObject = stream;
  await video.play();
  $('cameraBox').hidden = false;
  $('cameraBtn').textContent = '⏹ Stop camera';

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const scan = () => {
    if (!stream) return;
    if (video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      if (hit?.data) handleText(hit.data, 'the camera', { quiet: true });
    }
    setTimeout(scan, 200);
  };
  scan();
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  $('video').srcObject = null;
  $('cameraBox').hidden = true;
  $('cameraBtn').textContent = '📷 Scan with webcam';
}

$('cameraBtn').addEventListener('click', () => (stream ? stopCamera() : startCamera()));

// ---------- Manual entry ----------

$('manualForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('manualError').textContent = '';
  let account;
  try {
    account = makeAccount({
      issuer: $('mIssuer').value,
      name: $('mName').value,
      secret: $('mSecret').value,
      type: $('mType').value,
      digits: $('mDigits').value,
      algorithm: $('mAlgorithm').value,
      period: $('mPeriod').value,
    });
  } catch (err) {
    $('manualError').textContent = err.message;
    return;
  }
  if (accounts.some((existing) => keyOf(existing) === keyOf(account))) {
    $('manualError').textContent = 'You already have an account with that secret key.';
    return;
  }
  if (await mutate((list) => list.push(account))) {
    $('manualForm').reset();
    toast(`✅ Added ${labelOf(account)}`);
  }
});

// ---------- Account list ----------

function textInput(value, placeholder, onSave) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('change', () => onSave(input.value.trim()));
  return input;
}

function iconButton(text, title, disabled, onClick) {
  const button = el('button', 'icon', text);
  button.title = title;
  button.setAttribute('aria-label', title);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function renderAccounts() {
  $('accountCount').textContent = accounts.length ? `(${accounts.length})` : '';
  $('deviceCount').textContent = String(Math.min(accounts.length, 99)).padStart(2, '0');
  $('accountsEmpty').hidden = accounts.length > 0;
  $('accountList').replaceChildren(
    ...accounts.map((account, index) => {
      const fields = el('div', 'fields');
      fields.append(
        textInput(account.issuer, 'Service (e.g. Google)', (issuer) => edit(account.id, { issuer })),
        textInput(account.name, 'Account (e.g. you@gmail.com)', (name) => edit(account.id, { name })),
      );
      const tools = el('div', 'tools');
      tools.append(
        iconButton('↑', 'Move up', index === 0, () => move(account.id, -1)),
        iconButton('↓', 'Move down', index === accounts.length - 1, () => move(account.id, 1)),
        iconButton('Delete', `Delete ${labelOf(account)}`, false, () => remove(account)),
      );
      tools.lastChild.classList.add('delete');
      const li = el('li', 'acct');
      li.append(fields, tools);
      return li;
    }),
  );
}

function edit(id, patch) {
  return mutate((list) => {
    const account = list.find((item) => item.id === id);
    if (account) Object.assign(account, patch);
  });
}

function move(id, direction) {
  return mutate((list) => {
    const from = list.findIndex((item) => item.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
  });
}

async function remove(account) {
  const sure = confirm(
    `Delete ${labelOf(account)}${account.name && account.issuer ? ` (${account.name})` : ''}?\n\n` +
      "Make sure you can still get this code somewhere else (like Google Authenticator on your phone). This can't be undone.",
  );
  if (!sure) return;
  const deleted = await mutate((list) => {
    const index = list.findIndex((item) => item.id === account.id);
    if (index >= 0) list.splice(index, 1);
  });
  if (deleted) toast('🗑️ Deleted');
}

// ---------- Backup ----------

$('exportBtn').addEventListener('click', () =>
  withVault(async () => {
    const backup = await vault.exportBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = el('a');
    link.href = url;
    link.download = `authtab-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('💾 Backup downloaded (encrypted with your master password)');
  }),
);

$('restoreFile').addEventListener('change', async () => {
  const file = $('restoreFile').files[0];
  $('restoreFile').value = '';
  if (!file) return;
  try {
    restoreData = JSON.parse(await file.text());
  } catch {
    restoreData = null;
  }
  if (!vault.isBackup(restoreData)) {
    toast("⚠️ That isn't an AuthTab backup file");
    return;
  }
  $('restoreForm').hidden = false;
  $('restoreError').textContent = '';
  $('restorePassword').focus();
});

$('restoreForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = submitButton(event);
  const found = await busy(button, 'Opening…', () => vault.decryptBackup(restoreData, $('restorePassword').value));
  if (!found) {
    $('restoreError').textContent = 'Wrong password for this backup 🙅';
    return;
  }
  const valid = [];
  for (const account of found) {
    try {
      valid.push(makeAccount(account));
    } catch (err) {
      importErrors.push(err.message);
    }
  }
  const added = addPending(valid);
  $('restoreForm').reset();
  $('restoreForm').hidden = true;
  restoreData = null;
  renderPreview();
  $('import').scrollIntoView();
  toast(added ? `📦 Backup opened: ${plural(added, 'account')} ready to add` : 'Everything in that backup is already here');
});

// ---------- Security ----------

$('autoLock').addEventListener('change', async () => {
  await vault.setSettings({ autoLockMinutes: Number($('autoLock').value) });
  toast('✅ Auto-lock updated');
});

$('passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('passwordError').textContent = '';
  const next = $('nextPassword').value;
  if (next.length < 8) return void ($('passwordError').textContent = 'Use at least 8 characters.');
  if (next !== $('nextPassword2').value) return void ($('passwordError').textContent = "The new passwords don't match.");
  const ok = await busy(submitButton(event), 'Changing…', async () => {
    await sync.syncNow();  // pick up other computers' changes before the key changes
    return vault.changePassword($('currentPassword').value, next);
  });
  if (!ok) return void ($('passwordError').textContent = 'Your current password is wrong.');
  $('passwordForm').reset();
  await sync.replaceRemote();
  await renderSync();
  toast('🔑 Password changed. Download a fresh backup too!');
});

$('eraseBtn').addEventListener('click', async () => {
  if (!confirm('Erase all AuthTab data from this browser?\n\nYour phone, Google Drive and any backup files are not affected.')) return;
  await sync.disconnect({ deleteRemote: false }).catch(() => {});
  await vault.erase();
  resetImport();
  history.replaceState(null, '', location.pathname);
  await init();
  toast('🧹 Erased');
});

// ---------- Google Drive sync ----------

function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(time).toLocaleDateString();
}

const SYNC_PROBLEMS = {
  signin: 'Google signed AuthTab out, so syncing is paused. Sign in again to continue.',
  password:
    'The vault in Google Drive uses a different master password, probably the one from another computer. Enter it to combine both vaults. After that, this browser uses that password too.',
};

async function renderSync(syncing = false) {
  const config = await sync.getConfig();
  $('redirectUri').value = drive.redirectUri();
  $('syncOff').hidden = Boolean(config);
  $('syncOn').hidden = !config;
  if (!config) return;

  $('syncWho').textContent = `Signed in as ${config.email}`;
  $('syncWhen').textContent = syncing ? 'Syncing…' : config.lastSync ? `Last synced ${ago(config.lastSync)}` : 'Not synced yet';
  const problem = syncing ? '' : (SYNC_PROBLEMS[config.status] ?? (config.status === 'error' ? `Sync failed: ${config.message}` : ''));
  $('syncProblem').hidden = !problem;
  $('syncProblem').textContent = problem;
  $('syncPasswordForm').hidden = syncing || config.status !== 'password';
  $('reconnectBtn').hidden = syncing || config.status !== 'signin';
  $('syncNowBtn').disabled = syncing;
}

async function runSync() {
  if (!(await sync.getConfig())) return renderSync();
  await renderSync(true);
  const result = await sync.syncNow();
  if (result === 'updated') {
    accounts = await vault.loadAccounts();
    renderAccounts();
  }
  await renderSync();
}

// Must be the first thing awaited in a click handler: Firefox only shows permission
// prompts in direct response to the click.
function askSyncPermission() {
  return browser.permissions.request({ origins: drive.ORIGINS, data_collection: ['authenticationInfo'] });
}

function googleError(err) {
  return `${err.message}. Check the client ID, and that the redirect URI from the setup steps is added to it exactly.`;
}

$('copyRedirect').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('redirectUri').value);
  toast('📋 Redirect URI copied');
});

$('connectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const clientId = $('clientId').value.trim();
  $('connectError').textContent = '';
  if (!(await askSyncPermission())) {
    $('connectError').textContent = 'Sync needs those permissions. Nothing was changed.';
    return;
  }
  try {
    await busy($('connectBtn'), 'Waiting for Google…', () => sync.connect(clientId));
  } catch (err) {
    $('connectError').textContent = googleError(err);
    return;
  }
  $('connectForm').reset();
  toast('☁️ Signed in. Syncing your vault');
  await runSync();
});

$('reconnectBtn').addEventListener('click', async () => {
  try {
    await sync.reconnect();
  } catch (err) {
    toast(`⚠️ ${err.message}`);
  }
  await runSync();
});

$('syncNowBtn').addEventListener('click', runSync);

$('syncPasswordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('syncPasswordError').textContent = '';
  const ok = await busy(submitButton(event), 'Combining…', () => sync.adoptWithPassword($('syncPassword').value));
  if (!ok) return void ($('syncPasswordError').textContent = "That's not the password for the vault in Google Drive.");
  $('syncPasswordForm').reset();
  accounts = await vault.loadAccounts();
  renderAccounts();
  await renderSync();
  toast('🔗 Vaults combined. Use that master password from now on');
});

$('disconnectBtn').addEventListener('click', async () => {
  const deleteRemote = $('deleteRemote').checked;
  try {
    await sync.disconnect({ deleteRemote });
  } catch (err) {
    toast(`⚠️ Couldn't delete the Drive copy: ${err.message}`);
    return;
  }
  $('deleteRemote').checked = false;
  await renderSync();
  toast(deleteRemote ? '☁️ Sync off. Drive copy deleted' : '☁️ Sync off. Your codes stay in this browser');
});

// Restoring onto a fresh install
let restoreBlob = null;

$('restoreDriveForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const clientId = $('restoreClientId').value.trim();
  $('restoreDriveError').textContent = '';
  if (!(await askSyncPermission())) {
    $('restoreDriveError').textContent = 'Restoring needs those permissions.';
    return;
  }
  try {
    restoreBlob = await busy($('restoreDriveBtn'), 'Waiting for Google…', () => sync.fetchForRestore(clientId));
  } catch (err) {
    $('restoreDriveError').textContent = googleError(err);
    return;
  }
  if (!restoreBlob) {
    $('restoreDriveError').textContent = "There's no AuthTab vault in that Google account yet. Create a new vault above and it will sync there automatically.";
    return;
  }
  $('restoreDriveEmail').textContent = (await sync.getConfig()).email;
  $('restoreDriveForm').hidden = true;
  $('restoreDrivePwForm').hidden = false;
  $('restoreDrivePassword').focus();
});

$('restoreDrivePwForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('restoreDrivePwError').textContent = '';
  const ok = await busy($('restoreDriveUnlock'), 'Restoring…', () => vault.adoptRemote(restoreBlob, $('restoreDrivePassword').value));
  if (!ok) return void ($('restoreDrivePwError').textContent = 'Wrong password for that vault 🙅');
  restoreBlob = null;
  $('restoreDrivePwForm').reset();
  await showMain();
  toast(`🎉 Restored ${plural(accounts.length, 'account')} from Google Drive`);
});

setInterval(() => {
  if (!$('view-main').hidden) runSync();
}, 60_000);

// ---------- Auto-lock while this tab sits open ----------

let lastTouch = 0;
for (const type of ['click', 'keydown']) {
  document.addEventListener(type, () => {
    if (Date.now() - lastTouch > 10_000) {
      lastTouch = Date.now();
      vault.touch();
    }
  });
}

setInterval(async () => {
  if (!$('view-main').hidden && (await vault.getState()) !== 'unlocked') {
    resetImport();
    await init();
  }
}, 5_000);

init();
