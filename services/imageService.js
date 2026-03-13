/**
 * imageService.js — Memory-optimised for Render free tier (512MB)
 * ════════════════════════════════════════════════════════════════
 *  @imgly REMOVED — was causing OOM crash (used >512MB)
 *
 *  STEP 1 → sharp  : Background removal via corner-colour flood-fill
 *                    Works great for passport photos with plain bg
 *  STEP 2 → sharp  : Apply chosen background colour
 *  STEP 3 → cutout.pro (optional, skip if no key)
 *  STEP 4 → Cloudinary : Save original + processed (non-blocking)
 *  STEP 5 → sharp  : Resize to passport size + border
 *  STEP 6 → sharp  : A4 layout composite
 *  STEP 7 → PDFKit : PDF export
 */

const sharp       = require('sharp');
const PDFDocument = require('pdfkit');
const cloudinary  = require('cloudinary').v2;
const streamifier = require('streamifier');

cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
});

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

// ══════════════════════════════════════════════════════════
// STEP 1: Background removal using sharp pixel manipulation
// Samples corners → treats near-matching pixels as background
// Memory usage: ~20-40MB (vs @imgly's 400MB+)
// ══════════════════════════════════════════════════════════
async function removeBg(imageBuffer) {
  console.log('  → Step 1: sharp corner-based bg removal (low memory)...');

  try {
    // Convert to raw RGBA pixels
    const { data, info } = await sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info; // channels = 4 (RGBA)
    const px = (x, y) => (y * width + x) * channels;

    // Sample all 4 corners to get bg colour
    const corners = [
      [0, 0], [width - 1, 0],
      [0, height - 1], [width - 1, height - 1],
    ];

    // Average corner colours
    let sumR = 0, sumG = 0, sumB = 0;
    for (const [cx, cy] of corners) {
      const i = px(cx, cy);
      sumR += data[i]; sumG += data[i+1]; sumB += data[i+2];
    }
    const bgR = sumR / 4, bgG = sumG / 4, bgB = sumB / 4;
    console.log(`     Detected bg colour: rgb(${Math.round(bgR)}, ${Math.round(bgG)}, ${Math.round(bgB)})`);

    // Threshold: how similar a pixel needs to be to bg to be removed
    const THRESHOLD = 35;

    // Make bg pixels transparent
    const out = Buffer.from(data); // copy
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = px(x, y);
        const r = data[i], g = data[i+1], b = data[i+2];
        const dist = Math.sqrt(
          (r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2
        );
        // Smooth edge transition (anti-aliased alpha)
        if (dist < THRESHOLD) {
          out[i+3] = 0; // fully transparent
        } else if (dist < THRESHOLD + 20) {
          out[i+3] = Math.round(((dist - THRESHOLD) / 20) * 255); // soft edge
        }
        // else: fully opaque (leave as-is)
      }
    }

    const pngBuffer = await sharp(out, {
      raw: { width, height, channels: 4 },
    }).png().toBuffer();

    console.log('  ✅ Background removed (sharp, low memory)');
    return pngBuffer;

  } catch (err) {
    console.warn(`  ⚠️  BG removal failed: ${err.message} — using original`);
    return imageBuffer;
  }
}

// ══════════════════════════════════════════════════════════
// STEP 2: Apply solid background colour
// ══════════════════════════════════════════════════════════
async function applyBackground(pngBuffer, bgHex = '#ffffff') {
  const { r, g, b } = hexToRgb(bgHex);

  const meta = await sharp(pngBuffer).metadata();

  const bgLayer = await sharp({
    create: {
      width: meta.width, height: meta.height,
      channels: 4, background: { r, g, b, alpha: 1 },
    },
  }).png().toBuffer();

  return sharp(bgLayer)
    .composite([{ input: pngBuffer, blend: 'over' }])
    .jpeg({ quality: 96, mozjpeg: true })
    .toBuffer();
}

// ══════════════════════════════════════════════════════════
// STEP 3: cutout.pro enhancement (optional)
// ══════════════════════════════════════════════════════════
async function enhanceWithCutoutPro(imageBuffer) {
  if (!process.env.CUTOUT_PRO_API_KEY) {
    console.log('  → Step 3: Enhancement skipped (no API key)');
    return imageBuffer;
  }
  try {
    const axios    = require('axios');
    const FormData = require('form-data');
    const form     = new FormData();
    form.append('file', imageBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    const res = await axios.post(
      'https://www.cutout.pro/api/v1/photoEnhance',
      form,
      {
        headers      : { ...form.getHeaders(), 'APIKEY': process.env.CUTOUT_PRO_API_KEY },
        responseType : 'arraybuffer',
        timeout      : 90000,
      }
    );
    if (res.status === 200 && Buffer.from(res.data).byteLength > 1000) {
      console.log('  ✅ cutout.pro enhancement applied');
      return Buffer.from(res.data);
    }
    return imageBuffer;
  } catch (err) {
    console.warn(`  ⚠️  cutout.pro skipped: ${err.response?.status || err.message}`);
    return imageBuffer;
  }
}

// ══════════════════════════════════════════════════════════
// STEP 4: Upload to Cloudinary (non-blocking)
// ══════════════════════════════════════════════════════════
async function uploadToCloudinary(imageBuffer, folder, publicId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return null;
  return new Promise((resolve) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId, folder: `passport-pro/${folder}`,
        overwrite: true, resource_type: 'image',
        quality: 'auto:best', format: 'jpg',
      },
      (error, result) => {
        if (error) { console.warn(`  ⚠️  Cloudinary [${folder}]:`, error.message); resolve(null); }
        else { console.log(`  ☁️  Cloudinary [${folder}]: ${result.secure_url}`); resolve(result.secure_url); }
      }
    );
    streamifier.createReadStream(imageBuffer).pipe(stream);
  });
}

