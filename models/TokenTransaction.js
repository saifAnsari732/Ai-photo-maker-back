const mongoose = require('mongoose');

const tokenTransactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  type: {
    type: String,
    enum: ['credit', 'debit'],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  balanceAfter: {
    type: Number,
    required: true,
  },
  description: {
    type: String,
    default: '',
  },
  givenBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null, // null = system (registration), ObjectId = admin
  },
}, { timestamps: true });

module.exports = mongoose.model('TokenTransaction', tokenTransactionSchema);
