const User               = require('../models/User');
const TokenTransaction   = require('../models/TokenTransaction');
const { processPassportBatch } = require('../services/imageService');

// ══════════════════════════════════════════════════════════
// POST /api/image/process
// ══════════════════════════════════════════════════════════
exports.processImage = async (req, res) => {
  try {
    // ── Token check ──────────────────────────────────────
    const user = await User.findById(req.user._id);

    if (user.tokens <= 0) {
      return res.status(403).json({
        success : false,
        message : '🚫 Token khatam ho gaye! Admin se contact karein.',
        tokens  : 0,
      });
    }

    // ── Collect uploaded images ──────────────────────────
    const imagesData = [];
    let i = 0;
    while (req.files && req.files[`image_${i}`]) {
      const file = req.files[`image_${i}`][0];
      imagesData.push({
        buffer : file.buffer,
        name   : file.originalname,
        copies : parseInt(req.body[`copies_${i}`]) || 6,
      });
      i++;
    }
    // Fallback: single image field
    if (i === 0 && req.files?.image) {
      const file = req.files.image[0];
      imagesData.push({
        buffer : file.buffer,
        name   : file.originalname,
        copies : parseInt(req.body.copies) || 6,
      });
    }

    if (!imagesData.length) {
      return res.status(400).json({ success: false, message: 'Koi image upload nahi ki.' });
    }

    // ── Run full pipeline ────────────────────────────────
// ── Run full pipeline ────────────────────────────────
const pdfBuffer = await processPassportBatch(imagesData, {
  bgColor : req.body.bg_color  || '#ffffff',
  width   : parseInt(req.body.width)   || 325,    // ✏️ 390 se 325 karo
  height  : parseInt(req.body.height)  || 400,    // ✏️ 480 se 400 karo
  border  : parseInt(req.body.border)  || 2,
  spacing : parseInt(req.body.spacing) || 8,      // ✏️ 10 se 8 karo
  userId  : req.user._id.toString(),
});

    // ── Deduct 1 token after success ─────────────────────
    user.tokens            -= 1;
    user.totalImagesGenerated += 1;
    await user.save();

    await TokenTransaction.create({
      user        : user._id,
      type        : 'debit',
      amount      : 1,
      balanceAfter: user.tokens,
      description : 'Passport photo sheet generated',
      givenBy     : null,
    });

    // ── Send PDF ─────────────────────────────────────────
    res.set('Content-Type',        'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="passport-sheet.pdf"');
    res.set('X-Tokens-Remaining',  user.tokens);
    res.send(pdfBuffer);

  } catch (err) {
    console.error('❌ processImage error:', err.message);

    // remove.bg specific errors
    if (err.status === 402 || err.message?.includes('402')) {
      return res.status(402).json({
        success: false,
        message: 'remove.bg credit khatam! API quota exceed ho gaya.',
      });
    }
    if (err.status === 403 || err.message?.includes('auth')) {
      return res.status(401).json({
        success: false,
        message: 'remove.bg API key invalid hai. Admin se contact karein.',
      });
    }
    if (err.message?.includes('remove.bg')) {
      return res.status(500).json({
        success: false,
        message: `Background remove failed: ${err.message}`,
      });
    }

    res.status(500).json({
      success: false,
      message: 'Image processing failed. Please try again.',
    });
  }
};

// ══════════════════════════════════════════════════════════
// GET /api/image/token-history
// ══════════════════════════════════════════════════════════
exports.getTokenHistory = async (req, res) => {
  try {
    const transactions = await TokenTransaction.find({ user: req.user._id })
      .populate('givenBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success     : true,
      transactions,
      currentTokens: req.user.tokens,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
