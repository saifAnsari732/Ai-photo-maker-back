/**
 * imageService.js  — Pure Node.js Image Processing Pipeline
 * ══════════════════════════════════════════════════════════
 *  STEP 1 → @imgly/background-removal-node : FREE local AI bg removal
 *  STEP 2 → sharp             : Apply custom background color
 *  STEP 3 → cutout.pro        : AI photo enhancement (optional)
 *  STEP 4 → Cloudinary        : Upload processed image (non-blocking)
 *  STEP 5 → sharp             : Resize to passport dimensions + border
 *  STEP 6 → sharp composite   : Layout all copies on A4 page(s)
 *  STEP 7 → PDFKit            : Encode pages into downloadable PDF
 * ══════════════════════════════════════════════════════════
 *
 *  Install: npm install @imgly/background-removal-node
 *  Remove:  npm uninstall axios form-data   (remove.bg no longer needed)
 */

const sharp       = require('sharp');
const PDFDocument = require('pdfkit');
const cloudinary  = require('cloudinary').v2;
const streamifier = require('streamifier');

// ── Cloudinary config ──────────────────────────────────────
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
});

// ── Helpers ────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

// ══════════════════════════════════════════════════════════
// STEP 1: Remove background — FREE local AI (no API key!)
// ══════════════════════════════════════════════════════════
async function removeBg(imageBuffer) {
  try {
    const { removeBackground } = require('@imgly/background-removal-node');
    console.log('  → Step 1: Local AI background removal (@imgly)...');

    // Buffer → Blob
    const blob = new Blob([imageBuffer], { type: 'image/jpeg' });

    const resultBlob = await removeBackground(blob, {
      model: 'medium',        // 'small' faster | 'large' best quality
      output: {
        format  : 'image/png',
        quality : 1.0,
      },
    });

    // Blob → Buffer
    const arrayBuffer  = await resultBlob.arrayBuffer();
    const resultBuffer = Buffer.from(arrayBuffer);

    console.log('  ✅ Background removed (free local AI)');
    return resultBuffer;   // PNG with alpha — same format as remove.bg

  } catch (err) {
    console.error('  ❌ BG removal failed:', err.message);
    // Graceful fallback — pipeline continues with original
    return imageBuffer;
  }
}

// ══════════════════════════════════════════════════════════
// STEP 2: Apply solid background color using sharp
// ══════════════════════════════════════════════════════════
async function applyBackground(pngBuffer, bgHex = '#ffffff') {
  const { r, g, b } = hexToRgb(bgHex);
  const meta = await sharp(pngBuffer).metadata();

  const bgLayer = await sharp({
    create: {
      width    : meta.width,
      height   : meta.height,
      channels : 4,
      background: { r, g, b, alpha: 1 },
    },
  }).png().toBuffer();

  const composited = await sharp(bgLayer)
    .composite([{ input: pngBuffer, blend: 'over' }])
    .jpeg({ quality: 96, mozjpeg: true })
    .toBuffer();

  return composited;
}

// ══════════════════════════════════════════════════════════
// STEP 3: AI Enhancement — cutout.pro (optional)
// ══════════════════════════════════════════════════════════
async function enhanceWithCutoutPro(imageBuffer) {
  if (!process.env.CUTOUT_PRO_API_KEY) {
    console.warn('  ⚠️  CUTOUT_PRO_API_KEY not set — skipping enhancement');
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
// STEP 4: Upload to Cloudinary — original + processed save
// ══════════════════════════════════════════════════════════
async function uploadToCloudinary(imageBuffer, folder, publicId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return null;

  return new Promise((resolve) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        public_id     : publicId,
        folder        : `passport-pro/${folder}`,
        overwrite     : true,
        resource_type : 'image',
        quality       : 'auto:best',
        format        : 'jpg',
      },
      (error, result) => {
        if (error) {
          console.warn(`  ⚠️  Cloudinary [${folder}] upload failed:`, error.message);
          resolve(null);
        } else {
          console.log(`  ☁️  Cloudinary [${folder}] saved: ${result.secure_url}`);
          resolve(result.secure_url);
        }
      }
    );
    streamifier.createReadStream(imageBuffer).pipe(uploadStream);
  });
}

