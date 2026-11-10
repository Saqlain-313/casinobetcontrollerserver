import Round from '../models/CasinoRound.js';

const isActive = (s) => ['ACTIVE', 'OPEN'].includes(String(s ?? '').toUpperCase());

export const saveCasinoRoundSnapshot = async (slug, data) => {
  if (!data?.mid) return null;

  const roundId = String(data.mid);

  const hasActiveMarket =
    Array.isArray(data.sub) && data.sub.some((item) => isActive(item.gstatus));

  const liveStatus = hasActiveMarket ? 'betting' : 'closed';

  // 1) Naya data hamesha save karo; settled round ka status kabhi mat chhedo
  let updated;
  try {
    updated = await Round.findOneAndUpdate(
      { slug, roundId, status: { $ne: 'settled' } },
      {
        $set: {
          marketData: data,
          lastSyncedAt: new Date(),
          status: liveStatus,
          providerClosed: !hasActiveMarket,
        },
      },
      { upsert: true, new: true }
    );
  } catch (e) {
    // Round already settled hai -> upsert duplicate banana chaha (unique index)
    if (e.code !== 11000) throw e;
    updated = null;
  }

  // 2) Settled hai to marketData refresh karo, status na badlo
  if (!updated) {
    return Round.findOneAndUpdate(
      { slug, roundId },
      { $set: { marketData: data, lastSyncedAt: new Date() } },
      { new: true }
    );
  }

  return updated;
};