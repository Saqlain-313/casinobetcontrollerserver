import mongoose from 'mongoose';

const betSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  slug: { type: String, required: true, index: true },
  roundId: { type: String, required: true, index: true },
  side: { type: String, enum: ['back', 'lay'], required: true },
  selection: { type: String, required: true },
  odds: { type: Number, required: true },
  stake: { type: Number, required: true },
  exposure: { type: Number, required: true },          // amount deducted at placement
  status: { type: String, enum: ['pending', 'settled', 'void'], default: 'pending', index: true },
  outcome: { type: String, enum: ['win', 'lose', 'push', 'half_loss', null], default: null },
  payout: { type: Number, default: 0 },                // gross credited back
  net: { type: Number, default: 0 },                   // payout - exposure
  settledAt: Date,
}, { timestamps: true });

betSchema.index({ slug: 1, roundId: 1, status: 1 });

export default mongoose.models.CasinoBet || mongoose.model('CasinoBet', betSchema);