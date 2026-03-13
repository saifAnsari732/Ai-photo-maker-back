/**
 * imageService.js — PhotoRoom AI Background Removal
 * ══════════════════════════════════════════════════
 *  STEP 1 → PhotoRoom API  : AI background removal (1000 free/month)
 *           Fallback        : original image if API fails
 *  STEP 2 → sharp          : Apply background colour
 *  STEP 3 → cutout.pro     : Enhancement (optional)
 *  STEP 4 → Cloudinary     : Save original + processed
 *  STEP 5 → sharp          : Resize + border
 *  STEP 6 → sharp          : A4 layout
 *  STEP 7 → PDFKit         : PDF export
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

// ══════════════════════════════════════════════════════════
// STEP 1: PhotoRoom AI Background Removal
// 1000 free images/month, no memory issues on Render
// ══════════════════════════════════════════════════════════
async function removeBg(imageBuffer) {
  const apiKey = process.env.PHOTOROOM_API_KEY;

  if (!apiKey) {
    console.warn('  ⚠️  PHOTOROOM_API_KEY not set — skipping bg removal');
    return imageBuffer;
  }

  try {
    console.log('  → Step 1: PhotoRoom AI background removal...');

    const form = new FormData();
    form.append('image_file', imageBuffer, {
      filename    : 'photo.jpg',
      contentType : 'image/jpeg',
    });

    const res = await axios.post(
      'https://sdk.photoroom.com/v1/segment',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'x-api-key'  : apiKey,
          'Accept'     : 'image/png',
        },
        responseType : 'arraybuffer',
        timeout      : 60000,
      }
    );

    if (res.status === 200 && res.data) {
      console.log('  ✅ PhotoRoom bg removal success');
      return Buffer.from(res.data); // PNG with alpha
    }

    console.warn('  ⚠️  PhotoRoom: unexpected response — using original');
    return imageBuffer;

  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data
      ? Buffer.from(err.response.data).toString().slice(0, 100)
      : err.message;
    console.warn(`  ⚠️  PhotoRoom failed [${status}]: ${message} — using original`);
    return imageBuffer;
  }
}

// ══════════════════════════════════════════════════════════
// STEP 2: Apply background colour
// ══════════════════════════════════════════════════════════
async function applyBackground(pngBuffer, bgHex = '#ffffff') {
  const { r, g, b } = hexToRgb(bgHex);

  // Check if buffer is actually PNG with alpha or fallback JPEG
  const meta = await sharp(pngBuffer).metadata();

  if (meta.hasAlpha) {
    // Proper alpha compositing
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
  } else {
    // No alpha — just put image on bg colour canvas
    const rgb = await sharp(pngBuffer).jpeg({ quality: 96 }).toBuffer();
    const bgLayer = await sharp({
      create: {
        width: meta.width, height: meta.height,
        channels: 3, background: { r, g, b },
      },
    }).jpeg().toBuffer();
    return sharp(bgLayer)
      .composite([{ input: rgb, blend: 'over' }])
      .jpeg({ quality: 96 })
      .toBuffer();
  }
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
    const form = new FormData();
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
// STEP 4: Cloudinary upload (non-blocking)
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
// STEP 5: Resize + border
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
// STEP 6: A4 layout
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
// STEP 7: PDF
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

    // 1. PhotoRoom bg removal
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