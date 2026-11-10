import axios from 'axios';
import Bet from '../models/CasinoBet.js';
import Round from '../models/CasinoRound.js';
import User from '../models/subAdminModel.js'; // existing User model (numeric `balance`) - adjust path
import * as engine from '../services/casinoEngine.js';
import { saveCasinoRoundSnapshot } from '../services/casinoRoundSync.js';

const API_URL = process.env.API_URL;
const API_KEY = process.env.API_KEY;
const DEBUG = process.env.CASINO_DEBUG === '1';

// Itni der (minutes) se pending bet ko auto-refund kar diya jayega
// (result API sirf latest rounds deta hai, purane round ka result nahi milta). 0 = band.
const STALE_BET_MINUTES = Number(process.env.STALE_BET_MINUTES ?? 30);

const getUid = (req) => req.id ?? req.user?._id; // placeBet used req.id, others req.user._id

// Provider kabhi ACTIVE bhejta hai, kabhi OPEN
const isActive = (s) => ['ACTIVE', 'OPEN'].includes(String(s ?? '').toUpperCase());

// ======================================================================
// Provider API helpers
// ======================================================================

// LIVE DATA API  -> used for placing bets (current round / betting status)
export const fetchCasinoData = async (slug) => {
  const url = `${API_URL}/diamond/casino/data/${encodeURIComponent(slug)}?key=${API_KEY}`;
  try {
    const response = await axios.get(url, { timeout: 15000 });
    if (DEBUG) console.log('Casino DATA API:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('CASINO DATA API ERROR:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      response: error.response?.data,
    });
    throw error;
  }
};

// RESULT API -> used for settling
// Response: { success, data: { res: [{ mid, win }, ...newest first], res1: { cname } } }
export const fetchCasinoResult = async (slug) => {
  const url = `${API_URL}/diamond/casino/result/${encodeURIComponent(slug)}?key=${API_KEY}`;
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    if (DEBUG) console.log('Casino RESULT API:', JSON.stringify(data, null, 2));
    if (!data || data.success === false || !Array.isArray(data.data?.res)) {
      throw new Error('Bad result API response');
    }
    return data.data.res;
  } catch (error) {
    console.error('CASINO RESULT API ERROR:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
    });
    throw error;
  }
};

// Provider `win` code -> result object for engine.
// lucky7: "1" = Low (A-6), "2" = High (8-K), "0" = Tie (7)   -- verify once on a known round.
// NOTE: result API has no card, so odd/even, red/black, card-specific markets
// can't be settled from it. Handle result.side in engine.evaluateSelection('lucky7', ...).
const normalizeResult = (slug, win) => {
  const fam = engine.familyOf(slug);
  const w = String(win);
  if (fam === 'lucky7') {
    return { win: w, side: w === '1' ? 'low' : w === '2' ? 'high' : 'tie' };
  }
  // add other families once their `win` codes are known
  throw new Error(`No win-code mapping for ${slug}`);
};

// Bet ka user-facing result label: win / lose / push / void / pending
const betResult = (b) => {
  if (b.status === 'pending') return 'pending';
  if (b.status === 'void') return 'void';
  if (b.net > 0) return 'win';
  if (b.net < 0) return 'lose';
  return 'push';
};

// ======================================================================
// placeBet
// ======================================================================

// Controller ke andar hi helpers, taaki casinoEngine me mogambo na ho tab bhi chale
const localValidateBet = ({ side, selection, odds, stake }) => {
  const errors = [];
  if (!['back', 'lay'].includes(String(side || '').toLowerCase())) {
    errors.push('side must be back or lay');
  }
  if (selection === undefined || selection === null || String(selection).trim() === '') {
    errors.push('selection is required');
  }
  if (!Number.isFinite(odds) || odds <= 1) errors.push('odds must be greater than 1');
  if (!Number.isFinite(stake) || stake <= 0) errors.push('stake must be greater than 0');
  return errors;
};

