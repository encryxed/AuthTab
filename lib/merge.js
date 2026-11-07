// Combines two copies of the vault: this browser's and the one in Google Drive.
// Every account carries `updatedAt`; deleting one leaves a tombstone in `deleted`
// (id -> time) so a stale copy elsewhere can't bring it back.

const keyOf = (account) => `${account.type}:${account.secret}`;

export function normalizePayload(payload) {
  return { accounts: payload?.accounts ?? [], deleted: payload?.deleted ?? {} };
}

export function mergePayloads(local, remote) {
  const deleted = { ...remote.deleted };
  for (const [id, at] of Object.entries(local.deleted)) deleted[id] = Math.max(at, deleted[id] ?? 0);

  // A Map keeps first-insertion order even when a value is replaced, so this browser's
  // ordering wins and accounts that only exist remotely land at the end.
  const byId = new Map();
  for (const account of [...local.accounts, ...remote.accounts]) {
    const current = byId.get(account.id);
    if (!current || (account.updatedAt ?? 0) > (current.updatedAt ?? 0)) byId.set(account.id, account);
  }

  const seen = new Set();
  const accounts = [];
  for (const account of byId.values()) {
    if ((deleted[account.id] ?? -1) >= (account.updatedAt ?? 0)) continue;
    // The same QR code imported separately on two computers gives two ids for one secret.
    if (seen.has(keyOf(account))) continue;
    seen.add(keyOf(account));
    accounts.push(account);
  }
  return { accounts, deleted };
}

// Stamps `updatedAt` on accounts that changed since `previous`, and tombstones removed ones.
export function stampChanges(previous, accounts, now = Date.now()) {
  const before = new Map(previous.accounts.map((account) => [account.id, account]));
  const comparable = ({ updatedAt, ...rest }) => JSON.stringify(rest);

  const stamped = accounts.map((account) => {
    const old = before.get(account.id);
    const unchanged = old && comparable(old) === comparable(account);
    return { ...account, updatedAt: unchanged ? (old.updatedAt ?? now) : now };
  });

  const deleted = { ...previous.deleted };
  const ids = new Set(accounts.map((account) => account.id));
  for (const id of before.keys()) if (!ids.has(id)) deleted[id] = now;
  return { accounts: stamped, deleted };
}

export function samePayload(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
