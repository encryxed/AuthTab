# 🔐 AuthTab

Your Google Authenticator 2FA codes in a Firefox toolbar popup. Click to copy, type to search, and it works fully offline.

- 📲 **Imports straight from Google Authenticator**: snap or screenshot its *Transfer accounts* QR code, scan it with your webcam, or paste the link. Works with standard `otpauth://` QR codes from any site too.
- 🔒 **Encrypted at rest**: secrets are stored with AES-256-GCM, keyed from your master password (PBKDF2-SHA256, 600k iterations). The unlocked key lives only in memory and auto-locks.
- ⚡ **Fast**: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>2</kbd> opens the popup. Type part of a name and press <kbd>Enter</kbd> to copy that code.
- 🙅 **No network, no accounts, no tracking**: the extension only asks for `storage` and `clipboardWrite`.

## Install (for development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. **Load Temporary Add-on…** and pick `manifest.json` from this folder.

Temporary add-ons are removed when Firefox restarts. To keep it installed for good, sign it (free) as an *unlisted* add-on on [addons.mozilla.org](https://addons.mozilla.org/developers/) and install the signed `.xpi`.

## Moving codes over from Google Authenticator

1. On your phone: **Google Authenticator → ☰ → Transfer accounts → Export accounts**, pick accounts, then **Next**.
2. In AuthTab's manager page, drop in a photo of that QR code, or use **Scan with webcam**.
3. Exports with many accounts are split across several QR codes. Scan each one; AuthTab tells you if one is missing.

Exporting copies the accounts. They stay on your phone.

## Security notes

2FA works best when the second factor lives on a *different* device. AuthTab is a convenience copy: if someone fully controls your computer while AuthTab is unlocked, they could read your codes. Keep your phone as the main authenticator, choose a strong master password, and keep the auto-lock on.

## Development

Plain HTML/CSS/JS (ES modules), no build step.

- `lib/otp.js`: TOTP/HOTP (RFC 6238 / 4226)
- `lib/migration.js`: parses `otpauth://` and Google's `otpauth-migration://` export format
- `lib/vault.js`: encrypted storage and the locking logic
- `lib/jsQR.js`: [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (Apache-2.0) for reading QR codes
- `fonts/`: [DSEG7](https://www.keshikan.net/fonts-e.html) for the LCD digits and [Barlow](https://github.com/jpt/barlow) for everything else, both SIL OFL 1.1 and bundled so nothing loads from the internet

The look is based on a hardware key fob: matte plastic housing, printed labels, and one LCD window per code with countdown ticks. The window turns amber when a code has 5 seconds left.

Lint with `npx web-ext lint`.

## License

MIT © encryxed
