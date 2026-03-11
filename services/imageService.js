/**
 * imageService.js  — Pure Node.js Image Processing Pipeline
 * ══════════════════════════════════════════════════════════
 *  STEP 1 → remove.bg         : Remove background (returns PNG with transparency)
 *  STEP 2 → sharp             : Apply custom background color
 *  STEP 3 → cutout.pro        : AI photo enhancement (face + color grading)
 *  STEP 4 → Cloudinary        : Upload processed image as CDN backup (non-blocking)
 *  STEP 5 → sharp             : Resize to passport dimensions + add border
 *  STEP 6 → sharp composite   : Layout all copies on A4 page(s)
 *  STEP 7 → PDFKit            : Encode pages into downloadable PDF
 * ══════════════════════════════════════════════════════════
 */

const axios       = require('axios');
const FormData    = require('form-data');
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
// STEP 1: Remove background — remove.bg API
// ══════════════════════════════════════════════════════════
async function removeBg(imageBuffer) {
  const form = new FormData();
  form.append('image_file', imageBuffer, {
    filename    : 'photo.jpg',
    contentType : 'image/jpeg',
  });
  form.append('size', 'auto');

  let res;
  try {
    res = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
      headers      : { ...form.getHeaders(), 'X-Api-Key': process.env.REMOVE_BG_API_KEY },
      responseType : 'arraybuffer',
      timeout      : 60000,
    });
  } catch (axiosErr) {
    // Extract status from axios error response
    const status = axiosErr.response?.status;
    let code = 'unknown';
    try {
      const json = JSON.parse(Buffer.from(axiosErr.response?.data || '').toString());
      code = json.errors?.[0]?.code || 'unknown';
    } catch {}
    const err = new Error(`remove.bg failed [${status}]: ${code}`);
    err.status = status;
    throw err;
  }

  return Buffer.from(res.data); // PNG with alpha channel
}

// ══════════════════════════════════════════════════════════
// STEP 2: Apply solid background color using sharp
// ══════════════════════════════════════════════════════════
async function applyBackground(pngBuffer, bgHex = '#ffffff') {
  const { r, g, b } = hexToRgb(bgHex);
  const meta = await sharp(pngBuffer).metadata();

  // Create solid background layer
  const bgLayer = await sharp({
    create: {
      width    : meta.width,
      height   : meta.height,
      channels : 4,
      background: { r, g, b, alpha: 1 },
    },
  }).png().toBuffer();

  // Composite the transparent PNG on top of solid background
  const composited = await sharp(bgLayer)
    .composite([{ input: pngBuffer, blend: 'over' }])
    .jpeg({ quality: 96, mozjpeg: true })
    .toBuffer();

  return composited;
}

// ══════════════════════════════════════════════════════════
// STEP 3: AI Photo Enhancement — cutout.pro photoEnhance
//   Docs: https://www.cutout.pro/api/photoEnhance
//   Enhances: face sharpening, noise reduction, color grading
//   Non-fatal: if it fails, original image is used
// ══════════════════════════════════════════════════════════
async function enhanceWithCutoutPro(imageBuffer) {
  if (!process.env.CUTOUT_PRO_API_KEY || process.env.CUTOUT_PRO_API_KEY === 'your_cutout_pro_api_key_here') {
    console.warn('⚠️  CUTOUT_PRO_API_KEY not set — skipping enhancement');
    return imageBuffer;
  }

  try {
    const form = new FormData();
    form.append('file', imageBuffer, {
      filename    : 'photo.jpg',
      contentType : 'image/jpeg',
    });

    const res = await axios.post(
      'https://www.cutout.pro/api/v1/photoEnhance',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'APIKEY': process.env.CUTOUT_PRO_API_KEY,
        },
        responseType : 'arraybuffer',
        timeout      : 90000,
      }
    );

    if (res.status === 200 && res.data && Buffer.from(res.data).byteLength > 1000) {
      console.log('  ✅ cutout.pro enhancement applied');
      return Buffer.from(res.data);
    }

    console.warn('  ⚠️  cutout.pro: empty response — using original');
    return imageBuffer;

  } catch (err) {
    // Enhancement is optional — never block the main pipeline
    console.warn(`  ⚠️  cutout.pro enhance skipped: ${err.response?.status || err.message}`);
    return imageBuffer;
  }
}

// ══════════════════════════════════════════════════════════
// STEP 4: Upload to Cloudinary (non-blocking CDN backup)
// ══════════════════════════════════════════════════════════
async function uploadToCloudinary(imageBuffer, publicId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME === 'your_cloud_name') {
    return null;
  }
  return new Promise((resolve) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        public_id     : publicId,
        folder        : 'passport-pro/processed',
        overwrite     : true,
        resource_type : 'image',
        quality       : 'auto:best',
        format        : 'jpg',
      },
      (error, result) => {
        if (error) {
          console.warn('  ⚠️  Cloudinary upload failed:', error.message);
          resolve(null);
        } else {
          console.log(`  ☁️  Cloudinary saved: ${result.secure_url}`);
          resolve(result.secure_url);
        }
      }
    );
    streamifier.createReadStream(imageBuffer).pipe(uploadStream);
  });
}

