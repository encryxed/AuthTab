// Reads a QR code out of an image file: a screenshot, a phone photo of a screen, a pasted image.
// This file opens the image (any format Firefox can display, including SVG); the actual search
// runs in qr-worker.js so a slow, noisy photo never freezes the page.

const VECTOR_SIDE = 1200;
const TIME_LIMIT_MS = 7000;

export class UnreadableImageError extends Error {
  constructor(name) {
    const heic = /\.(heic|heif)$/i.test(name);
    super(
      heic
        ? `Firefox can't open HEIC photos. On your iPhone, screenshot the photo or share it as JPG, then try again`
        : `Firefox can't open "${name}" as an image. Try a PNG, JPG or WebP`,
    );
    this.name = 'UnreadableImageError';
  }
}

async function loadBitmap(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    // SVGs (and anything createImageBitmap refuses) can still decode through <img>.
    const url = URL.createObjectURL(blob);
    const img = new Image();
    try {
      img.src = url;
      await img.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
    // Vector images often have no size of their own (browsers then report 0 or a 300×150
    // default), so take the shape from the viewBox and render it at a comfortable size.
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    const text = blob.size < 2_000_000 ? await blob.text() : '';
    const box = text.match(/viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
    if (box) {
      const ratio = Number(box[1]) / Number(box[2]);
      width = Math.round(VECTOR_SIDE * Math.min(1, ratio));
      height = Math.round(VECTOR_SIDE * Math.min(1, 1 / ratio));
    }
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return canvas.transferToImageBitmap();
  }
}

// Resolves to the QR code's text, or null if none was found in time.
export async function decodeImage(blob, name = 'that image') {
  let bitmap;
  try {
    bitmap = await loadBitmap(blob);
  } catch {
    throw new UnreadableImageError(name);
  }

  return new Promise((resolve) => {
    const worker = new Worker(new URL('./qr-worker.js', import.meta.url));
    const finish = (text) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(text);
    };
    const timer = setTimeout(() => finish(null), TIME_LIMIT_MS);
    worker.onmessage = ({ data }) => finish(data);
    worker.onerror = () => finish(null);
    worker.postMessage({ bitmap }, [bitmap]);
  });
}
