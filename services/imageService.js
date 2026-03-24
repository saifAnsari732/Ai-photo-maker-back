/**
 * imageService.js — Photoroom v2/edit API Background Removal
 * ═══════════════════════════════════════════════════════════
 *  STEP 1 → Photoroom v2/edit : bg removal + bg color in ONE call
 *                                Works with sandbox_sk_ key (free, watermark only in sandbox)
 *  STEP 2 → sharp             : Apply background colour (fallback if Step 1 fails)
 *  STEP 3 → cutout.pro        : Enhancement (optional)
 *  STEP 4 → Cloudinary        : Save original + processed
 *  STEP 5 → sharp             : Resize + border
 *  STEP 6 → sharp             : A4 layout
 *  STEP 7 → PDFKit            : PDF export
 *
 *  .env key: PHOTOROOM_API_KEY=sandbox_sk_pr_default_xxxxxxx  (or real sk_xxx)
 */

const sharp       = require('sharp');
const PDFDocument = require('pdfkit');
const cloudinary  = require('cloudinary').v2;
const streamifier = require('streamifier');
const axios       = require('axios');
const FormData    = require('form-data');

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

// Strip '#' — Photoroom expects 'ffffff' not '#ffffff'
function hexClean(hex) {
  return hex.replace('#', '');
}

/**
 * STEP 1 — Remove background AND apply bg color using Photoroom v2/edit
 *
 * Endpoint : POST https://image-api.photoroom.com/v2/edit
 * Auth     : x-api-key header
 * ✅ Works with sandbox_sk_ keys (adds watermark in sandbox mode only)
 *
 * Returns: { buffer: JPEG with color bg, done: true }   on success
 *          { buffer: original imageBuffer, done: false } on failure/no key
 */
async function removeBgWithPhotoroom(imageBuffer, bgHex = '#ffffff') {
  const apiKey = process.env.PHOTOROOM_API_KEY;

  if (!apiKey) {
    console.warn('  ⚠️  PHOTOROOM_API_KEY not set — skipping bg removal');
    return { buffer: imageBuffer, done: false };
  }

  try {
    console.log(`  → Step 1: Photoroom v2/edit (bg: ${bgHex})...`);

    const form = new FormData();
    form.append('imageFile', imageBuffer, {
      filename    : 'photo.jpg',
      contentType : 'image/jpeg',
    });
    // Pass bg color directly — removes bg AND fills color in one API call
    form.append('background.color', hexClean(bgHex));
    form.append('outputSize', 'originalImage');  // keep original resolution

    const response = await axios.post(
      'https://image-api.photoroom.com/v2/edit',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'x-api-key' : apiKey.trim(),   // trim() removes accidental spaces from .env
          'Accept'    : 'image/png, application/json',
        },
        responseType : 'arraybuffer',
        timeout      : 60000,
      }
    );

    if (response.status === 200 && response.data.byteLength > 1000) {
      console.log('  ✅ Photoroom v2/edit success');
      // Convert PNG response to JPEG
      const jpegBuffer = await sharp(Buffer.from(response.data))
        .jpeg({ quality: 96 })
        .toBuffer();
      return { buffer: jpegBuffer, done: true };
    }

    throw new Error(`Unexpected response status: ${response.status}`);

  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data
      ? Buffer.from(err.response.data).toString('utf8')
      : err.message;
    console.warn(`  ⚠️  Photoroom failed (${status || 'network'}): ${message} — using fallback`);
    return { buffer: imageBuffer, done: false };
  }
}

/**
 * STEP 2 — Fallback: paint bg color onto image using sharp flatten
 * Only runs if Photoroom Step 1 failed
 */
async function applyBackgroundFallback(imageBuffer, bgHex = '#ffffff') {
  const { r, g, b } = hexToRgb(bgHex);
  console.log(`  → Step 2 (fallback): painting background ${bgHex} via sharp...`);
  return sharp(imageBuffer)
    .flatten({ background: { r, g, b } })
    .jpeg({ quality: 96 })
    .toBuffer();
}

async function enhanceWithCutoutPro(imageBuffer) {
  if (!process.env.CUTOUT_PRO_API_KEY) {
    console.log('  → Step 3: Enhancement skipped (no CUTOUT_PRO_API_KEY)');
    return imageBuffer;
  }
  try {
    const form = new FormData();
    form.append('file', imageBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    const res = await axios.post('https://www.cutout.pro/api/v1/photoEnhance', form, {
      headers      : { ...form.getHeaders(), 'APIKEY': process.env.CUTOUT_PRO_API_KEY },
      responseType : 'arraybuffer',
      timeout      : 90000,
    });
    if (res.status === 200 && Buffer.from(res.data).byteLength > 1000) return Buffer.from(res.data);
    return imageBuffer;
  } catch (err) {
    console.warn(`  ⚠️  cutout.pro skipped: ${err.response?.status || err.message}`);
    return imageBuffer;
  }
}

async function uploadToCloudinary(imageBuffer, folder, publicId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return null;
  return new Promise((resolve) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id     : publicId,
        folder        : `passport-pro/${folder}`,
        overwrite     : true,
        resource_type : 'image',
        quality       : 'auto:best',
        format        : 'jpg',
      },
      (error, result) => {
        if (error) { console.warn(`  ⚠️  Cloudinary [${folder}]:`, error.message); resolve(null); }
        else        { console.log(`  ☁️  Cloudinary [${folder}]: ${result.secure_url}`); resolve(result.secure_url); }
      }
    );
    streamifier.createReadStream(imageBuffer).pipe(stream);
  });
}