// ══════════════════════════════════════════════════════════
// STEP 5: Resize to passport dimensions + add black border
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
    passportW = 325,    // ✏️ 390 se 325 karo
    passportH = 400,    // ✏️ 480 se 400 karo
    borderPx  = 2,
    spacing   = 8,      // ✏️ 10 se 8 karo
  } = options;

  const MARGIN_X = 30;
  const MARGIN_Y = 30;
  
  const A4_W     = 2480;  // 300 DPI A4 width  (210mm)
  const A4_H     = 3508;  // 300 DPI A4 height (297mm)
  const cellW    = passportW + borderPx * 2;
  const cellH    = passportH + borderPx * 2;

  // Flatten all copies into a single cells array
  const cells = [];
  for (const { buffer, copies } of passportImages) {
    for (let c = 0; c < copies; c++) cells.push(buffer);
  }

  // Calculate positions, splitting into pages when needed
  const pages          = [];
  let pageComposites   = [];
  let x = MARGIN_X, y = MARGIN_Y;

  for (const cellBuf of cells) {
    if (x + cellW > A4_W - MARGIN_X) {
      x  = MARGIN_X;
      y += cellH + spacing;
    }
    if (y + cellH > A4_H - MARGIN_Y) {
      pages.push(pageComposites);
      pageComposites = [];
      x = MARGIN_X;
      y = MARGIN_Y;
    }
    pageComposites.push({ input: cellBuf, left: x, top: y });
    x += cellW + spacing;
  }
  if (pageComposites.length) pages.push(pageComposites);

  // Render each page to a high-quality JPEG buffer
  const pageBuffers = [];
  for (const composites of pages) {
    const pageJpeg = await sharp({
      create: {
        width      : A4_W,
        height     : A4_H,
        channels   : 3,
        background : { r: 255, g: 255, b: 255 },
      },
    })
      .composite(composites)
      .jpeg({ quality: 95 })
      .toBuffer();
    pageBuffers.push(pageJpeg);
  }

  return pageBuffers;
}

// ══════════════════════════════════════════════════════════
// STEP 7: Encode all page JEPGs into a single multi-page PDF
// ══════════════════════════════════════════════════════════
async function buildPDF(pageBuffers) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size        : [595.28, 841.89],  // A4 in PDF points
      margins     : { top: 0, bottom: 0, left: 0, right: 0 },
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
// MAIN EXPORT: Full pipeline for a batch of images
// ══════════════════════════════════════════════════════════
async function processPassportBatch(imagesData, options) {
  /**
   * @param {Array}  imagesData  — [{ buffer, copies, name }]
   * @param {Object} options     — { bgColor, width, height, border, spacing, userId }
   * @returns {Buffer}           — PDF buffer ready to send
   */
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

    // ── 1. Remove background ─────────────────────────────
    console.log('  → Step 1: remove.bg (background removal)...');
    const noBgBuffer = await removeBg(buffer);

    // ── 2. Apply background color ────────────────────────
    console.log(`  → Step 2: Applying background color ${bgColor}...`);
    const withBgBuffer = await applyBackground(noBgBuffer, bgColor);

    // ── 3. Enhance with cutout.pro ───────────────────────
    console.log('  → Step 3: cutout.pro AI enhancement...');
    const enhancedBuffer = await enhanceWithCutoutPro(withBgBuffer);

    // ── 4. Cloudinary backup (non-blocking, fire & forget) ─
    const cloudId = `user_${userId}_${Date.now()}_${i}`;
    uploadToCloudinary(enhancedBuffer, cloudId).catch(() => {});

    // ── 5. Resize to passport size + border ─────────────
    console.log(`  → Step 5: Resize to ${width}×${height}px + ${border}px border...`);
    const passportBuffer = await makePassportPhoto(enhancedBuffer, {
      width, height, borderPx: border,
    });

    passportImages.push({ buffer: passportBuffer, copies });
    console.log(`  ✅ Image ${i+1} ready — ${copies} copies queued`);
  }

  // ── 6. Build A4 layout ───────────────────────────────
  console.log('\n  → Step 6: Building A4 passport sheet layout...');
  const pageBuffers = await buildPassportSheet(passportImages, {
    passportW : width,
    passportH : height,
    borderPx  : border,
    spacing,
  });

  // ── 7. Encode to PDF ─────────────────────────────────
  console.log(`  → Step 7: Encoding ${pageBuffers.length} page(s) to PDF...`);
  const pdfBuffer = await buildPDF(pageBuffers);

  console.log(`\n✅ PDF generated — ${(pdfBuffer.length / 1024).toFixed(1)} KB\n`);
  return pdfBuffer;
}

module.exports = { processPassportBatch };
