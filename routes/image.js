const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect } = require('../middleware/auth');
const { processImage, getTokenHistory } = require('../controllers/imageController');

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP allowed'), false);
  },
});

// Accept image_0, image_1, ... image_9
const uploadFields = Array.from({ length: 10 }, (_, i) => ({ name: `image_${i}`, maxCount: 1 }));
uploadFields.push({ name: 'image', maxCount: 1 });

router.post('/process', protect, upload.fields(uploadFields), processImage);
router.get('/token-history', protect, getTokenHistory);

module.exports = router;