// back: stake | lay: stake * (odds - 1)
const localCalcExposure = ({ side, stake, odds }) => {
  const exposure = String(side || '').toLowerCase() === 'lay' ? stake * (odds - 1) : stake;
  return Math.round(exposure * 100) / 100;
};

export const placeBet = async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const userId = getUid(req);
  const { roundId, side, selection } = req.body || {};
  const odds = Number(req.body?.odds);
  const stake = Number(req.body?.stake);

  console.log('placeBet request:', { slug, userId, roundId, side, selection, odds, stake });

  try {
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized user' });
    }

    if (!slug) {
      return res.status(400).json({ success: false, message: 'Game slug is required' });
    }

    // engine.familyOf par block nahi karte. Provider hi decide karta hai
    // ki game valid hai ya nahi (fetchCasinoData + gtype check neeche).
    let family = null;
    try {
      family = engine.familyOf?.(slug) || null;
    } catch (e) {
      console.warn('engine.familyOf failed:', e.message);
    }
    console.log('family:', family || 'generic');

    if (selection === undefined || selection === null) {
      return res.status(400).json({
        success: false,
        message: 'selection is required',
      });
    }

    if (!Number.isFinite(odds) || !Number.isFinite(stake) || stake <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid odds or stake' });
    }

    // Engine validation use karo, par "Game not supported" error ignore karo
    let errors = localValidateBet({ side, selection, odds, stake });
    if (family && typeof engine.validateBet === 'function') {
      try {
        const engineErrors = engine.validateBet(slug, { side, selection, odds, stake }) || [];
        errors = engineErrors.filter((e) => !/not supported/i.test(String(e)));
      } catch (e) {
        console.warn('engine.validateBet failed:', e.message);
      }
    }
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join(', ') });
    }

    // Provider ka CURRENT round: { message, data: { mid, gtype, sub } }
    let providerResponse;
    try {
      providerResponse = await fetchCasinoData(slug);
    } catch (error) {
      console.error('Casino API error:', error);
      return res.status(503).json({
        success: false,
        message: 'Casino server unavailable. Please try again.',
      });
    }

    const liveData = providerResponse?.data;
    if (!liveData || liveData.mid === undefined || liveData.mid === null) {
      return res.status(503).json({
        success: false,
        message: 'Provider returned invalid casino data',
      });
    }

    if (liveData.gtype && String(liveData.gtype).toLowerCase() !== slug) {
      return res.status(400).json({ success: false, message: 'Invalid casino game type' });
    }

    // Snapshot background me save hota hai (stats ke liye). Bet iske result par depend nahi karta.
    saveCasinoRoundSnapshot(slug, liveData).catch((e) =>
      console.warn('saveCasinoRoundSnapshot failed:', e.message)
    );

    // Bet hamesha provider ke CURRENT round par store hoti hai.
    // Client ka roundId ignore hota hai, isliye stale roundId se error nahi aata.
    const currentRoundId = String(liveData.mid);
    if (roundId && String(roundId) !== currentRoundId) {
      console.log('placeBet: client roundId stale, using live mid', {
        clientRoundId: String(roundId),
        currentRoundId,
      });
    }

    // Market live data se hi lo (Round collection ki zarurat nahi)
    const selectedMarket = liveData.sub?.find(
      (item) => String(item.sid ?? item.i) === String(selection)
    );

    if (!selectedMarket) {
      return res.status(400).json({ success: false, message: 'Invalid selection for this round' });
    }

    // Sirf explicit band status reject hota hai. Unknown/missing gstatus allow hai.
    // Testing ke liye .env mein ALLOW_SUSPENDED_BETS=1 se ye check skip ho jata hai.
    const gs = String(selectedMarket.gstatus ?? '').trim().toUpperCase();
    const BLOCKED = ['SUSPENDED', 'CLOSED', 'INACTIVE', 'BALL RUNNING'];
    if (process.env.ALLOW_SUSPENDED_BETS !== '1' && BLOCKED.includes(gs)) {
      return res.status(400).json({
        success: false,
        message: 'This selection is suspended',
        selection: selectedMarket.nat || selectedMarket.sid,
        status: selectedMarket.gstatus || 'UNKNOWN',
      });
    }

    const minStake = Number(selectedMarket.min ?? 0);
    const maxStake = Number(selectedMarket.max ?? Infinity);

    if (stake < minStake || stake > maxStake) {
      return res.status(400).json({
        success: false,
        message: `Stake must be between ${minStake} and ${maxStake}`,
      });
    }

    // Production me client odds par bharosa mat karo; provider odds feed se verify karo.
    // await oddsService.assertOdds(slug, roundId, selection, side, odds);

    let exposure = NaN;
    if (family && typeof engine.calcExposure === 'function') {
      try {
        exposure = engine.calcExposure({ side, stake, odds });
      } catch (e) {
        console.warn('engine.calcExposure failed:', e.message);
      }
    }
    if (!Number.isFinite(exposure) || exposure <= 0) {
      exposure = localCalcExposure({ side, stake, odds });
    }
    if (!Number.isFinite(exposure) || exposure <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid bet exposure' });
    }

    // Atomic debit
    const debited = await User.findOneAndUpdate(
      { _id: userId, balance: { $gte: exposure } },
      { $inc: { balance: -exposure } },
      { new: true }
    );

    if (!debited) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    let bet;
    try {
      bet = await Bet.create({
        userId,
        slug,
        roundId: currentRoundId,
        side,
        selection,
        odds,
        stake,
        exposure,
        status: 'pending',
      });
    } catch (error) {
      // Bet insert fail hua to balance wapas
      await User.updateOne({ _id: userId }, { $inc: { balance: exposure } });
      throw error;
    }

    return res.status(201).json({
      success: true,
      message: 'Bet placed successfully',
      bet,
      balance: debited.balance,
      roundId: currentRoundId,
      latestProviderRoundId: currentRoundId,
    });
  } catch (error) {
    console.error('placeBet error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ======================================================================
// settle core (shared by manual, API and poller)
//
// Round pe koi "settled" lock nahi hai. Double-credit se bachav per-bet hai:
// pending -> settled claim sirf ek baar succeed hota hai. Isse agar crash ya
// kisi bet ka settle fail ho, to agli poll me wo bet dobara try hoti hai.
// ======================================================================
const settleCore = async (slug, roundId, result) => {
  roundId = String(roundId);

  // Round ka result save karo (void round ko overwrite nahi karte)
  await Round.updateOne(
    { slug, roundId, 'result.void': { $ne: true } },
    { $set: { status: 'settled', result }, $setOnInsert: { slug, roundId } },
    { upsert: true }
  ).catch((e) => {
    if (e.code !== 11000) throw e; // duplicate (void round already exists) -> ignore
  });

  const cursor = Bet.find({ slug, roundId, status: 'pending' }).cursor();
  let settled = 0;
  let failed = 0;

  for await (const bet of cursor) {
    try {
      const selOutcome = engine.evaluateSelection(slug, bet.selection, result);
      const s = engine.settleBet(bet, selOutcome);

      // pending -> settled is the idempotency guard (credit only once)
      const claimed = await Bet.findOneAndUpdate(
        { _id: bet._id, status: 'pending' },
        { status: 'settled', outcome: s.outcome, payout: s.payout, net: s.net, settledAt: new Date() }
      );
      if (claimed && s.payout > 0) {
        await User.updateOne({ _id: bet.userId }, { $inc: { balance: s.payout } });
      }
      settled++;
    } catch (e) {
      failed++;
      console.error(`settle failed for bet ${bet._id}:`, e.message);
    }
  }
  return { settled, failed };
};

// Ek bet ko void karke exposure refund (voidRound aur stale refund dono use karte hain)
const voidBet = async (bet) => {
  const claimed = await Bet.findOneAndUpdate(
    { _id: bet._id, status: 'pending' },
    { status: 'void', payout: bet.exposure, net: 0, settledAt: new Date() }
  );
  if (claimed) {
    await User.updateOne({ _id: bet.userId }, { $inc: { balance: bet.exposure } });
    return true;
  }
  return false;
};

// Manual settle: body { roundId, result }
export const settleRound = async (req, res) => {
  const { slug } = req.params;
  const { roundId, result } = req.body;
  try {
    if (!roundId || !result) {
      return res.status(400).json({ success: false, message: 'roundId and result required' });
    }
    const out = await settleCore(slug, roundId, result);
    return res.json({ success: true, ...out });
  } catch (err) {
    console.error('settleRound error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Auto settle from RESULT API: body { roundId }
export const settleRoundFromApi = async (req, res) => {
  const { slug } = req.params;
  const { roundId } = req.body;
  try {
    if (!roundId) return res.status(400).json({ success: false, message: 'roundId required' });

    let list;
    try {
      list = await fetchCasinoResult(slug);
    } catch {
      return res.status(503).json({ success: false, message: 'Result API unavailable' });
    }

    const row = list.find((r) => String(r.mid) === String(roundId));
    if (!row) {
      return res.status(404).json({ success: false, message: 'Result not available yet' });
    }

    const out = await settleCore(slug, roundId, normalizeResult(slug, row.win));
    return res.json({ success: true, ...out });
  } catch (err) {
    console.error('settleRoundFromApi error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ======================================================================
// Auto poller: har 1 minute, saare games (slugs) jinki pending bets hain.
// Server start par ek baar call karo: startResultPoller();
// ======================================================================
export const startResultPoller = (everyMs = 60 * 1000) => {
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const slugs = await Bet.distinct('slug', { status: 'pending' });

      for (const slug of slugs) {
        try {
          const pending = (await Bet.distinct('roundId', { slug, status: 'pending' })).map(String);
          if (!pending.length) continue;

          const list = await fetchCasinoResult(slug); // newest first
          for (const row of list) {
            if (!pending.includes(String(row.mid))) continue;
            try {
              await settleCore(slug, row.mid, normalizeResult(slug, row.win));
            } catch (e) {
              console.error(`poller settle ${slug}/${row.mid}:`, e.message);
            }
          }
        } catch (e) {
          // ek slug fail ho to baaki chalte rahein
          console.error(`poller ${slug}:`, e.message);
        }
      }

      // Result API me jo round ab nahi dikhta uski purani pending bets refund
      if (STALE_BET_MINUTES > 0) {
        const cutoff = new Date(Date.now() - STALE_BET_MINUTES * 60 * 1000);
        const stale = await Bet.find({ status: 'pending', createdAt: { $lt: cutoff } });
        let refunded = 0;
        for (const bet of stale) {
          if (await voidBet(bet)) refunded++;
        }
        if (refunded) console.log(`poller: auto-refunded ${refunded} stale bets`);
      }
    } catch (e) {
      console.error('poller error:', e.message);
    } finally {
      busy = false;
    }
  };

  tick(); // start par ek baar turant
  return setInterval(tick, everyMs);
};

// ======================================================================
// void / refund round
// ======================================================================
export const voidRound = async (req, res) => {
  const { slug } = req.params;
  const roundId = String(req.body.roundId ?? '');
  try {
    if (!roundId) return res.status(400).json({ success: false, message: 'roundId required' });

    const bets = await Bet.find({ slug, roundId, status: 'pending' });
    let refunded = 0;
    for (const bet of bets) {
      if (await voidBet(bet)) refunded++;
    }
    await Round.updateOne(
      { slug, roundId },
      { $set: { status: 'settled', result: { void: true } }, $setOnInsert: { slug, roundId } },
      { upsert: true }
    );
    return res.json({ success: true, refunded });
  } catch (err) {
    console.error('voidRound error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ======================================================================
// nation book / my bets / stats
// ======================================================================
export const getNationBook = async (req, res) => {
  try {
    const { slug, roundId } = req.params;
    const bets = await Bet.find({ slug, roundId: String(roundId), userId: getUid(req), status: 'pending' }).lean();
    const book = engine.nationBook(slug, bets, engine.defaultScenarios(slug));
    res.json({ success: true, book });
  } catch (err) {
    console.error('getNationBook error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Frontend isko har 30-60 sec me poll kare. Har bet me `result` aata hai:
// pending | win | lose | push | void
export const myBets = async (req, res) => {
  try {
    const { slug } = req.params;
    const bets = await Bet.find({ userId: getUid(req), slug }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({
      success: true,
      bets: bets.map((b) => ({ ...b, result: betResult(b) })),
    });
  } catch (err) {
    console.error('myBets error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getStats = async (req, res) => {
  try {
    const { slug } = req.params;
    const rounds = await Round.find({ slug, status: 'settled', 'result.void': { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    const fam = engine.familyOf(slug);
    const rs = rounds.map((r) => r.result);

    if (fam === 'baccarat') {
      return res.json(
        engine.baccaratStats(rs.map((r) => (r.playerPoints > r.bankerPoints ? 'p' : r.playerPoints < r.bankerPoints ? 'b' : 't')))
      );
    }
    if (fam === 'dt') {
      return res.json(
        engine.dragonTigerStats(
          rs.reverse().map((r) => (r.dragon.rank > r.tiger.rank ? 'D' : r.dragon.rank < r.tiger.rank ? 'T' : 'TIE'))
        )
      );
    }
    if (fam === 'lucky7') {
      // result API gives win codes (no card) -> use side if rank missing
      return res.json(engine.lucky7Stats(rs.map((r) => r.card?.rank ?? r.side)));
    }
    if (fam === 'roulette') return res.json(engine.rouletteStats(rs.map((r) => r.number)));
    res.json({});
  } catch (err) {
    console.error('getStats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ======================================================================
// GET ALL BETS (ADMIN)
// ======================================================================

export const getAllBets = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      slug,
      status,
      roundId,
      userId,
      side,
      search,
      startDate,
      endDate,
    } = req.query;

    const currentPage = Math.max(1, Number(page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (currentPage - 1) * perPage;

    // Dynamic filters
    const filter = {};

    if (slug) {
      filter.slug = String(slug).trim().toLowerCase();
    }

    if (status) {
      filter.status = String(status).trim().toLowerCase();
    }

    if (roundId) {
      filter.roundId = String(roundId);
    }

    if (userId) {
      filter.userId = userId;
    }

    if (side) {
      filter.side = String(side).toLowerCase();
    }

    // Date filter
    if (startDate || endDate) {
      filter.createdAt = {};

      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }

      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    // Search by bet ID, round ID, user ID or selection
    if (search) {
      const searchRegex = new RegExp(
        String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i'
      );

      filter.$or = [
        { roundId: searchRegex },
        { slug: searchRegex },
        { selection: searchRegex },
      ];

      if (/^[a-f\d]{24}$/i.test(String(search))) {
        filter.$or.push({ _id: search });
        filter.$or.push({ userId: search });
      }
    }

    const [bets, totalBets, summary] = await Promise.all([
      Bet.find(filter).sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),

      Bet.countDocuments(filter),

      Bet.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalStake: { $sum: '$stake' },
            totalExposure: { $sum: '$exposure' },
            totalPayout: { $sum: '$payout' },
            totalNet: { $sum: '$net' },
            totalBets: { $sum: 1 },
          },
        },
      ]),
    ]);

    const stats = summary[0] || {
      totalStake: 0,
      totalExposure: 0,
      totalPayout: 0,
      totalNet: 0,
      totalBets: 0,
    };

    return res.status(200).json({
      success: true,
      message: 'All bets fetched successfully',
      data: bets.map((b) => ({ ...b, result: betResult(b) })),
      pagination: {
        totalBets,
        currentPage,
        limit: perPage,
        totalPages: Math.ceil(totalBets / perPage),
        hasNextPage: currentPage < Math.ceil(totalBets / perPage),
        hasPrevPage: currentPage > 1,
      },
      summary: stats,
    });
  } catch (error) {
    console.error('getAllBets error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bets',
      error: error.message,
    });
  }
};