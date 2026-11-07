// Runs the QR search off the page's main thread, so the page stays responsive on big, noisy
// photos. qr.js hands over the image and stops this worker if it runs past its time limit.
//
// jsQR needs a few pixels per QR square, so screenshots are tried at full size first (the QR
// may be a small part of the screen) and big photos at ~1600px first (shrinking averages out
// camera noise), then other sizes, then with boosted contrast for dim or washed-out shots.

importScripts('jsQR.js');

const MAX_SIDE = 2600;
const PHOTO_SIDE = 2600;

function scan(context, width, height) {
  const { data } = context.getImageData(0, 0, width, height);
  return jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

// Grayscale and stretch the 2nd–98th brightness percentiles to full black and white.
function boostContrast(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const { data } = image;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const gray = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    data[i] = gray;
    histogram[gray]++;
  }
  const pixels = data.length / 4;
  let low = 0;
  let high = 255;
  for (let sum = 0; low < 255 && (sum += histogram[low]) < pixels * 0.02; low++);
  for (let sum = 0; high > 0 && (sum += histogram[high]) < pixels * 0.02; high--);
  if (high - low < 16) return;
  for (let i = 0; i < data.length; i += 4) {
    const value = ((data[i] - low) * 255) / (high - low);
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  context.putImageData(image, 0, 0);
}

function search(bitmap) {
  const { width, height } = bitmap;
  const longest = Math.max(width, height);
  const full = Math.min(longest, MAX_SIDE);
  const preferred = longest > PHOTO_SIDE ? [1600, full] : [full, 1600];
  const sizes = [...new Set([...preferred, 1100, 800, 550].filter((size) => size <= full))];
  if (longest < 700) sizes.unshift(longest * 2); // tiny images: enlarge with crisp edges

  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const draw = (size) => {
    const scale = size / longest;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    // White underneath, or transparent PNG backgrounds read as black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = scale < 1;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  };

  const passes = [
    ...sizes.map((size) => ({ size, boost: false })),
    ...sizes.filter((size) => size <= 1600).slice(0, 3).map((size) => ({ size, boost: true })),
  ];
  for (const { size, boost } of passes) {
    draw(size);
    if (boost) boostContrast(context, canvas.width, canvas.height);
    const text = scan(context, canvas.width, canvas.height);
    if (text) return text;
  }
  return null;
}

self.onmessage = ({ data: { bitmap } }) => {
  self.postMessage(search(bitmap));
};