// ══════════════════════════════════════════════════════════
// STEP 5: Resize to passport size + black border
// ══════════════════════════════════════════════════════════
async function makePassportPhoto(imageBuffer, { width = 390, height = 480, borderPx = 2 }) {
  const resized = await sharp(imageBuffer)
    .resize(width, height, { fit: 'cover', position: 'top' })
    .jpeg({ quality: 98 })
    .toBuffer();

  return sharp(resized)
    .extend({
      top: borderPx, bottom: borderPx, left: borderPx, right: borderPx,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .jpeg({ quality: 98 })
    .toBuffer();
}

// ══════════════════════════════════════════════════════════
// STEP 6: A4 layout (300 DPI)
// ══════════════════════════════════════════════════════════
async function buildPassportSheet(passportImages, options) {
  const { passportW = 390, passportH = 480, borderPx = 2, spacing = 10 } = options;
  const MARGIN_X = 30, MARGIN_Y = 30;
  const A4_W = 2480, A4_H = 3508;
  const cellW = passportW + borderPx * 2;
  const cellH = passportH + borderPx * 2;

  const cells = [];
  for (const { buffer, copies } of passportImages)
    for (let c = 0; c < copies; c++) cells.push(buffer);

  const pages = [];
  let composites = [];
  let x = MARGIN_X, y = MARGIN_Y;

  for (const cellBuf of cells) {
    if (x + cellW > A4_W - MARGIN_X) { x = MARGIN_X; y += cellH + spacing; }
    if (y + cellH > A4_H - MARGIN_Y) {
      pages.push(composites); composites = [];
      x = MARGIN_X; y = MARGIN_Y;
    }
    composites.push({ input: cellBuf, left: x, top: y });
    x += cellW + spacing;
  }
  if (composites.length) pages.push(composites);

  const pageBuffers = [];
  for (const comp of pages) {
    const buf = await sharp({
      create: { width: A4_W, height: A4_H, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).composite(comp).jpeg({ quality: 95 }).toBuffer();
    pageBuffers.push(buf);
  }
  return pageBuffers;
}

// ══════════════════════════════════════════════════════════
// STEP 7: PDF export
// ══════════════════════════════════════════════════════════
async function buildPDF(pageBuffers) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [595.28, 841.89],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false,
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const buf of pageBuffers) {
      doc.addPage();
      doc.image(buf, 0, 0, { width: 595.28, height: 841.89 });
    }
    doc.end();
  });
}

// ══════════════════════════════════════════════════════════
// MAIN EXPORT
// ══════════════════════════════════════════════════════════
async function processPassportBatch(imagesData, options) {
  const {
    bgColor = '#ffffff', width = 390, height = 480,
    border = 2, spacing = 10, userId = 'unknown',
  } = options;

  const passportImages = [];

  for (let i = 0; i < imagesData.length; i++) {
    const { buffer, copies, name } = imagesData[i];
    console.log(`\n📸 [${i+1}/${imagesData.length}] Processing: ${name}`);

    // 1. Remove bg (sharp, ~30MB RAM)
    const noBgBuffer = await removeBg(buffer);

    // 2. Save original to Cloudinary (fire & forget)
    uploadToCloudinary(buffer, 'originals', `orig_${userId}_${Date.now()}_${i}`).catch(() => {});

    // 3. Apply bg colour
    const withBgBuffer = await applyBackground(noBgBuffer, bgColor);

    // 4. Enhance (optional)
    const enhancedBuffer = await enhanceWithCutoutPro(withBgBuffer);

    // 5. Save processed to Cloudinary (fire & forget)
    uploadToCloudinary(enhancedBuffer, 'processed', `proc_${userId}_${Date.now()}_${i}`).catch(() => {});

    // 6. Resize + border
    const passportBuffer = await makePassportPhoto(enhancedBuffer, { width, height, borderPx: border });
    passportImages.push({ buffer: passportBuffer, copies });
    console.log(`  ✅ Image ${i+1} ready — ${copies} copies`);
  }

  const pageBuffers = await buildPassportSheet(passportImages, {
    passportW: width, passportH: height, borderPx: border, spacing,
  });
  const pdfBuffer = await buildPDF(pageBuffers);
  console.log(`\n✅ PDF ready — ${(pdfBuffer.length / 1024).toFixed(1)} KB\n`);
  return pdfBuffer;
}

module.exports = { processPassportBatch };