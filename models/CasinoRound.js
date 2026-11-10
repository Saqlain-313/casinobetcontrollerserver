import mongoose from 'mongoose';

const casinoRoundSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, trim: true },
    roundId: { type: String, required: true, trim: true },

    // Only 'betting' rounds can receive new bets.
    status: {
      type: String,
      enum: ['betting', 'closed', 'settled'],
      default: 'closed',
      index: true,
    },

    // Immutable-by-round snapshot of provider data for this MID.
    marketData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    providerClosed: { type: Boolean, default: false },
    bettingEndsAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

casinoRoundSchema.index({ slug: 1, roundId: 1 }, { unique: true });

export default mongoose.models.CasinoRound ||
  mongoose.model('CasinoRound', casinoRoundSchema);
