import * as vault from './lib/vault.js';
import { hotp, totpCounter, secondsLeft, formatCode } from './lib/otp.js';

const $ = (id) => document.getElementById(id);
const TICKS = 6;

let rows = [];
let ticking = false;
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
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1600);
}

function show(view) {
  for (const name of ['new', 'locked', 'codes']) $(`view-${name}`).hidden = name !== view;
  $('lockBtn').hidden = view !== 'codes';
}

function openManager(hash = '') {
  browser.tabs.create({ url: browser.runtime.getURL(`manage.html${hash}`) });
  window.close();
}

function labelOf(account) {
  return account.issuer || account.name || 'Unnamed';
}

// "123 456" -> "888 888": the unlit segments drawn behind the digits.
function ghostOf(digits) {
  return formatCode('8'.repeat(digits));
}

function buildRow(account) {
  const li = el('li', 'account');
  li.tabIndex = 0;
  li.title = 'Click to copy';

  const meta = el('div', 'meta');
  meta.append(el('span', 'issuer', labelOf(account)));
  if (account.issuer && account.name) meta.append(el('span', 'name', account.name));

  const ghost = ghostOf(account.digits);
  const code = el('span', 'digits', ghost.replace(/8/g, '-'));
  code.dataset.ghost = ghost;
  const lcd = el('span', 'lcd');
  const row = { account, li, code, counter: null, value: '' };
  li.append(meta, lcd);

  if (account.type === 'totp') {
    const ticks = el('span', 'ticks');
    row.ticks = Array.from({ length: TICKS }, () => el('i'));
    ticks.append(...row.ticks);
    lcd.append(ticks, code);
  } else {
    lcd.append(code);
    const next = el('button', 'icon next', '↻');
    next.title = 'Next code';
    next.addEventListener('click', (event) => {
      event.stopPropagation();
      nextHotp(row);
    });
    li.append(next);
  }

  li.addEventListener('click', () => copy(row));
  li.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') copy(row);
  });
  return row;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const row of rows) {
      const { account } = row;
      const counter = account.type === 'totp' ? totpCounter(account, now) : account.counter;
      if (counter !== row.counter) {
        row.counter = counter;
        try {
          row.value = await hotp(account, counter);
          row.code.textContent = formatCode(row.value);
        } catch {
          row.value = '';
          row.code.textContent = 'Err';
        }
      }
      if (row.ticks) {
        const left = secondsLeft(account, now);
        const lit = Math.ceil((left / account.period) * TICKS);
        row.ticks.forEach((tick, index) => tick.classList.toggle('off', index >= lit));
        row.li.classList.toggle('expiring', left <= 5);
        row.li.title = `Click to copy · ${Math.ceil(left)}s left`;
      }
    }
  } finally {
    ticking = false;
  }
}

async function copy(row) {
  if (!row.value) return;
  try {
    await navigator.clipboard.writeText(row.value);
    toast(`📋 Copied ${labelOf(row.account)}`);
  } catch {
    toast("Couldn't copy, try again");
  }
  vault.touch();
}

async function nextHotp(row) {
  try {
    const accounts = await vault.loadAccounts();
    const stored = accounts.find((account) => account.id === row.account.id);
    if (!stored) return;
    stored.counter += 1;
    await vault.saveAccounts(accounts);
    row.account.counter = stored.counter;
    await tick();
  } catch (err) {
    if (err instanceof vault.LockedError) init();
    else toast(`⚠️ ${err.message}`);
  }
}

async function showCodes() {
  const accounts = await vault.loadAccounts();
  rows = accounts.map(buildRow);
  $('list').replaceChildren(...rows.map((row) => row.li));
  $('empty').hidden = rows.length > 0;
  $('search').parentElement.hidden = rows.length === 0;
  show('codes');
  await tick();
  $('search').focus();
  vault.touch();
}

async function init() {
  const state = await vault.getState();
  if (state === 'new') {
    show('new');
  } else if (state === 'locked') {
    rows = [];
    $('list').replaceChildren();
    show('locked');
    $('password').focus();
  } else {
    await showCodes();
  }
}

$('unlockForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('unlockBtn').disabled = true;
  $('unlockBtn').textContent = 'Unlocking…';
  $('unlockError').textContent = '';
  const ok = await vault.unlock($('password').value);
  $('unlockBtn').disabled = false;
  $('unlockBtn').textContent = 'Unlock';
  if (ok) {
    $('password').value = '';
    await showCodes();
  } else {
    $('unlockError').textContent = 'Wrong password 🙅';
    $('password').select();
  }
});

$('search').addEventListener('input', () => {
  const query = $('search').value.trim().toLowerCase();
  for (const row of rows) {
    row.li.hidden = Boolean(query) && !`${row.account.issuer} ${row.account.name}`.toLowerCase().includes(query);
  }
});

$('search').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const first = rows.find((row) => !row.li.hidden);
  if (!first) return;
  await copy(first);
  setTimeout(() => window.close(), 600);
});

$('lockBtn').addEventListener('click', async () => {
  await vault.lock();
  init();
});
$('manageBtn').addEventListener('click', () => openManager());
$('setupBtn').addEventListener('click', () => openManager());
$('importBtn').addEventListener('click', () => openManager('#import'));

setInterval(tick, 250);
init();