// ══════════════════════════════════════════════════════════
// STEP 5: Resize to passport dimensions + black border
// ══════════════════════════════════════════════════════════
async function makePassportPhoto(imageBuffer, { width = 390, height = 480, borderPx = 2 }) {
  const resized = await sharp(imageBuffer)
    .resize(width, height, { fit: 'cover', position: 'top' })
    .jpeg({ quality: 98 })
    .toBuffer();

  const withBorder = await sharp(resized)
    .extend({
      top    : borderPx,
      bottom : borderPx,
      left   : borderPx,
      right  : borderPx,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .jpeg({ quality: 98 })
    .toBuffer();

  return withBorder;
}

// ══════════════════════════════════════════════════════════
// STEP 6: Composite all photo copies onto A4 pages (300 DPI)
// ══════════════════════════════════════════════════════════
async function buildPassportSheet(passportImages, options) {
  const {
    passportW = 390,
    passportH = 480,
    borderPx  = 2,
    spacing   = 10,
  } = options;

  const MARGIN_X = 30;
  const MARGIN_Y = 30;
  const A4_W     = 2480;
  const A4_H     = 3508;
  const cellW    = passportW + borderPx * 2;
  const cellH    = passportH + borderPx * 2;

  const cells = [];
  for (const { buffer, copies } of passportImages) {
    for (let c = 0; c < copies; c++) cells.push(buffer);
  }

  const pages        = [];
  let pageComposites = [];
  let x = MARGIN_X, y = MARGIN_Y;

  for (const cellBuf of cells) {
    if (x + cellW > A4_W - MARGIN_X) { x = MARGIN_X; y += cellH + spacing; }
    if (y + cellH > A4_H - MARGIN_Y) {
      pages.push(pageComposites);
      pageComposites = [];
      x = MARGIN_X; y = MARGIN_Y;
    }
    pageComposites.push({ input: cellBuf, left: x, top: y });
    x += cellW + spacing;
  }
  if (pageComposites.length) pages.push(pageComposites);

  const pageBuffers = [];
  for (const composites of pages) {
    const pageJpeg = await sharp({
      create: { width: A4_W, height: A4_H, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite(composites)
      .jpeg({ quality: 95 })
      .toBuffer();
    pageBuffers.push(pageJpeg);
  }

  return pageBuffers;
}

// ══════════════════════════════════════════════════════════
// STEP 7: Encode all page JPEGs into a single multi-page PDF
// ══════════════════════════════════════════════════════════
async function buildPDF(pageBuffers) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size         : [595.28, 841.89],
      margins      : { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false,
    });

    const chunks = [];
    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    for (const pageBuf of pageBuffers) {
      doc.addPage();
      doc.image(pageBuf, 0, 0, { width: 595.28, height: 841.89 });
    }
    doc.end();
  });
}

// ══════════════════════════════════════════════════════════
// MAIN EXPORT: Full pipeline
// ══════════════════════════════════════════════════════════
async function processPassportBatch(imagesData, options) {
  const {
    bgColor = '#ffffff',
    width   = 390,
    height  = 480,
    border  = 2,
    spacing = 10,
    userId  = 'unknown',
  } = options;

  const passportImages = [];

  for (let i = 0; i < imagesData.length; i++) {
    const { buffer, copies, name } = imagesData[i];
    console.log(`\n📸 [${i+1}/${imagesData.length}] Processing: ${name}`);

    // 1. Remove background (FREE local AI)
    const noBgBuffer = await removeBg(buffer);

    // 2. Save original to Cloudinary (non-blocking)
    const origId = `orig_${userId}_${Date.now()}_${i}`;
    uploadToCloudinary(buffer, 'originals', origId).catch(() => {});

    // 3. Apply background color
    console.log(`  → Step 2: Applying background color ${bgColor}...`);
    const withBgBuffer = await applyBackground(noBgBuffer, bgColor);

    // 4. Enhance (optional — skipped if no CUTOUT_PRO_API_KEY)
    console.log('  → Step 3: Enhancement...');
    const enhancedBuffer = await enhanceWithCutoutPro(withBgBuffer);

    // 5. Save processed to Cloudinary (non-blocking)
    const procId = `proc_${userId}_${Date.now()}_${i}`;
    uploadToCloudinary(enhancedBuffer, 'processed', procId).catch(() => {});

    // 6. Resize + border
    console.log(`  → Step 5: Resize ${width}×${height} + border...`);
    const passportBuffer = await makePassportPhoto(enhancedBuffer, { width, height, borderPx: border });

    passportImages.push({ buffer: passportBuffer, copies });
    console.log(`  ✅ Image ${i+1} ready — ${copies} copies queued`);
  }

  // 7. Build A4 layout
  console.log('\n  → Step 6: Building A4 layout...');
  const pageBuffers = await buildPassportSheet(passportImages, {
    passportW: width, passportH: height, borderPx: border, spacing,
  });

  // 8. Encode to PDF
  console.log(`  → Step 7: Encoding ${pageBuffers.length} page(s) to PDF...`);
  const pdfBuffer = await buildPDF(pageBuffers);

  console.log(`\n✅ PDF ready — ${(pdfBuffer.length / 1024).toFixed(1)} KB\n`);
  return pdfBuffer;
}

module.exports = { processPassportBatch };