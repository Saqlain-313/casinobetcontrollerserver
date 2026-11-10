
import mongoose from 'mongoose';

const roundSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
    },

    roundId: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ['betting', 'closed', 'settled'],
      default: 'betting',
    },

    marketData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    lastSyncedAt: Date,

    bettingEndsAt: Date,

    providerClosed: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

roundSchema.index(
  { slug: 1, roundId: 1 },
  { unique: true }
);

export default mongoose.model('Round', roundSchema);
