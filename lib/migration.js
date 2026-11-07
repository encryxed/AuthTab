// Reads the links that authenticator apps put inside their QR codes:
//   otpauth://totp/Issuer:you@x.com?secret=...           (one account, the standard format)
//   otpauth-migration://offline?data=...                  (Google Authenticator's "Transfer accounts" export)
//
// The migration `data` is base64 of a small protobuf message. Its schema (from Google Authenticator):
//   MigrationPayload { repeated OtpParameters otp_parameters = 1; int32 version = 2;
//                      int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5; }
//   OtpParameters    { bytes secret = 1; string name = 2; string issuer = 3; Algorithm algorithm = 4;
//                      DigitCount digits = 5; OtpType type = 6; int64 counter = 7; }

import { base32Encode, makeAccount } from './otp.js';

const ALGORITHMS = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const DIGITS = { 0: 6, 1: 6, 2: 8 };
const TYPES = { 0: 'totp', 1: 'hotp', 2: 'totp' };

// Minimal protobuf reader: returns [{ field, value }] where value is a number (varint) or bytes.
function readMessage(bytes) {
  const fields = [];
  let i = 0;
  const varint = () => {
    let result = 0;
    let multiplier = 1;
    let byte;
    do {
      if (i >= bytes.length) throw new Error('The export data is cut off');
      byte = bytes[i++];
      result += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    } while (byte & 0x80);
    return result;
  };

  while (i < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      fields.push({ field, value: varint() });
    } else if (wire === 2) {
      const length = varint();
      if (i + length > bytes.length) throw new Error('The export data is cut off');
      fields.push({ field, value: bytes.subarray(i, i + length) });
      i += length;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw new Error("The export data isn't in a format I recognise");
    }
  }
  return fields;
}

function decodeBase64(text) {
  let clean = text.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  while (clean.length % 4) clean += '=';
  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
}

// Google Authenticator often stores the name as "Issuer:account".
function splitLabel(issuer, name) {
  const colon = name.indexOf(':');
  if (colon === -1) return { issuer, name };
  const prefix = name.slice(0, colon).trim();
  if (!issuer) return { issuer: prefix, name: name.slice(colon + 1).trim() };
  if (prefix.toLowerCase() === issuer.toLowerCase()) return { issuer, name: name.slice(colon + 1).trim() };
  return { issuer, name };
}

export function parseMigrationUri(uri) {
  const data = new URL(uri).searchParams.get('data');
  if (!data) throw new Error('This export link has no data in it');

  const text = new TextDecoder();
  const accounts = [];
  const errors = [];
  const batch = { id: 0, size: 1, index: 0 };

  for (const { field, value } of readMessage(decodeBase64(data))) {
    if (field === 3) batch.size = value;
    else if (field === 4) batch.index = value;
    else if (field === 5) batch.id = value;
    else if (field === 1 && value instanceof Uint8Array) {
      const entry = { secret: '', issuer: '', name: '', algorithm: 0, digits: 0, type: 0, counter: 0 };
      for (const part of readMessage(value)) {
        if (part.field === 1) entry.secret = base32Encode(part.value);
        else if (part.field === 2) entry.name = text.decode(part.value);
        else if (part.field === 3) entry.issuer = text.decode(part.value);
        else if (part.field === 4) entry.algorithm = part.value;
        else if (part.field === 5) entry.digits = part.value;
        else if (part.field === 6) entry.type = part.value;
        else if (part.field === 7) entry.counter = part.value;
      }
      try {
        accounts.push(
          makeAccount({
            ...splitLabel(entry.issuer.trim(), entry.name.trim()),
            secret: entry.secret,
            algorithm: ALGORITHMS[entry.algorithm] ?? 'SHA1',
            digits: DIGITS[entry.digits] ?? 6,
            type: TYPES[entry.type] ?? 'totp',
            counter: entry.counter,
          }),
        );
      } catch (err) {
        errors.push(err.message);
      }
    }
  }
  return { accounts, errors, batch };
}

export function parseOtpauthUri(uri) {
  const url = new URL(uri);
  const params = url.searchParams;
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  return makeAccount({
    ...splitLabel((params.get('issuer') ?? '').trim(), label.trim()),
    secret: params.get('secret'),
    algorithm: params.get('algorithm') ?? 'SHA1',
    digits: params.get('digits') ?? 6,
    period: params.get('period') ?? 30,
    type: url.hostname || url.host,
    counter: params.get('counter') ?? 0,
  });
}

// Accepts anything a QR code, the clipboard or a text box might hold.
export function parseText(input) {
  const accounts = [];
  const batches = [];
  const errors = [];
  const links = String(input).match(/otpauth(?:-migration)?:\/\/\S+/gi) ?? [];
  if (links.length === 0) errors.push("That doesn't look like an authenticator QR code or link");

  for (const link of links) {
    try {
      if (/^otpauth-migration:/i.test(link)) {
        const result = parseMigrationUri(link);
        accounts.push(...result.accounts);
        errors.push(...result.errors);
        if (result.batch.size > 1) batches.push(result.batch);
      } else {
        accounts.push(parseOtpauthUri(link));
      }
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { accounts, batches, errors };
}
