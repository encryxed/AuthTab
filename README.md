# 🔐 AuthTab

Your Google Authenticator 2FA codes in a Firefox toolbar popup. Click to copy, type to search, and it works fully offline.

- 📲 **Imports straight from Google Authenticator**: snap or screenshot its *Transfer accounts* QR code, scan it with your webcam, or paste the link. Works with standard `otpauth://` QR codes from any site too.
- 🔒 **Encrypted at rest**: secrets are stored with AES-256-GCM, keyed from your master password (PBKDF2-SHA256, 600k iterations). The unlocked key lives only in memory and auto-locks.
- ⚡ **Fast**: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>2</kbd> opens the popup. Type part of a name and press <kbd>Enter</kbd> to copy that code.
- ☁️ **Optional Google Drive sync**: sign in with Google and AuthTab keeps every computer in step through a hidden app folder in *your own* Drive. Only the encrypted vault is uploaded, so Google can't read your codes. It merges edits from several computers and remembers deletions.
- 🙅 **Offline unless you turn sync on**: no tracking, no AuthTab servers. Google permissions are only requested when you enable sync.

> Google doesn't let other apps read Google Authenticator's own cloud backup, so the first move from your phone is always via its export QR code. After that, sync handles the rest.

## Install (for development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. **Load Temporary Add-on…** and pick `manifest.json` from this folder.

Temporary add-ons are removed when Firefox restarts. To keep it installed for good, sign it (free) as an *unlisted* add-on on [addons.mozilla.org](https://addons.mozilla.org/developers/) and install the signed `.xpi`.

## Moving codes over from Google Authenticator

1. On your phone: **Google Authenticator → ☰ → Transfer accounts → Export accounts**, pick accounts, then **Next**.
2. In AuthTab's manager page, drop in a photo of that QR code, or use **Scan with webcam**.
3. Exports with many accounts are split across several QR codes. Scan each one; AuthTab tells you if one is missing.

Exporting copies the accounts. They stay on your phone.

## Setting up Google Drive sync

Sync needs a free Google "client ID" that you create once. The **Sync** section of AuthTab's manager page walks you through it and shows the exact redirect URI to paste:

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/projectcreate) and enable the **Google Drive API**.
2. In **Google Auth Platform**, set up the app as **External** and add your Gmail as a **test user**.
3. Create a **Web application** OAuth client with the redirect URI AuthTab shows (`http://127.0.0.1/mozoauth2/…`). Firefox uses this loopback form because Google rejects unverified redirect domains.
4. Paste the client ID into AuthTab and click **Sign in with Google**.

On another computer, choose **Restore it here** on AuthTab's first screen, use the same client ID, and enter your master password.

AuthTab only asks for the `drive.appdata` scope (a private folder it alone can see) plus your email address to show who's signed in.

## Security notes

2FA works best when the second factor lives on a *different* device. AuthTab is a convenience copy: if someone fully controls your computer while AuthTab is unlocked, they could read your codes. Keep your phone as the main authenticator, choose a strong master password, and keep the auto-lock on.

## Development

Plain HTML/CSS/JS (ES modules), no build step.

- `lib/otp.js`: TOTP/HOTP (RFC 6238 / 4226)
- `lib/migration.js`: parses `otpauth://` and Google's `otpauth-migration://` export format
- `lib/vault.js`: encrypted storage and the locking logic
- `lib/qr.js` / `lib/qr-worker.js`: reads QR codes from screenshots and photos (PNG, JPG, WebP, GIF, BMP, AVIF, SVG) in a background worker, trying several sizes and a contrast boost
- `lib/merge.js`: merges two vault copies (newest edit wins, deletions are remembered)
- `lib/gdrive.js` / `lib/sync.js`: Google sign-in, Drive storage and the sync flow
- `lib/jsQR.js`: [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (Apache-2.0) for reading QR codes
- `fonts/`: [DSEG7](https://www.keshikan.net/fonts-e.html) for the LCD digits and [Barlow](https://github.com/jpt/barlow) for everything else, both SIL OFL 1.1 and bundled so nothing loads from the internet

The look is based on a hardware key fob: matte plastic housing, printed labels, and one LCD window per code with countdown ticks. The window turns amber when a code has 5 seconds left.

Lint with `npx web-ext lint`.

## License

MIT © encryxed
