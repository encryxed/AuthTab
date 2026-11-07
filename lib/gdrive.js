// Google sign-in and AuthTab's hidden folder in the user's Google Drive.
// Scope `drive.appdata` only reaches a private per-app folder: AuthTab can't see any other
// Drive files, and the vault stored there is already encrypted with the master password.

const SCOPES = 'https://www.googleapis.com/auth/drive.appdata email';
const FILE_NAME = 'authtab-vault.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export const ORIGINS = ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'];

export class SignInRequiredError extends Error {
  constructor() {
    super('Google sign-in expired');
    this.name = 'SignInRequiredError';
  }
}

// Google only accepts redirect domains it can verify, so Firefox's default
// *.extensions.allizom.org redirect is rejected. Firefox 86+ also accepts this loopback form.
export function redirectUri() {
  const host = new URL(browser.identity.getRedirectURL()).hostname;
  return `http://127.0.0.1/mozoauth2/${host.split('.')[0]}`;
}

// account: { clientId, email }. Non-interactive sign-in succeeds silently while the user is
// still signed into Google in this browser; otherwise it throws SignInRequiredError.
export async function signIn({ clientId, email }, interactive) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account' : 'none',
    ...(email ? { login_hint: email } : {}),
  });

  let result;
  try {
    result = await browser.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch (err) {
    if (!interactive) throw new SignInRequiredError();
    throw err;
  }

  const reply = new URLSearchParams(new URL(result).hash.slice(1));
  if (!reply.get('access_token')) {
    if (!interactive) throw new SignInRequiredError();
    throw new Error(`Google sign-in failed (${reply.get('error') ?? 'no access token'})`);
  }
  if (!reply.get('scope')?.includes('drive.appdata')) {
    throw new Error('AuthTab needs permission to use its own Google Drive folder. Sign in again and leave that box ticked');
  }

  const token = { value: reply.get('access_token'), expiresAt: Date.now() + (Number(reply.get('expires_in')) - 60) * 1000 };
  await browser.storage.session.set({ googleToken: token });
  return token.value;
}

async function accessToken(account) {
  const { googleToken } = await browser.storage.session.get('googleToken');
  if (googleToken && googleToken.expiresAt > Date.now()) return googleToken.value;
  return signIn(account, false);
}

async function call(account, url, options = {}, retry = true) {
  const response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${await accessToken(account)}` },
  });
  if (response.status === 401 && retry) {
    await browser.storage.session.remove('googleToken');
    return call(account, url, options, false);
  }
  if (!response.ok) throw new Error(`Google Drive answered ${response.status}`);
  return response;
}

export async function getEmail(account) {
  const response = await call(account, 'https://www.googleapis.com/oauth2/v3/userinfo');
  return (await response.json()).email;
}

async function findFile(account) {
  const query = encodeURIComponent(`name='${FILE_NAME}'`);
  const response = await call(account, `${DRIVE}/files?spaces=appDataFolder&q=${query}&fields=files(id)`);
  return (await response.json()).files?.[0]?.id ?? null;
}

// Returns the encrypted vault stored in Drive, or null if there isn't one yet.
export async function download(account) {
  const id = await findFile(account);
  if (!id) return null;
  return (await call(account, `${DRIVE}/files/${id}?alt=media`)).json();
}

export async function upload(account, blob) {
  const id = await findFile(account);
  const body = JSON.stringify(blob);
  if (id) {
    await call(account, `${UPLOAD}/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return;
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })], { type: 'application/json' }));
  form.append('file', new Blob([body], { type: 'application/json' }));
  await call(account, `${UPLOAD}/files?uploadType=multipart`, { method: 'POST', body: form });
}

export async function removeFile(account) {
  const id = await findFile(account);
  if (id) await call(account, `${DRIVE}/files/${id}`, { method: 'DELETE' });
}

export async function signOut() {
  const { googleToken } = await browser.storage.session.get('googleToken');
  await browser.storage.session.remove('googleToken');
  if (googleToken) {
    fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: googleToken.value }) }).catch(() => {});
  }
}
