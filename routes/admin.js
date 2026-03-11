const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/auth');
const {
  getAllUsers, getUserById, giveTokens,
  deductTokens, toggleUserStatus, getStats,
} = require('../controllers/adminController');

router.use(protect, adminOnly);

router.get('/stats',          getStats);
router.get('/users',          getAllUsers);
router.get('/users/:id',      getUserById);
router.post('/give-tokens',   giveTokens);
router.post('/deduct-tokens', deductTokens);
router.patch('/toggle-user/:id', toggleUserStatus);

module.exports = router;
