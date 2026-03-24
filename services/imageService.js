/**
 * imageService.js — rembg Free Background Removal
 * ══════════════════════════════════════════════════
 *  STEP 1 → rembg (Python) : Free local bg removal, no API key needed
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
const { execSync } = require('child_process');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');

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

async function removeBg(imageBuffer, bgColor = '#ffffff') {
  const tmpDir    = os.tmpdir();
  const inputPath = path.join(tmpDir, `rembg_in_${Date.now()}.jpg`);
  const outPath   = path.join(tmpDir, `rembg_out_${Date.now()}.jpg`);
  const pythonCmd  = process.platform === 'win32' ? 'python' : 'python3';
  const scriptPath = path.join(__dirname, '..', 'remove_bg.py');
// mmfm md cqejlkvwrivuwrbwr ib
  try {
    console.log(`  → Step 1: rembg bg removal (color: ${bgColor})...`);
    fs.writeFileSync(inputPath, imageBuffer);
    execSync(
      `${pythonCmd} "${scriptPath}" "${inputPath}" "${outPath}" "${bgColor}"`,
      { timeout: 120000, stdio: 'inherit' }
    );
    if (fs.existsSync(outPath)) {
      const result = fs.readFileSync(outPath);
      console.log('  ✅ rembg success');
      return result;
    }
    throw new Error('Output file not created');
  } catch (err) {
    console.warn(`  ⚠️  rembg failed: ${err.message} — using original`);
    return imageBuffer;
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outPath))   fs.unlinkSync(outPath);
  }
}
async function applyBackground(pngBuffer, bgHex = '#ffffff') {
  const { r, g, b } = hexToRgb(bgHex);
  const meta = await sharp(pngBuffer).metadata();
  if (meta.hasAlpha) {
    const bgLayer = await sharp({
      create: { width: meta.width, height: meta.height, channels: 4, background: { r, g, b, alpha: 1 } },
    }).png().toBuffer();
    return sharp(bgLayer).composite([{ input: pngBuffer, blend: 'over' }]).jpeg({ quality: 96, mozjpeg: true }).toBuffer();
  } else {
    console.log('  → Step 2: bg already applied by rembg');
    return sharp(pngBuffer).jpeg({ quality: 96 }).toBuffer();
  }
}

async function enhanceWithCutoutPro(imageBuffer) {
  if (!process.env.CUTOUT_PRO_API_KEY) { console.log('  → Step 3: Enhancement skipped'); return imageBuffer; }
  try {
    const form = new FormData();
    form.append('file', imageBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    const res = await axios.post('https://www.cutout.pro/api/v1/photoEnhance', form, {
      headers: { ...form.getHeaders(), 'APIKEY': process.env.CUTOUT_PRO_API_KEY },
      responseType: 'arraybuffer', timeout: 90000,
    });
    if (res.status === 200 && Buffer.from(res.data).byteLength > 1000) return Buffer.from(res.data);
    return imageBuffer;
  } catch (err) { console.warn(`  ⚠️  cutout.pro skipped: ${err.response?.status || err.message}`); return imageBuffer; }
}

async function uploadToCloudinary(imageBuffer, folder, publicId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return null;
  return new Promise((resolve) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: publicId, folder: `passport-pro/${folder}`, overwrite: true, resource_type: 'image', quality: 'auto:best', format: 'jpg' },
      (error, result) => {
        if (error) { console.warn(`  ⚠️  Cloudinary [${folder}]:`, error.message); resolve(null); }
        else { console.log(`  ☁️  Cloudinary [${folder}]: ${result.secure_url}`); resolve(result.secure_url); }
      }
    );
    streamifier.createReadStream(imageBuffer).pipe(stream);
  });
}

async function makePassportPhoto(imageBuffer, { width = 390, height = 480, borderPx = 2 }) {
  const resized = await sharp(imageBuffer).resize(width, height, { fit: 'cover', position: 'top' }).jpeg({ quality: 98 }).toBuffer();
  return sharp(resized).extend({ top: borderPx, bottom: borderPx, left: borderPx, right: borderPx, background: { r: 0, g: 0, b: 0, alpha: 1 } }).jpeg({ quality: 98 }).toBuffer();
}

async function buildPassportSheet(passportImages, options) {
  const { passportW = 390, passportH = 480, borderPx = 2, spacing = 10 } = options;
  const MARGIN_X = 30, MARGIN_Y = 30, A4_W = 2480, A4_H = 3508;
  const cellW = passportW + borderPx * 2, cellH = passportH + borderPx * 2;
  const cells = [];
  for (const { buffer, copies } of passportImages) for (let c = 0; c < copies; c++) cells.push(buffer);
  const pages = []; let composites = []; let x = MARGIN_X, y = MARGIN_Y;
  for (const cellBuf of cells) {
    if (x + cellW > A4_W - MARGIN_X) { x = MARGIN_X; y += cellH + spacing; }
    if (y + cellH > A4_H - MARGIN_Y) { pages.push(composites); composites = []; x = MARGIN_X; y = MARGIN_Y; }
    composites.push({ input: cellBuf, left: x, top: y });
    x += cellW + spacing;
  }
  if (composites.length) pages.push(composites);
  const pageBuffers = [];
  for (const comp of pages) {
    const buf = await sharp({ create: { width: A4_W, height: A4_H, channels: 3, background: { r: 255, g: 255, b: 255 } } }).composite(comp).jpeg({ quality: 95 }).toBuffer();
    pageBuffers.push(buf);
  }
  return pageBuffers;
}

async function buildPDF(pageBuffers) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [595.28, 841.89], margins: { top: 0, bottom: 0, left: 0, right: 0 }, autoFirstPage: false });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const buf of pageBuffers) { doc.addPage(); doc.image(buf, 0, 0, { width: 595.28, height: 841.89 }); }
    doc.end();
  });
}

async function processPassportBatch(imagesData, options) {
  const { bgColor = '#ffffff', width = 390, height = 480, border = 2, spacing = 10, userId = 'unknown' } = options;
  const passportImages = [];
  for (let i = 0; i < imagesData.length; i++) {
    const { buffer, copies, name } = imagesData[i];
    console.log(`\n📸 [${i+1}/${imagesData.length}] Processing: ${name}`);
    const noBgBuffer    = await removeBg(buffer, bgColor);
    uploadToCloudinary(buffer, 'originals', `orig_${userId}_${Date.now()}_${i}`).catch(() => {});
    const withBgBuffer  = await applyBackground(noBgBuffer, bgColor);
    const enhancedBuffer = await enhanceWithCutoutPro(withBgBuffer);
    uploadToCloudinary(enhancedBuffer, 'processed', `proc_${userId}_${Date.now()}_${i}`).catch(() => {});
    const passportBuffer = await makePassportPhoto(enhancedBuffer, { width, height, borderPx: border });
    passportImages.push({ buffer: passportBuffer, copies });
    console.log(`  ✅ Image ${i+1} ready — ${copies} copies`);
  }
  const pageBuffers = await buildPassportSheet(passportImages, { passportW: width, passportH: height, borderPx: border, spacing });
  const pdfBuffer = await buildPDF(pageBuffers);
  console.log(`\n✅ PDF ready — ${(pdfBuffer.length / 1024).toFixed(1)} KB\n`);
  return pdfBuffer;
}

module.exports = { processPassportBatch };