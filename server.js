/**
 * server.js — Passport Photo Pro Backend
 * Pure Node.js (Express + MongoDB) — No Python/Flask needed
 * Pipeline: remove.bg → sharp → cutout.pro → Cloudinary → PDF
 */

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
require('dotenv').config();

const app = express();
  
// ── Middleware ───────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ───────────────────────────────────────────────
app.use('/api/auth',  require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/image', require('./routes/image'));

// Health check
app.get('/api/health', (req, res) =>
  res.json({
    status  : 'OK',
    version : '2.0 (Node.js only)',
    time    : new Date(),
    pipeline: ['remove.bg', 'sharp', 'cutout.pro', 'cloudinary', 'pdfkit'],
  })
);

// ── Start server ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('✅ MongoDB Connected');

    // Create default admin if not exists
    const User = require('./models/User');
    const adminExists = await User.findOne({ role: 'admin' });
    if (!adminExists) {
      await User.create({
        name     : 'Admin',
        shopName : 'Passport Photo Pro',
        email    : 'admin@passportpro.com',
        password : 'admin123456',
        role     : 'admin',
        tokens   : 999999,
      });  
      console.log('✅ Admin created  →  admin@passportpro.com  /  admin123456');
      console.log('⚠️  Please change the admin password after first login!');
    }

    app.listen(PORT, () => {
      console.log(`\n🚀 Server running on http://localhost:${PORT}`);
      console.log('📦 Pipeline: remove.bg → sharp → cutout.pro → cloudinary → pdfkit\n');
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
 