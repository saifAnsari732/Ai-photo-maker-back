const User = require('../models/User');
const TokenTransaction = require('../models/TokenTransaction');

// GET /api/admin/users
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find({ role: 'user' })
      .select('-password')
      .sort({ createdAt: -1 });

    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// GET /api/admin/users/:id
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const transactions = await TokenTransaction.find({ user: user._id })
      .populate('givenBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({ success: true, user, transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// POST /api/admin/give-tokens
exports.giveTokens = async (req, res) => {
  try {
    const { userId, amount, description } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'userId and valid amount required.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role === 'admin') return res.status(400).json({ success: false, message: 'Cannot give tokens to admin.' });

    user.tokens += parseInt(amount);
    user.totalTokensGiven += parseInt(amount);
    await user.save();

    await TokenTransaction.create({
      user: user._id,
      type: 'credit',
      amount: parseInt(amount),
      balanceAfter: user.tokens,
      description: description || `Tokens added by admin`,
      givenBy: req.user._id,
    });

    res.json({
      success: true,
      message: `${amount} tokens given to ${user.name}`,
      newBalance: user.tokens,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// POST /api/admin/deduct-tokens
exports.deductTokens = async (req, res) => {
  try {
    const { userId, amount, description } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'userId and valid amount required.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (user.tokens < amount) {
      return res.status(400).json({ success: false, message: 'User does not have enough tokens.' });
    }

    user.tokens -= parseInt(amount);
    await user.save();

    await TokenTransaction.create({
      user: user._id,
      type: 'debit',
      amount: parseInt(amount),
      balanceAfter: user.tokens,
      description: description || `Tokens deducted by admin`,
      givenBy: req.user._id,
    });

    res.json({
      success: true,
      message: `${amount} tokens deducted from ${user.name}`,
      newBalance: user.tokens,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// PATCH /api/admin/toggle-user/:id
exports.toggleUserStatus = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    user.isActive = !user.isActive;
    await user.save();

    res.json({
      success: true,
      message: `User ${user.isActive ? 'activated' : 'deactivated'}`,
      isActive: user.isActive,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// GET /api/admin/stats
exports.getStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({ role: 'user' });
    const activeUsers = await User.countDocuments({ role: 'user', isActive: true });
    const totalImages = await User.aggregate([
      { $match: { role: 'user' } },
      { $group: { _id: null, total: { $sum: '$totalImagesGenerated' } } }
    ]);
    const totalTokensGiven = await User.aggregate([
      { $match: { role: 'user' } },
      { $group: { _id: null, total: { $sum: '$totalTokensGiven' } } }
    ]);
    const recentUsers = await User.find({ role: 'user' })
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        totalImagesGenerated: totalImages[0]?.total || 0,
        totalTokensGiven: totalTokensGiven[0]?.total || 0,
      },
      recentUsers,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
