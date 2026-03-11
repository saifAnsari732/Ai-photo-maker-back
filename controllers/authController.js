const User = require('../models/User');
const TokenTransaction = require('../models/TokenTransaction');
const jwt = require('jsonwebtoken');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '10h' });

// POST /api/auth/register
exports.register = async (req, res) => {
  try {
    const { name, shopName, email, password } = req.body;

    if (!name || !shopName || !email || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ success: false, message: 'Email already registered.' });

    const defaultTokens = parseInt(process.env.DEFAULT_TOKENS) || 50;
    const user = await User.create({ name, shopName, email, password, tokens: defaultTokens });

    // Log initial token credit
    await TokenTransaction.create({
      user: user._id,
      type: 'credit',
      amount: defaultTokens,
      balanceAfter: defaultTokens,
      description: 'Welcome bonus tokens on registration',
      givenBy: null,
    });

    const token = signToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Registration successful!',
      token,
      user: {
        id: user._id,
        name: user.name,
        shopName: user.shopName,
        email: user.email,
        role: user.role,
        tokens: user.tokens,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error. Try again.' });
  }
};

// POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

    if (!user.isActive) return res.status(403).json({ success: false, message: 'Account is disabled. Contact admin.' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

    const token = signToken(user._id);

    res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: {
        id: user._id,
        name: user.name,
        shopName: user.shopName,
        email: user.email,
        role: user.role,
        tokens: user.tokens,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error. Try again.' });
  }
};

// GET /api/auth/me
exports.getMe = async (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user._id,
      name: req.user.name,
      shopName: req.user.shopName,
      email: req.user.email,
      role: req.user.role,
      tokens: req.user.tokens,
      totalImagesGenerated: req.user.totalImagesGenerated,
    },
  });
};