async function makePassportPhoto(imageBuffer, { width = 390, height = 480, borderPx = 2 }) {
  const resized = await sharp(imageBuffer)
    .resize(width, height, { fit: 'cover', position: 'top' })
    .jpeg({ quality: 98 })
    .toBuffer();

  return sharp(resized)
    .extend({
      top        : borderPx,
      bottom     : borderPx,
      left       : borderPx,
      right      : borderPx,
      background : { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .jpeg({ quality: 98 })
    .toBuffer();
}

async function buildPassportSheet(passportImages, options) {
  const { passportW = 390, passportH = 480, borderPx = 2, spacing = 10 } = options;
  const MARGIN_X = 30, MARGIN_Y = 30, A4_W = 2480, A4_H = 3508;
  const cellW = passportW + borderPx * 2, cellH = passportH + borderPx * 2;

  const cells = [];
  for (const { buffer, copies } of passportImages)
    for (let c = 0; c < copies; c++) cells.push(buffer);

  const pages = [];
  let composites = [], x = MARGIN_X, y = MARGIN_Y;

  for (const cellBuf of cells) {
    if (x + cellW > A4_W - MARGIN_X) { x = MARGIN_X; y += cellH + spacing; }
    if (y + cellH > A4_H - MARGIN_Y) { pages.push(composites); composites = []; x = MARGIN_X; y = MARGIN_Y; }
    composites.push({ input: cellBuf, left: x, top: y });
    x += cellW + spacing;
  }
  if (composites.length) pages.push(composites);

  const pageBuffers = [];
  for (const comp of pages) {
    const buf = await sharp({
      create: { width: A4_W, height: A4_H, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite(comp)
      .jpeg({ quality: 95 })
      .toBuffer();
    pageBuffers.push(buf);
  }
  return pageBuffers;
}

async function buildPDF(pageBuffers) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size    : [595.28, 841.89],
      margins : { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false,
    });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const buf of pageBuffers) {
      doc.addPage();
      doc.image(buf, 0, 0, { width: 595.28, height: 841.89 });
    }
    doc.end();
  });
}

async function processPassportBatch(imagesData, options) {
  const {
    bgColor  = '#ffffff',
    width    = 390,
    height   = 480,
    border   = 2,
    spacing  = 10,
    userId   = 'unknown',
  } = options;

  console.log('🔑 PHOTOROOM_API_KEY present:', !!process.env.PHOTOROOM_API_KEY);

  const passportImages = [];

  for (let i = 0; i < imagesData.length; i++) {
    const { buffer, copies, name } = imagesData[i];
    console.log(`\n📸 [${i+1}/${imagesData.length}] Processing: ${name}`);

    // Upload original to Cloudinary (non-blocking)
    uploadToCloudinary(buffer, 'originals', `orig_${userId}_${Date.now()}_${i}`).catch(() => {});

    // Step 1 — Photoroom v2/edit: removes bg AND applies color in one call
    const photoroomResult = await removeBgWithPhotoroom(buffer, bgColor);

    // Step 2 — If Photoroom failed, apply color via sharp fallback
    const withBgBuffer = photoroomResult.done
      ? photoroomResult.buffer
      : await applyBackgroundFallback(photoroomResult.buffer, bgColor);

    // Step 3 — Optional enhancement
    const enhancedBuffer = await enhanceWithCutoutPro(withBgBuffer);

    // Upload processed to Cloudinary (non-blocking)
    uploadToCloudinary(enhancedBuffer, 'processed', `proc_${userId}_${Date.now()}_${i}`).catch(() => {});

    // Step 5 — Resize + border
    const passportBuffer = await makePassportPhoto(enhancedBuffer, { width, height, borderPx: border });
    passportImages.push({ buffer: passportBuffer, copies });

    console.log(`  ✅ Image ${i+1} ready — ${copies} copies`);
  }

  // Steps 6 & 7 — A4 sheet + PDF
  const pageBuffers = await buildPassportSheet(passportImages, {
    passportW : width,
    passportH : height,
    borderPx  : border,
    spacing,
  });
  const pdfBuffer = await buildPDF(pageBuffers);

  console.log(`\n✅ PDF ready — ${(pdfBuffer.length / 1024).toFixed(1)} KB\n`);
  return pdfBuffer;
}

module.exports = { processPassportBatch };