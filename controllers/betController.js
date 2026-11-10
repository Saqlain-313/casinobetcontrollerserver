import dotenv from 'dotenv';
import mongoose from 'mongoose';

import {
  fetchCasinoDetailResult as apiFetchCasinoDetailResult,
  fetchCasinoResult as apiFetchCasinoResult,
  fetchCricketFancyResult as apiFetchCricketFancyResult,
  fetchMatchList as apiFetchMatchList,
  getResult as apiGetResult,
  sendBetIncoming as apiSendBetIncoming,
  getProviderName
} from '../services/matchApi/index.js';

dotenv.config();

const MARKET_NAME_TO_API = {
  'Match Odds': 'MATCH_ODDS',
  'Tied Match': 'TIED_MATCH',
};
const toApiMarketName = (name) => MARKET_NAME_TO_API[name] || name;

// Markets where each selection (team/runner) must stay a separate bet record so
// per-outcome P/L and exposure scenarios remain correct (incl. 3-way Match Odds).
const PER_TEAM_MARKET_TYPES = [
  'Match Odds',
  'Winner',
  'Tied Match',
  'OVER_UNDER_05',
  'OVER_UNDER_15',
  'OVER_UNDER_25',
  'OVER_UNDER_35',
];

import betHistoryModel from '../models/betHistoryModel.js';
import betModel from '../models/betModel.js';
import SubAdmin from '../models/subAdminModel.js';
import TransactionHistory from '../models/transtionHistoryModel.js';
import {
  cachedData, clients,
  sendBalanceUpdates,
  sendExposureUpdates,
  sendOpenBetsUpdates,
} from '../socket/bettingSocket.js';
import { getDateRangeUTC } from '../utils/dateUtils.js';
import {
  calculateAllExposure,
  FANCY_GAME_TYPES,
  validateFancyBetBalance
} from '../utils/exposureUtils.js';
import { validateBetWithNewBetOffset } from '../utils/marketCalculationUtils.js';
import { isCasinoGame } from './casinoController.js';
const { updateAllUplines } = await import('./admin/subAdminController.js');
const sportsSettlementService =
  await import('../services/sportsSettlementService.js');
const fancyBetSettlementService =
  await import('../services/fancyBetSettlementService.js');
// ─── SERVER-SIDE MARKET VALIDATION ───
// Imported from utils/marketValidation.js — always fetches fresh from API (fail-closed).
import {
  validateCasinoMarket as _validateCasinoMarket,
  validateFancyMarket as _validateFancyMarket,
  validateSportsMarket as _validateSportsMarket,
} from '../utils/marketValidation.js';
import { generateFancyLadder } from '../utils/masterBookUtils.js';

// Wrappers that pass cachedData and match the old call signatures
async function validateSportsMarket(
  gameId,
  gameName,
  marketName,
  teamName,
  xValue,
  otype,
  sid,
  oname,
  gameType,
  tno
) {
  return _validateSportsMarket(cachedData, {
    gameId,
    gameName,
    marketName,
    teamName,
    xValue,
    otype,
    sid,
    oname,
    gameType,
    tno,
  });
}

async function validateFancyMarket(
  gameId,
  gameName,
  marketName,
  teamName,
  xValue,
  otype,
  sid,
  fancyScore,
  oname
) {
  return _validateFancyMarket(cachedData, {
    gameId,
    gameName,
    marketName,
    teamName,
    xValue,
    otype,
    sid,
    fancyScore,
    oname,
  });
}

async function validateCasinoMarket(gameId, teamName, xValue, otype) {
  return _validateCasinoMarket(cachedData, { gameId, teamName, xValue, otype });
}

//  DOUBLE SETTLEMENT FIX: Processing lock to prevent concurrent executions
let isProcessingCasinoBets = false;
const roundTo2 = (value) => Number(Number(value || 0).toFixed(2));

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    ),
  ]);

// The match list is only used to resolve beventId, so a short-lived cache
// avoids a slow external round trip on every first bet in a market.
const MATCH_LIST_TTL_MS = 30000;
const matchListCache = new Map();
const getMatchListCached = (sid) => {
  const key = Number(sid);
  const hit = matchListCache.get(key);
  if (hit && Date.now() - hit.at < MATCH_LIST_TTL_MS) return hit.promise;

  const promise = withTimeout(apiFetchMatchList(key), 5000, 'match list');
  matchListCache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (matchListCache.get(key)?.promise === promise) {
      matchListCache.delete(key);
    }
  });
  return promise;
};

const lookupBeventId = async (sid, gameId, logTag) => {
  try {
    const matchListData = await getMatchListCached(sid);
    if (matchListData?.success && matchListData.data) {
      const allMatches = [
        ...(matchListData.data.t1 || []),
        ...(matchListData.data.t2 || []),
      ];
      const matched = allMatches.find((m) => {
        const matchId = String(m.beventId || m.oldgmid || m.gmid);
        return matchId === String(gameId);
      });
      return matched?.beventId ? String(matched.beventId) : '';
    }
  } catch (err) {
    console.warn(
      `[${logTag}] Failed to fetch match list for beventId lookup:`,
      err.message
    );
  }
  return '';
};

// Upline totals are not part of the bet response, so they are refreshed in the
// background. Users who bet are collected and their uplines are recalculated together,
// once per flush: 100k bets in a few seconds cost a handful of recalculations, not
// 100k. The delay between flushes grows with how long the last one took, so the
// recalculation can never occupy the database for more than about half the time.
const UPLINE_MIN_FLUSH_MS = 3000;
const pendingUplineUsers = new Set();
let uplineFlushTimer = null;
let uplineFlushRunning = false;
let lastUplineFlushMs = 0;

const flushUplineUpdates = async () => {
  uplineFlushTimer = null;
  if (uplineFlushRunning || pendingUplineUsers.size === 0) return;

  uplineFlushRunning = true;
  const userIds = [...pendingUplineUsers];
  pendingUplineUsers.clear();
  const startedAt = Date.now();
  try {
    await updateAllUplines(userIds);
  } catch (err) {
    console.error(' [BET] Error updating upline balances:', err.message);
  } finally {
    lastUplineFlushMs = Date.now() - startedAt;
    uplineFlushRunning = false;
    if (pendingUplineUsers.size > 0) armUplineFlush();
  }
};

const armUplineFlush = () => {
  if (uplineFlushTimer || uplineFlushRunning) return;
  uplineFlushTimer = setTimeout(
    flushUplineUpdates,
    Math.max(UPLINE_MIN_FLUSH_MS, lastUplineFlushMs * 2)
  );
};

const scheduleUplineUpdate = (userId) => {
  pendingUplineUsers.add(String(userId));
  armUplineFlush();
};

export const placeBetUnified = async (req, res) => {
  try {
    const {
      // Common fields for both sports and casino
      gameId,
      cid,
      gid,
      tabno,
      gmid, // casino game ID (same as gameId for casino)
      gname, // casino game name
    } = req.body;

    // Determine if this is a casino or sports bet
    const isCasino =
      isCasinoGame(gameId, cid, gid, tabno) ||
      (gmid && gname) ||
      req.body.betType === 'casino';

    if (isCasino) {
      return await placeCasinoBet(req, res);
    } else {
      return await placeBet(req, res);
    }
  } catch (error) {
    console.error('Error in unified bet placement:', error);
    return res
      .status(500)
      .json({ message: 'Server error', error: error.message });
  }
};
export const getExposureDetails = async (req, res) => {
  try {
    const { id } = req;
    const user = await SubAdmin.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Group by MARKET + EVENT using betHistoryModel
    const marketDetails = await betHistoryModel.aggregate([
      {
        $match: {
          userId: id,
          status: 0,
        },
      },
      {
        $group: {
          _id: {
            marketName: '$marketName',
            eventName: '$eventName',
            eventId: '$eventId',
            gameId: '$gameId',
            sportId: '$sid',
            sportName: '$gameName',
          },
          betCounts: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          marketName: '$_id.marketName',
          eventName: '$_id.eventName',
          eventId: '$_id.eventId',
          gameId: '$_id.gameId',
          sportId: '$_id.sportId',
          sportName: '$_id.sportName',
          betCounts: 1,
        },
      },
      {
        $sort: { betCounts: -1 },
      },
    ]);

    return res.status(200).json({
      data: marketDetails,
      meta: {
        message: 'Exposure List.',
        status_code: 200,
        status: true,
      },
    });
  } catch (error) {
    console.error('Error in getExposureDetails:', error);
    return res.status(500).json({
      meta: {
        message: 'Server error',
        status_code: 500,
        status: false,
      },
      error: error.message,
    });
  }
};
const placeCasinoBet = async (req, res) => {
  const { id } = req;

  try {
    const {
      gameId,
      price,
      xValue,
      teamName,
      otype,
      fancyScore,
      roundId,
      gname,
      cid = 4,
      gid = 35,
      tabno = 6,
      subtype,
    } = req.body;

    if (
      !gameId ||
      !price ||
      !xValue ||
      !teamName ||
      !otype ||
      !roundId ||
      !gname
    ) {
      return res
        .status(400)
        .json({ message: 'All required casino fields must be provided' });
    }

    // if (!["Player A", "Player B"].includes(teamName)) {
    //   return res
    //     .status(400)
    //     .json({ message: "Casino team must be 'PLAYER A' or 'PLAYER B'" });
    // }
    //Instead of this we will use dynamically

    if (!['back', 'lay'].includes(otype)) {
      return res
        .status(400)
        .json({ message: "Bet type must be 'back' or 'lay'" });
    }

    // The live-odds check (shared provider cache) and every read this bet needs are
    // independent, so they run together instead of one after the other.
    const uniqueKey = {
      gameId,
      roundId,
      marketName: 'WINNER',
      userId: id,
      status: 0,
    };
    // Exclude cashed-out bets — they are locked and must not be merged/offset
    const roundBetsFilter = {
      userId: id,
      roundId,
      gameId,
      marketName: 'WINNER',
      status: 0,
      isCashedOut: { $ne: true },
    };
    const [
      casinoCheck,
      user,
      existingExact,
      existingBet,
      marketBets,
      pendingBets,
    ] = await Promise.all([
      validateCasinoMarket(gameId, teamName, xValue, otype),
      // Plain objects with only the fields this bet uses: building full Mongoose
      // documents (with their quick-stake / game-lock arrays) was the main CPU cost.
      SubAdmin.findById(id)
        .select(
          'userName role invite gamelock balance avbalance exposure exposureLimit'
        )
        .lean(),
      betModel.findOne(uniqueKey).select('market_id').lean(),
      // existingBet is changed and saved below, so it stays a document
      betModel.findOne({ ...roundBetsFilter, betType: 'casino' }),
      betModel.find(roundBetsFilter).lean(),
      betModel.find({ userId: id, status: 0 }).lean(),
    ]);

    if (!casinoCheck.valid) {
      console.warn(
        `[BET REJECTED] Casino: gameId=${gameId} roundId=${roundId} team=${teamName} reason="${casinoCheck.reason}"`
      );
      return res.status(400).json({ message: casinoCheck.reason });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    // The model rounds balance to 2 decimals when read; keep that for plain objects
    user.balance = parseFloat(Number(user.balance || 0).toFixed(2));

    // Check if Casino is locked for this user
    const casinoLockEntry = user.gamelock?.find(
      (g) => g.game.toLowerCase() === 'casino'
    );
    if (casinoLockEntry && casinoLockEntry.lock === false) {
      return res
        .status(403)
        .json({ message: 'Casino betting is locked for your account' });
    }

    // Market ID logic
    let market_id;
    if (existingExact) {
      market_id = existingExact.market_id;
    } else {
      market_id = `casino_${gameId}_${Date.now()}_${Math.floor(
        1000 + Math.random() * 9000
      )}`;
    }

    // Calculate bet amounts with validation
    let p = parseFloat(price);
    const originalStake = p; // Save original stake before modification for LAY bets
    let x = Number(parseFloat(xValue).toFixed(2));
    let betAmount = 0;

    // Minimum bet validation
    const MINIMUM_BET = 1; // Set your minimum bet amount
    if (p < MINIMUM_BET) {
      return res
        .status(400)
        .json({ message: `Minimum bet amount is ${MINIMUM_BET}` });
    }

    // Maximum bet validation
    const MAXIMUM_BET = 100000; // Set your maximum bet amount
    if (p > MAXIMUM_BET) {
      return res
        .status(400)
        .json({ message: `Maximum bet amount is ${MAXIMUM_BET}` });
    }

    // Odds validation
    if (x < 1.01 || x > 100) {
      return res.status(400).json({ message: 'Invalid odds range' });
    }

    // Casino calculation logic based on game type
    if (gameId.includes('roulette')) {
      betAmount = otype === 'lay' ? p : p * (x - 1);
      p = otype === 'lay' ? p * (x - 1) : p;
    } else if (gameId.includes('lucky7')) {
      betAmount = p * (x - 1);
    } else {
      // TeenPatti games (default)
      betAmount = otype === 'lay' ? p : p * (x - 1);
      p = otype === 'lay' ? p * (x - 1) : p;
    }

    betAmount = parseFloat(betAmount.toFixed(2));
    p = parseFloat(p.toFixed(2));

    // STEP 1/2: the existing casino bet and this round's bets were loaded above,
    // together with the validation and user reads.

    // Calculate effective balance based on market position
    // Using new method that includes potential profit from the new bet itself
    const validation = validateBetWithNewBetOffset(
      user.avbalance,
      user.balance,
      marketBets,
      teamName,
      otype,
      originalStake,
      p, // liability (calculated p)
      betAmount // potential profit if bet wins
    );

    // STEP 3: Balance validation with effective available balance (includes new bet profit potential)
    if (!validation.allowed) {
      console.log(`\x1b[41m[CASINO REJECTED]\x1b[0m ${validation.reason}`);
      return res.status(400).json({
        message: 'Insufficient balance',
        debug: {
          reason: validation.reason,
          effectiveBalance: validation.effectiveBalance,
          requiredLiability: p,
          userAvbalance: user.avbalance,
          userBalance: user.balance,
          existingMarketBets: marketBets.length,
          breakdown: validation.breakdown,
        },
      });
    }

    // STEP 4: Exposure limit check using scenario-based simulation
    const simulatedNewBet = {
      gameType: 'Casino',
      betType: 'casino',
      gameId,
      roundId,
      teamName,
      otype,
      betAmount,
      price: p,
    };
    const projectedExposure = calculateAllExposure([
      ...pendingBets,
      simulatedNewBet,
    ]);
    if (projectedExposure > user.exposureLimit) {
      return res.status(400).json({ message: 'Exposure limit exceeded' });
    }

    let newBet = null;

    if (existingBet) {
      const originalPrice = existingBet.price || 0;
      const originalBetAmount = existingBet.betAmount || 0;

      if (teamName === existingBet.teamName) {
        // SAME TEAM scenarios

        if (otype === existingBet.otype) {
          // Same team1, same type1 - MERGE

          existingBet.price = parseFloat((originalPrice + p).toFixed(2));
          existingBet.xValue = parseFloat(
            (
              (Number(existingBet.xValue || 0) * originalPrice + x * p) /
              (originalPrice + p || 1)
            ).toFixed(2)
          );
          existingBet.betAmount += betAmount;
          existingBet.fancyScore = fancyScore || existingBet.fancyScore;
          existingBet.roundId = roundId || existingBet.roundId;

          // TASK14 FIX: Calculate correct avbalance deduction for guaranteed profit scenarios
          if (originalPrice < 0) {
            // Guaranteed profit position - only deduct the NET exposure increase
            // Old exposure was 0 (guaranteed profit), new exposure = MAX(0, newPrice)
            const newExposure = Math.max(0, existingBet.price);
            user.avbalance = parseFloat(
              (user.avbalance - newExposure).toFixed(2)
            );
          } else {
            // Normal merge - deduct liability amount
            // NOTE: Initial validation already passed using effective balance logic
            // No secondary balance check needed here - just deduct the liability
            user.avbalance = parseFloat((user.avbalance - p).toFixed(2));
          }
        } else {
          // Same team, opposite types - OFFSET (matching sports logic exactly)

          if (otype === 'back') {
            if (originalBetAmount >= p) {
              // Full offset
              existingBet.price = parseFloat(
                (originalPrice - betAmount).toFixed(2)
              );
              existingBet.betAmount = parseFloat(
                (originalBetAmount - p).toFixed(2)
              );
              //TODO:THIS IS THE WRONG LOGIC OF AVBALANCE
              user.avbalance = parseFloat(
                (user.avbalance + betAmount).toFixed(2)
              );
            } else {
              // Partial offset with type change
              existingBet.price = parseFloat(
                (p - originalBetAmount).toFixed(2)
              );
              existingBet.betAmount = parseFloat(
                (betAmount - originalPrice).toFixed(2)
              );
              existingBet.otype = otype;
              user.avbalance = parseFloat(
                (
                  user.avbalance +
                  originalPrice -
                  (p - originalBetAmount)
                ).toFixed(2)
              );
            }
          } else if (otype === 'lay') {
            if (originalPrice >= betAmount) {
              // Full offset
              existingBet.price = parseFloat(
                (originalPrice - betAmount).toFixed(2)
              );
              existingBet.betAmount = parseFloat(
                (originalBetAmount - p).toFixed(2)
              );
              //TOD
              // console.log(
              //   'The offeset is happening full offset back and then lay '
              // );
              user.skipExposureRecalculation = true;
              // user.avbalance=parseFloat((user.balance+existingBet.betAmount).toFixed(2))
              // Check if betAmount is positive (hedged position profit)
              if (existingBet.betAmount > 0) {
                // Hedged position: no exposure, available balance = total balance
                user.exposure = 0;
                user.avbalance = user.balance;
              } else {
                // Normal position: use existing logic
                user.avbalance = parseFloat(
                  (user.balance + existingBet.betAmount).toFixed(2)
                );
              }
            } else {
              // Partial offset with type change
              //TODO
              existingBet.price = parseFloat(
                (p - originalBetAmount).toFixed(2)
              );
              existingBet.betAmount = parseFloat(
                (betAmount - originalPrice).toFixed(2)
              );
              existingBet.otype = otype;
              user.skipExposureRecalculation = true;

              user.avbalance = parseFloat(
                (
                  user.avbalance -
                  (p - originalBetAmount) -
                  originalPrice
                ).toFixed(2)
              );
            }
          }
          existingBet.xValue = x;
          existingBet.fancyScore = fancyScore || existingBet.fancyScore;
          existingBet.roundId = roundId || existingBet.roundId;
        }
      } else {
        // DIFFERENT TEAM scenarios
        // Lucky7: one doc per round → ADD (accumulate) to same doc; breakdown is in bet history
        if (gameId.includes('lucky7')) {
          existingBet.price = parseFloat((existingBet.price + p).toFixed(2));
          existingBet.betAmount = parseFloat(
            (existingBet.betAmount + betAmount).toFixed(2)
          );
          existingBet.xValue = parseFloat(
            (
              (Number(existingBet.xValue || 0) * originalPrice + x * p) /
              (originalPrice + p || 1)
            ).toFixed(2)
          );
          existingBet.fancyScore = fancyScore || existingBet.fancyScore;
          existingBet.roundId = roundId || existingBet.roundId;
          // Keep existing teamName (first selection); per-selection is in bet history
          user.avbalance = parseFloat((user.avbalance - p).toFixed(2));
        } else {
          // Teen Patti / other: matching sports logic (offset / switch / add)
          if (otype === existingBet.otype) {
            if (originalPrice >= betAmount) {
              existingBet.price = parseFloat(
                (originalPrice - betAmount).toFixed(2)
              );
              existingBet.betAmount = parseFloat(
                (originalBetAmount - p).toFixed(2)
              );
              existingBet.xValue = x;
              existingBet.fancyScore = fancyScore || existingBet.fancyScore;
              existingBet.roundId = roundId || existingBet.roundId;
            } else {
              existingBet.price = parseFloat(
                (p - originalBetAmount).toFixed(2)
              );
              existingBet.betAmount = parseFloat(
                (betAmount - originalPrice).toFixed(2)
              );
              existingBet.teamName = teamName;
              existingBet.xValue = x;
              existingBet.fancyScore = fancyScore || existingBet.fancyScore;
              existingBet.roundId = roundId || existingBet.roundId;
            }
          } else {
            const originalPriceForAdd = existingBet.price;
            existingBet.price = parseFloat((existingBet.price + p).toFixed(2));
            existingBet.betAmount = parseFloat(
              (existingBet.betAmount + betAmount).toFixed(2)
            );
            existingBet.xValue = parseFloat(
              ((existingBet.xValue + x) / 2).toFixed(2)
            );
            if (originalPriceForAdd < 0) {
              const newExposure = Math.max(0, existingBet.price);
              user.avbalance = parseFloat(
                (user.avbalance - newExposure).toFixed(2)
              );
            } else {
              user.avbalance = parseFloat((user.avbalance - p).toFixed(2));
            }
            existingBet.teamName = teamName;
            existingBet.xValue = x;
            existingBet.fancyScore = fancyScore || existingBet.fancyScore;
            existingBet.roundId = roundId || existingBet.roundId;
            existingBet.otype = otype;
          }
        }
      }
    } else {
      // No existing bet - create new

      newBet = new betModel({
        userId: id,
        userName: user.userName,
        userRole: user.role,
        invite: user.invite,
        gameId,
        price: p,
        betAmount,
        otype,
        xValue: x,
        fancyScore,
        gameType: 'Casino',
        market_id,
        eventName: gname,
        marketName: 'WINNER',
        gameName: 'Casino',
        teamName,
        roundId,
        cid,
        gid,
        tabno,
        betType: 'casino',
        subtype,
      });
      user.avbalance = parseFloat((user.avbalance - p).toFixed(2));
    }

    // Exposure after this bet, from the bets loaded above plus the change just made.
    // This is the same data the old post-save re-query returned, without the extra
    // round trip, and it lets a failed safety check stop everything before any write.
    const updatedPendingBets = pendingBets.map((b) =>
      existingBet && String(b._id) === String(existingBet._id) ? existingBet : b
    );
    if (newBet) updatedPendingBets.push(newBet);

    // Set by the offset branches above
    const recalcAfterOffset = user.skipExposureRecalculation;
    user.skipExposureRecalculation = false;

    if (!recalcAfterOffset) {
      // Only apply casino exposure logic if there are casino bets
      // Don't override fancy betting exposure calculation
      const hasCasinoBets = updatedPendingBets.some(
        (b) => b.gameType === 'Casino'
      );

      if (hasCasinoBets) {
        // Use scenario-based exposure calculation
        user.exposure = calculateAllExposure(updatedPendingBets);
        user.avbalance = user.balance - user.exposure;

        // CRITICAL SAFETY CHECK: PTI must never be negative
        if (user.avbalance < 0) {
          console.error(`[CRITICAL PTI ERROR] Casino avbalance went negative!`);
          throw new Error(
            'Critical: PTI calculation error - casino bet rejected'
          );
        }
      }
    } else {
      // Always recalculate exposure from pending bets using scenario-based logic
      user.exposure = calculateAllExposure(updatedPendingBets);
      user.avbalance = user.balance - user.exposure;

      // CRITICAL SAFETY CHECK: PTI must never be negative
      if (user.avbalance < 0) {
        console.error(
          `[CRITICAL PTI ERROR] Casino offset avbalance went negative!`
        );
        throw new Error(
          'Critical: PTI calculation error - casino bet rejected'
        );
      }
    }

    // Record bet history for every bet placed (individual tracking)
    const betHistory = new betHistoryModel({
      betId: (newBet ? newBet._id : existingBet._id).toString(), // Link to parent bet for settlement
      userId: id,
      userName: user.userName,
      gameId,
      price: p,
      betAmount,
      otype,
      xValue: x,
      fancyScore,
      gameType: 'casino',
      eventName: gname,
      market_id,
      marketName: 'WINNER',
      gameName: 'Casino',
      teamName,
      roundId,
      cid,
      gid,
      tabno,
      betType: 'casino',
      subtype,
    });

    // One round of writes, all at once. The user only changes these two fields, so a
    // targeted update replaces loading, validating and saving a whole document.
    const saveOperations = [
      SubAdmin.updateOne(
        { _id: user._id },
        { $set: { avbalance: user.avbalance, exposure: user.exposure } }
      ),
      betHistory.save(),
    ];
    if (existingBet) saveOperations.push(existingBet.save());
    if (newBet) saveOperations.push(newBet.save());
    await Promise.all(saveOperations);

    //Send WebSocket Updates (only to this user's own connections)
    sendBalanceUpdates(user._id, user.avbalance);
    sendExposureUpdates(user._id, user.exposure);
    sendOpenBetsUpdates(user._id, null);

    // Upline totals are recalculated in the background in batches
    scheduleUplineUpdate(user._id);

    return res.status(201).json({
      message: 'Casino bet placed successfully',
    });
  } catch (error) {
    console.error('Error placing casino bet:', error);
    return res
      .status(500)
      .json({ message: 'Server error', error: error.message });
  }
};
const placeBet = async (req, res) => {
  const { id } = req;

  try {
    const {
      gameId,
      sid,
      price,
      xValue,
      fancyScore,
      gameType,
      eventName,
      marketName,
      gameName,
      teamName,
      otype,
      oname,
      tno,
    } = req.body;

    // Validate required fields
    if (!gameId || !sid || !price || !xValue || !gameName || !teamName) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Independent reads run together: live-odds validation (external API),
    // user lookup and the existing-market lookup.
    const uniqueKey = { gameId, eventName, marketName };
    const [marketCheck, user, existingExact] = await Promise.all([
      validateSportsMarket(
        gameId,
        gameName,
        marketName,
        teamName,
        xValue,
        otype,
        sid,
        oname,
        gameType,
        tno
      ),
      SubAdmin.findById(id),
      betModel.findOne(uniqueKey),
    ]);
    if (!marketCheck.valid) {
      console.warn(
        `[BET REJECTED] Sports: gameId=${gameId} team=${teamName} market=${marketName} reason="${marketCheck.reason}"`
      );
      return res.status(400).json({ message: marketCheck.reason });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if this sport is locked for the user
    if (gameName && user.gamelock) {
      const sportLockEntry = user.gamelock.find(
        (g) => g.game.toLowerCase() === gameName.toLowerCase()
      );
      if (sportLockEntry && sportLockEntry.lock === false) {
        return res
          .status(403)
          .json({ message: `${gameName} betting is locked for your account` });
      }
    }

    if (user.secret === 0) {
      return res.status(200).json({ message: 'created successfully' });
    }

    const marketMeta = marketCheck.marketMeta || {};

    let market_id;

    if (existingExact) {
      market_id = existingExact.market_id;
    }

    // Market registration with the external API is not needed to accept the
    // bet (failures were already only logged), so it runs in the background.
    if (!existingExact) {
      market_id = Math.floor(10000000 + Math.random() * 90000000);

      const registerMarket = async () => {
        const beventId = await lookupBeventId(sid, gameId, 'BET');

        if (gameType === 'fancy1' || gameType === 'oddeven') {
          // fancy1 and oddeven use the same request format as fancy (session) bets:
          // no runners, carries fancyId + beventId instead.
          // market_id is included for Provider A; Provider B ignores it on the
          // fancyId branch of its whitelist so this is a no-op for Provider B.
          await apiSendBetIncoming({
            sport_id: sid,
            sportName: (gameName || '').replace(/\s*game\s*$/i, ''),
            event_id: marketMeta.gmid || null,
            beventId,
            event_name: eventName,
            market_id: market_id,
            fancyId: marketMeta.fancyId ? String(marketMeta.fancyId) : null,
            market_name: toApiMarketName(marketName),
            fancyType: gameType,
          });
        } else {
          await apiSendBetIncoming({
            event_id: marketMeta?.gmid ?? null,
            event_name: eventName,
            market_id: market_id,
            market_name: toApiMarketName(marketName),
            market_type: gameType,
            client_ref: null,
            sport_id: sid,
            fancyId: null,
            fancymid: marketMeta.mid || null,
            bevent_id: beventId || null,
            runners: marketMeta.runners || [],
          });
        }
      };

      registerMarket().catch((apiErr) => {
        console.error(
          `[SPORTS BET] bet-incoming API failed for gameId=${gameId}:`,
          apiErr.message
        );
      });
    }

    let p = parseFloat(price);
    const originalStake = p; // Save original stake before modification for LAY bets
    let x = Number(parseFloat(xValue).toFixed(2));
    let betAmount = 0;

    // Validate minimum odds - odds of 1.00 produce zero liability (invalid bet)
    if (x < 1.01) {
      return res
        .status(400)
        .json({ message: 'Invalid odds: minimum allowed is 1.01' });
    }

    // Calculate bet amount based on game type and otype
    switch (gameType) {
      case 'Match Odds':
      case 'fancy1':
      case 'oddeven':
      case 'Tied Match':
      case 'Winner':
      case 'OVER_UNDER_05':
      case 'OVER_UNDER_15':
      case 'OVER_UNDER_25':
        betAmount = otype === 'lay' ? p : p * (x - 1);
        p = otype === 'lay' ? p * (x - 1) : p;
        break;
      case 'Bookmaker':
      case 'Bookmaker IPL CUP':
        betAmount = otype === 'lay' ? p : p * (x / 100);
        p = otype === 'lay' ? p * (x / 100) : p;
        break;
      case 'Toss':
      case '1st 6 over':
        betAmount = otype === 'lay' ? p : p * (x - 1);
        p = otype === 'lay' ? p * (x - 1) : p;
        break;
      default:
        return res.status(400).json({ message: 'Invalid game type' });
    }

    betAmount = parseFloat(betAmount.toFixed(2));
    p = parseFloat(p.toFixed(2));

    // BET PLACEMENT - EXPOSURE CALCULATION

    // fancy1 and oddeven: each row is an independent market (per-proposition
    // marketName). Scope lookups by marketName so different propositions in
    // the same match don't collide and merge into one bet record.
    const marketScopedQuery = {
      userId: id,
      gameId,
      gameType,
      status: 0,
      isCashedOut: { $ne: true },
    };
    if (
      gameType === 'fancy1' ||
      gameType === 'oddeven' ||
      PER_TEAM_MARKET_TYPES.includes(gameType)
    ) {
      marketScopedQuery.marketName = marketName;
    }

    const existingBetQuery =
      gameType === 'oddeven' || PER_TEAM_MARKET_TYPES.includes(gameType)
        ? { ...marketScopedQuery, teamName }
        : marketScopedQuery;
    const [existingBet, marketBets, pendingBets] = await Promise.all([
      betModel.findOne(existingBetQuery),
      betModel.find(marketScopedQuery),
      betModel.find({ userId: id, status: 0 }),
    ]);
    const validation = validateBetWithNewBetOffset(
      user.avbalance,
      user.balance,
      marketBets,
      teamName,
      otype,
      originalStake,
      p, // liability (calculated p)
      betAmount // potential profit if bet wins
    );

    // STEP 3: Balance check with effective available balance (includes new bet profit potential)
    if (!validation.allowed) {
      console.log(`\x1b[41m[REJECTED]\x1b[0m ${validation.reason}`);
      return res.status(400).json({
        message: 'Insufficient balance',
        debug: {
          reason: validation.reason,
          effectiveBalance: validation.effectiveBalance,
          requiredLiability: p,
          userAvbalance: user.avbalance,
          userBalance: user.balance,
          existingMarketBets: marketBets.length,
          breakdown: validation.breakdown,
        },
      });
    }

    // STEP 4: Check exposure limit using scenario-based simulation
    const simulatedNewBet = {
      gameType,
      gameId,
      marketName,
      teamName,
      otype,
      betAmount,
      price: p,
    };
    const projectedExposure = calculateAllExposure([
      ...pendingBets,
      simulatedNewBet,
    ]);

    if (projectedExposure > user.exposureLimit) {
      return res.status(400).json({ message: 'Exposure limit exceeded' });
    }

    let newBet = null;
    let placementType = 'new';
    let parentBetSnapshot = null;

    if (existingBet) {
      const originalPrice = existingBet.price;
      const originalBetAmount = existingBet.betAmount;

      // Capture snapshot BEFORE any modification
      parentBetSnapshot = {
        price: existingBet.price,
        betAmount: existingBet.betAmount,
        xValue: existingBet.xValue,
        otype: existingBet.otype,
        fancyScore: existingBet.fancyScore,
      };

      if (teamName === existingBet.teamName) {
        if (otype === existingBet.otype) {
          // Same team, same bet type - merge bets
          placementType = 'merge';
          existingBet.price += p;
          existingBet.xValue =
            originalPrice + p > 0
              ? (parseFloat(existingBet.xValue) * originalPrice +
                  parseFloat(x) * p) /
                (originalPrice + p)
              : parseFloat(x); // Avoid division by zero when both prices are 0
          existingBet.fancyScore = fancyScore;
          existingBet.betAmount += betAmount;
          existingBet.placementType = 'merged';
          existingBet.mergeCount = (existingBet.mergeCount || 1) + 1;
          user.avbalance -= p;
        } else {
          // Same team, opposite bet types - offset bets
          placementType = 'odds_offset';
          existingBet.placementType = 'odds_offset';
          if (otype === 'back') {
            //The originalBetAmount is the price of the existing bet,p is the price of the new bet
            if (originalBetAmount >= p) {
              // Full offset
              existingBet.price = originalPrice - betAmount;
              existingBet.betAmount = originalBetAmount - p;
              user.avbalance += betAmount;
            } else {
              // Partial offset with type change
              //The problem is here that (8-11) is giving equal to -3
              //or i should make it absolute
              existingBet.price = p - originalBetAmount;
              existingBet.betAmount = betAmount - originalPrice;
              existingBet.otype = otype;
              user.avbalance += originalPrice - (p - originalBetAmount);
            }
          } else if (otype === 'lay') {
            if (originalPrice >= betAmount) {
              // Full offset
              existingBet.price = originalPrice - betAmount;
              existingBet.betAmount = originalBetAmount - p;
              user.avbalance += betAmount;
            } else {
              // Partial offset with type change
              existingBet.price = p - originalBetAmount;
              existingBet.betAmount = betAmount - originalPrice;
              existingBet.otype = otype;
              user.avbalance -= p - originalBetAmount - originalPrice;
            }
          }
          existingBet.xValue = x;
          existingBet.fancyScore = fancyScore;
        }
      } else if (PER_TEAM_MARKET_TYPES.includes(gameType)) {
        // Different selection in a multi-outcome market — keep a separate bet row
        placementType = 'new';
        newBet = new betModel({
          userId: id,
          userName: user.userName,
          userRole: user.role,
          invite: user.invite,
          gameId,
          sid,
          price: p,
          betAmount,
          otype,
          xValue: x,
          fancyScore,
          gameType,
          market_id,
          eventName,
          marketName,
          gameName,
          teamName,
          fancyId: null,
          placementType: 'new',
          mergeCount: 1,
        });
        user.avbalance -= p;
      } else {
        // If team name is different (binary / legacy offset markets)
        if (otype === existingBet.otype) {
          placementType = 'odds_offset';
          existingBet.placementType = 'odds_offset';
          if (originalPrice >= betAmount) {
            existingBet.price = originalPrice - betAmount;
            existingBet.betAmount = originalBetAmount - p;
            // user.exposure = totalPendingAmount - betAmount;
            user.avbalance += betAmount;
            // existingBet.teamName = teamName;
            existingBet.xValue = x;
            existingBet.fancyScore = fancyScore;
          }
          //This condition is for opposite otype
          //identify which condition is this
          else {
            //-8-2500
            existingBet.price = p - originalBetAmount;
            //100-200
            existingBet.betAmount = betAmount - originalPrice;
            // user.exposure = totalPendingAmount - betAmount;
            user.avbalance -= p - originalBetAmount - originalPrice;
            existingBet.teamName = teamName;
            existingBet.xValue = x;
            existingBet.fancyScore = fancyScore;
          }
        } else {
          // Different team, opposite otype - hedge/add
          placementType = 'merge';
          existingBet.placementType = 'merged';
          existingBet.mergeCount = (existingBet.mergeCount || 1) + 1;
          //200+8
          existingBet.price += p;
          //2500+100
          existingBet.betAmount += betAmount;
          existingBet.xValue = (existingBet.xValue + x) / 2;
          // user.exposure = totalPendingAmount + p;
          user.avbalance -= p;
          existingBet.teamName = teamName;
          existingBet.xValue = x;
          existingBet.fancyScore = fancyScore;
          existingBet.otype = otype;
        }
      }
    } else {
      // No existing bet, place new one
      placementType = 'new';
      newBet = new betModel({
        userId: id,
        userName: user.userName,
        userRole: user.role,
        invite: user.invite,
        gameId,
        sid,
        price: p,
        betAmount,
        otype,
        xValue: x,
        fancyScore,
        gameType,
        market_id,
        eventName,
        marketName,
        gameName,
        teamName,
        fancyId:
          gameType === 'fancy1' || gameType === 'oddeven'
            ? String(marketMeta.fancyId || '') || null
            : null,
        placementType: 'new',
        mergeCount: 1,
      });
      user.avbalance -= p;
    }

    if (
      existingBet &&
      (gameType === 'fancy1' || gameType === 'oddeven') &&
      marketMeta.fancyId &&
      !existingBet.fancyId
    ) {
      existingBet.fancyId = String(marketMeta.fancyId);
    }

    // STEP 2: Save the bet to database first
    const saveOperations = [];
    if (existingBet) saveOperations.push(existingBet.save());
    if (newBet) saveOperations.push(newBet.save());

    // Execute all save operations
    await Promise.all(saveOperations);

    // STEP 3: Calculate exposure again (AFTER placing)
    // Now we include the new bet we just saved
    // This becomes the user's official exposure in database
    const updatedPendingBets = await betModel.find({
      userId: id,
      status: 0,
    });
    user.exposure = calculateAllExposure(updatedPendingBets);

    // Recalculate avbalance from the formula (fixes incremental update errors)
    user.avbalance = user.balance - user.exposure;

    // CRITICAL SAFETY CHECK: PTI must never be negative
    if (user.avbalance < 0) {
      console.error(`[CRITICAL PTI ERROR] avbalance went negative!`);
      console.error(`  balance: ${user.balance}`);
      console.error(`  exposure: ${user.exposure}`);
      console.error(`  avbalance: ${user.avbalance}`);
      console.error(
        `  bet details: gameId=${gameId}, teamName=${teamName}, price=${p}`
      );

      // Rollback by not saving - this is a critical error
      throw new Error('Critical: PTI calculation error - bet rejected');
    }

    // Record bet history regardless of new/existing
    const betHistory = new betHistoryModel({
      betId: (newBet ? newBet._id : existingBet._id).toString(), // Link to parent bet for settlement
      userId: id,
      userName: user.userName,
      gameId,
      sid,
      price: p,
      betAmount,
      otype,
      xValue: x,
      fancyScore,
      gameType,
      eventName,
      market_id,
      marketName,
      gameName,
      teamName,
      placementType,
      parentBetSnapshot,
      userBalanceBefore: user.balance,
      userExposureBefore: user.exposure,
    });

    await Promise.all([user.save(), betHistory.save()]);

    sendBalanceUpdates(user._id, user.avbalance);
    sendExposureUpdates(user._id, user.exposure);
    sendOpenBetsUpdates(user._id, null);

    scheduleUplineUpdate(user._id);

    return res.status(201).json({ message: 'Bet placed successfully' });
  } catch (error) {
    console.error(
      `[SPORTS BET] Error placing bet:`,
      error.message,
      error.stack
    );
    return res
      .status(500)
      .json({ message: 'Error placing bet', error: error.message });
  }
};
export const placeFancyBet = async (req, res) => {
  const { id } = req;

  try {
    const {
      gameId,
      sid,
      price,
      xValue,
      fancyScore,
      gameType,
      eventName,
      marketName,
      gameName,
      teamName,
      otype,
      oname,
    } = req.body;

    // Validate required fields
    if (!gameId || !sid || !price || !xValue || !gameName || !teamName) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const uniqueKey = { gameId, eventName, marketName };
    const [fancyCheck, user, existingExact] = await Promise.all([
      validateFancyMarket(
        gameId,
        gameName,
        marketName,
        teamName,
        xValue,
        otype,
        sid,
        fancyScore,
        oname
      ),
      SubAdmin.findById(id),
      betModel.findOne(uniqueKey),
    ]);
    if (!fancyCheck.valid) {
      console.warn(
        `[BET REJECTED] Fancy: gameId=${gameId} team=${teamName} market=${marketName} reason="${fancyCheck.reason}"`
      );
      return res.status(400).json({ message: fancyCheck.reason });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if this sport is locked for the user
    if (gameName && user.gamelock) {
      const sportLockEntry = user.gamelock.find(
        (g) => g.game.toLowerCase() === gameName.toLowerCase()
      );
      if (sportLockEntry && sportLockEntry.lock === false) {
        return res
          .status(403)
          .json({ message: `${gameName} betting is locked for your account` });
      }
    }

    if (user.secret === 0) {
      return res.status(200).json({ message: 'created successfully' });
    }

    const fancyMeta = fancyCheck.marketMeta || {};
    let market_id;

    if (existingExact) {
      market_id = existingExact.market_id;
    }

    if (!existingExact) {
      market_id = Math.floor(10000000 + Math.random() * 90000000);

      const beventId = await lookupBeventId(sid, gameId, 'FANCY BET');

      try {
        // market_id is included for Provider A; Provider B ignores it on the
        // fancyId branch of its whitelist so this is a no-op for Provider B.
        await apiSendBetIncoming({
          sport_id: sid,
          sportName: (gameName || '').replace(/\s*game\s*$/i, ''),
          event_id: fancyMeta?.gmid ?? null,
          beventId,
          event_name: eventName,
          market_id: market_id,
          fancyId: fancyMeta.fancyId ? String(fancyMeta.fancyId) : null,
          market_name: toApiMarketName(marketName),
          fancyType: gameType,
        });
      } catch (err) {
        console.error('Error fetching market_id:', err);
        return res.status(502).json({
          message: 'Could not fetch external market_id',
          error: err.message,
        });
      }
    }

    let p = parseFloat(price);
    let x = Number(parseFloat(xValue).toFixed(2));
    let betAmount = 0;

    // Calculate bet amount based on game type and otype
    switch (gameType) {
      case 'Normal':
      case 'meter':
      case 'line':
      case 'ball':
      case 'khado':
        betAmount = otype === 'lay' ? p : p * (x / 100);
        p = otype === 'lay' ? p * (x / 100) : p;
        break;
      default:
        return res.status(400).json({ message: 'Invalid game type' });
    }

    betAmount = parseFloat(betAmount.toFixed(2));
    p = parseFloat(p.toFixed(2));

    const [fancyMarketBets, pendingBets, mergeBet, oppositeBet] =
      await Promise.all([
        betModel.find({
          userId: id,
          gameId,
          teamName,
          gameType,
          status: 0,
          isCashedOut: { $ne: true },
        }),
        betModel.find({ userId: id, status: 0 }),
        betModel.findOne({
          userId: id,
          gameId,
          gameType,
          teamName,
          otype,
          fancyScore,
          status: 0,
          isCashedOut: { $ne: true },
        }),
        betModel.findOne({
          userId: id,
          gameId,
          gameType,
          teamName,
          otype: otype === 'back' ? 'lay' : 'back',
          status: 0,
          isCashedOut: { $ne: true },
        }),
      ]);
    const existingBet = mergeBet ? null : oppositeBet;

    const fancyValidation = validateFancyBetBalance(
      user.avbalance,
      user.balance,
      fancyMarketBets,
      { gameId, teamName, fancyScore, otype, betAmount, price: p }
    );

    if (!fancyValidation.allowed) {
      return res.status(400).json({
        message: 'Insufficient balance',
        debug: {
          reason: fancyValidation.reason,
          userAvbalance: user.avbalance,
          userBalance: user.balance,
          newAvbalance: fancyValidation.newAvbalance,
          currentMarketExposure: fancyValidation.currentMarketExposure,
          newMarketExposure: fancyValidation.newMarketExposure,
        },
      });
    }

    const simulatedNewBet = {
      gameType,
      gameId,
      teamName,
      fancyScore,
      otype,
      betAmount,
      price: p,
    };
    const projectedExposure = calculateAllExposure([
      ...pendingBets,
      simulatedNewBet,
    ]);

    if (projectedExposure > user.exposureLimit) {
      return res.status(400).json({ message: 'Exposure limit exceeded' });
    }

    let activeBetId = null;
    let placementType = 'new';
    let parentBetSnapshot = null;

    if (mergeBet) {
      // CASE 1: SAME TYPE + SAME FANCYSCORE - MERGE
      // Snapshot BEFORE merge for debugging
      parentBetSnapshot = {
        price: mergeBet.price,
        betAmount: mergeBet.betAmount,
        xValue: mergeBet.xValue,
        otype: mergeBet.otype,
        fancyScore: mergeBet.fancyScore,
      };
      placementType = 'merge';

      mergeBet.price += p;
      mergeBet.xValue = (mergeBet.xValue + x) / 2;
      mergeBet.betAmount += betAmount;
      mergeBet.placementType = 'merged';
      mergeBet.mergeCount = (mergeBet.mergeCount || 1) + 1;
      await mergeBet.save();
      activeBetId = mergeBet._id; // Track the bet ID
      console.log(
        `[MERGE] Same type + same score bet merged - ${otype} + ${otype} at fancyScore=${fancyScore}`
      );
    } else if (existingBet) {
      // CASE 2: DIFFERENT TYPE - CHECK OFFSET CONDITIONS

      // Priority 1: Score Offset (Highest Priority)
      const scoreOffset =
        (existingBet.otype === 'back' &&
          otype === 'lay' &&
          parseFloat(fancyScore) > parseFloat(existingBet.fancyScore)) ||
        (existingBet.otype === 'lay' &&
          otype === 'back' &&
          parseFloat(existingBet.fancyScore) > parseFloat(fancyScore));

      // Priority 2: Odds Offset (Secondary Priority)
      const oddsOffset =
        (existingBet.otype === 'back' &&
          otype === 'lay' &&
          x > existingBet.xValue) ||
        (existingBet.otype === 'lay' &&
          otype === 'back' &&
          existingBet.xValue > x);

      if (scoreOffset) {
        // PRIORITY 1: Score Offset (Highest Priority)
        placementType = 'score_offset';
        parentBetSnapshot = {
          price: existingBet.price,
          betAmount: existingBet.betAmount,
          xValue: existingBet.xValue,
          otype: existingBet.otype,
          fancyScore: existingBet.fancyScore,
        };
        console.log(
          ` Score offset applied - lay score (${fancyScore}) > back score (${existingBet.fancyScore})`
        );

        const originalPrice = existingBet.price;
        const originalBetAmount = existingBet.betAmount;

        if (otype === 'back') {
          if (originalBetAmount >= p) {
            // Full offset
            existingBet.price = originalPrice - betAmount;
            existingBet.betAmount = originalBetAmount - p;
            user.avbalance += betAmount;
            console.log('Full score offset - back bet');
          } else {
            // Partial offset with type change
            existingBet.price = p - originalBetAmount;
            existingBet.betAmount = betAmount - originalPrice;
            existingBet.otype = otype;
            user.avbalance += originalPrice - (p - originalBetAmount);
            console.log('Partial score offset - back bet with type change');
          }
        } else if (otype === 'lay') {
          if (originalPrice > betAmount) {
            // Full offset
            existingBet.price = originalPrice - betAmount;
            existingBet.betAmount = originalBetAmount - p;
            user.avbalance += betAmount;
            console.log(' Full score offset - lay bet');
          } else {
            // Partial offset with type change
            existingBet.price = p - originalBetAmount;
            existingBet.betAmount = betAmount - originalPrice;
            existingBet.otype = otype;
            user.avbalance -= p - originalBetAmount - originalPrice;
            console.log(' Partial score offset - lay bet with type change');
          }
        }
        existingBet.xValue = x;
        existingBet.fancyScore = fancyScore;
        existingBet.placementType = 'score_offset';
        await existingBet.save();
        activeBetId = existingBet._id; // Track the bet ID
        await user.save();
      } else if (oddsOffset) {
        // PRIORITY 2: Odds Offset (Secondary Priority)
        placementType = 'odds_offset';
        parentBetSnapshot = {
          price: existingBet.price,
          betAmount: existingBet.betAmount,
          xValue: existingBet.xValue,
          otype: existingBet.otype,
          fancyScore: existingBet.fancyScore,
        };

        const originalPrice = existingBet.price;
        const originalBetAmount = existingBet.betAmount;

        if (otype === 'back') {
          if (originalBetAmount >= p) {
            // Full offset
            existingBet.price = originalPrice - betAmount;
            existingBet.betAmount = originalBetAmount - p;
            user.avbalance += betAmount;
          } else {
            // Partial offset with type change
            existingBet.price = p - originalBetAmount;
            existingBet.betAmount = betAmount - originalPrice;
            existingBet.otype = otype;
            user.avbalance += originalPrice - (p - originalBetAmount);
          }
        } else if (otype === 'lay') {
          if (originalPrice > betAmount) {
            // Full offset
            existingBet.price = originalPrice - betAmount;
            existingBet.betAmount = originalBetAmount - p;
            user.avbalance += betAmount;
          } else {
            // Partial offset with type change
            existingBet.price = p - originalBetAmount;
            existingBet.betAmount = betAmount - originalPrice;
            existingBet.otype = otype;
            user.avbalance -= p - originalBetAmount - originalPrice;
          }
        }
        existingBet.xValue = x;
        existingBet.fancyScore = fancyScore;
        existingBet.placementType = 'odds_offset';
        await existingBet.save();
        activeBetId = existingBet._id; // Track the bet ID
        await user.save();
      } else {
        // PRIORITY 3: No Offset - Create Separate Bet
        placementType = 'no_offset_separate';
        parentBetSnapshot = {
          price: existingBet.price,
          betAmount: existingBet.betAmount,
          xValue: existingBet.xValue,
          otype: existingBet.otype,
          fancyScore: existingBet.fancyScore,
        };

        user.avbalance -= p;
        const newBet = new betModel({
          userId: id,
          userName: user.userName,
          gameId,
          sid,
          price: p,
          betAmount,
          otype,
          xValue: x,
          fancyScore,
          gameType,
          market_id,
          eventName,
          marketName,
          gameName,
          teamName,
          fancyId: fancyMeta.fancyId ? String(fancyMeta.fancyId) : null,
          placementType: 'no_offset_separate',
        });
        await newBet.save();
        activeBetId = newBet._id; // Track the bet ID
        await user.save();
      }
    } else {
      // CASE 3: No Existing Bet - Create New Bet

      const newBet = new betModel({
        userId: id,
        userName: user.userName,
        gameId,
        sid,
        price: p,
        betAmount,
        otype,
        xValue: x,
        fancyScore,
        gameType,
        market_id,
        eventName,
        marketName,
        gameName,
        teamName,
        fancyId: fancyMeta.fancyId ? String(fancyMeta.fancyId) : null,
        placementType: 'new',
        mergeCount: 1,
      });
      await newBet.save();
      activeBetId = newBet._id; // Track the bet ID
    }

    // Record in bet history with tracking fields
    const betHistory = new betHistoryModel({
      betId: activeBetId ? activeBetId.toString() : null, // Link to parent bet for settlement
      userId: id,
      userName: user.userName,
      gameId,
      sid,
      price: p,
      betAmount,
      otype,
      xValue: x,
      fancyScore,
      gameType,
      market_id,
      eventName,
      marketName,
      gameName,
      teamName,
      placementType,
      parentBetSnapshot: parentBetSnapshot || undefined,
      userBalanceBefore: user.balance,
      userExposureBefore: user.exposure,
    });

    // Recalculate exposure from updated bets (fancy + non-fancy)
    const [, updatedPendingBets] = await Promise.all([
      betHistory.save(),
      betModel.find({ userId: id, status: 0 }),
    ]);
    user.exposure = calculateAllExposure(updatedPendingBets);
    user.avbalance = user.balance - user.exposure;

    // CRITICAL SAFETY CHECK: PTI must never be negative
    if (user.avbalance < 0) {
      throw new Error('Critical: PTI calculation error - fancy bet rejected');
    }

    await user.save();

    console.log(
      `[FANCY EXPOSURE] User ${user.userName}: exposure=${user.exposure}`
    );

    scheduleUplineUpdate(user._id);
    // Send updates to all connected clients
    sendOpenBetsUpdates(user);
    sendBalanceUpdates(user._id, user.avbalance);
    sendExposureUpdates(user._id, user.exposure);

    return res.status(201).json({ message: 'Bet placed successfully' });
  } catch (error) {
    console.error('Error placing bet:', error);
    return res
      .status(500)
      .json({ message: 'Server error', error: error.message });
  }
};

export const updateResultOfBets = async (req, res) => {
  const betTypes = [
    'Toss',
    '1st 6 over',
    'Match Odds',
    'Tied Match',
    'Bookmaker',
    'Bookmaker IPL CUP',
    'OVER_UNDER_05',
    'OVER_UNDER_15',
    'OVER_UNDER_25',
  ];

  let totalBetsProcessed = 0;
  const startTime = Date.now();

  try {
    // Step 1: Fetch unsettled sports bets (includes cashed-out — P/L applied at settlement)
    const gameBets = await betModel.find({
      status: 0,
      gameType: { $in: betTypes },
      gameId: { $exists: true },
      userId: { $exists: true },
    });

    if (!gameBets.length) {
      return (
        res?.status?.(200).json({ message: 'No unsettled bets found' }) || {
          success: true,
          total: 0,
        }
      );
    }

    // Step 1b: Map all users
    const userIds = [...new Set(gameBets.map((b) => b.userId))];
    const objectIds = userIds.map((id) => new mongoose.Types.ObjectId(id));
    const users = await SubAdmin.find({ _id: { $in: objectIds } });
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    // Step 2: Group bets by gameId + marketName (each market needs its own API call)
    const groupedBets = gameBets.reduce((acc, bet) => {
      if (!bet?.gameId) return acc;
      const groupKey = `${bet.gameId}_${bet.marketName || 'unknown'}`;
      if (!acc[groupKey]) acc[groupKey] = [];
      acc[groupKey].push(bet);
      return acc;
    }, {});

    // Step 3: Process each game-market group
    for (const groupKey of Object.keys(groupedBets)) {
      const gameId = groupKey.split('_')[0];
      const validBets = groupedBets[groupKey].filter(
        (b) => b?._id && b.status === 0 && b.sid
      );
      if (!validBets.length) continue;

      const sampleBet = validBets[0];
      let resultData;

      // Get API result
      try {
        const payload = {
          event_id: Number(sampleBet.gameId),
          event_name: sampleBet.eventName,
          market_id: sampleBet.market_id,
          market_name: toApiMarketName(sampleBet.marketName),
          client_ref: null,
          sport_id: sampleBet.sid,
        };

        if (process.env.DEV_MOCK_API === '1') {
          resultData = { final_result: 'Sorana Cirstea' };
        } else {
          resultData = await apiGetResult(payload);
        }
      } catch (err) {
        console.warn(`API error for game ${gameId}:`, err.message);
        continue;
      }

      if (!resultData?.final_result) continue;

      const winner = resultData.final_result.trim();

      // Check if match is voided (case-insensitive)
      const isVoid = winner.toLowerCase() === 'void';
      const isTied = winner.toLowerCase() === 'tied';

      // Step 4: Process bets with service
      for (const bet of validBets) {
        try {
          const user = userMap.get(bet.userId.toString());
          if (!user) {
            continue;
          }

          // Handle cashed-out bets: apply stored cashoutValue as P/L
          if (bet.isCashedOut) {
            const cashoutValue = bet.cashoutValue || 0;
            const cashoutStatus = cashoutValue >= 0 ? 1 : 2; // WIN or LOSS
            const cashoutSettledAt = new Date();
            const cashoutMs = cashoutSettledAt.getTime();

            const claimedBet = await betModel.findOneAndUpdate(
              { _id: bet._id, status: 0 },
              {
                $set: {
                  status: cashoutStatus,
                  resultAmount: Math.abs(cashoutValue),
                  profitLossChange: cashoutValue,
                  betResult: 'CASHOUT',
                  settledAt: cashoutSettledAt,
                },
              },
              { new: true }
            );
            if (!claimedBet) {
              console.log(
                `[SPORTS] SKIPPED cashed-out bet ${bet._id} - Already settled`
              );
              continue;
            }

            let cashoutBalanceBefore = roundTo2(user.balance || 0);
            let cashoutBalanceAfter = cashoutBalanceBefore;
            const cashoutDelta = isVoid ? 0 : roundTo2(cashoutValue);
            if (!isVoid) {
              console.log(
                `[SPORTS $inc CASHOUT] betId=${bet._id} userId=${bet.userId} cashoutValue=${cashoutValue}`
              );
              const updatedUser = await SubAdmin.findByIdAndUpdate(
                bet.userId,
                {
                  $inc: {
                    balance: cashoutValue,
                    bettingProfitLoss: cashoutValue,
                  },
                },
                { new: true, select: 'balance' }
              );
              if (updatedUser) {
                cashoutBalanceAfter = roundTo2(updatedUser.balance);
                cashoutBalanceBefore = roundTo2(
                  cashoutBalanceAfter - cashoutDelta
                );
              } else {
                cashoutBalanceAfter = roundTo2(
                  cashoutBalanceBefore + cashoutDelta
                );
              }
            }

            // Atomic per-row update: status + audit fields together
            const cashoutHistoryRecords = await betHistoryModel.find({
              betId: bet._id.toString(),
              status: 0,
            });
            if (cashoutHistoryRecords.length > 0) {
              const ops = cashoutHistoryRecords.map((historyRecord) => ({
                updateOne: {
                  filter: { _id: historyRecord._id },
                  update: {
                    $set: {
                      status: isVoid ? 3 : cashoutStatus,
                      resultAmount: isVoid ? 0 : Math.abs(cashoutValue),
                      profitLossChange: isVoid ? 0 : cashoutValue,
                      betResult: isVoid ? 'VOID' : 'CASHOUT',
                      settledBy: 'cashout',
                      settledAt: cashoutSettledAt,
                      balanceBeforeSettlement: cashoutBalanceBefore,
                      balanceAfterSettlement: cashoutBalanceAfter,
                      balanceDeltaApplied: cashoutDelta,
                      walletEntryRef: isVoid
                        ? `cashout:void:${bet._id}:${historyRecord._id}:${cashoutMs}`
                        : `cashout:settle:${bet._id}:${historyRecord._id}:${cashoutMs}`,
                    },
                  },
                },
              }));
              await betHistoryModel.bulkWrite(ops);
            }

            totalBetsProcessed++;
            continue;
          }

          // USE SERVICE: Settle or void sports bet
          let settlementResult;
          if (isVoid) {
            settlementResult = await sportsSettlementService.voidSportsBet(bet);
          } else if (isTied) {
            settlementResult = await sportsSettlementService.tiedSportsBet(
              bet,
              user
            );
          } else {
            settlementResult = await sportsSettlementService.settleSportsBet(
              bet,
              user,
              winner
            );
          }

          if (!settlementResult.success) {
            console.error(
              `Failed to ${isVoid ? 'void' : 'settle'} sports bet ${bet._id}:`,
              settlementResult.message
            );
            continue;
          }

          // Atomic claim: only settle if bet is still unsettled
          // Prevents double settlement when multiple PM2 processes run cron simultaneously
          const claimedBet = await betModel.findOneAndUpdate(
            { _id: bet._id, status: 0 },
            { $set: settlementResult.betUpdates },
            { new: true }
          );
          if (!claimedBet) {
            console.log(
              `[SPORTS] SKIPPED Bet ${bet._id} - Already settled by another process`
            );
            continue;
          }
          Object.assign(bet, settlementResult.betUpdates);
          const settlementAt = bet.settledAt || new Date();
          const settlementMs = new Date(settlementAt).getTime();
          const settlementDelta = roundTo2(
            settlementResult.userUpdates?.balanceChange || 0
          );
          let settlementBalanceBefore = roundTo2(user.balance || 0);
          let settlementBalanceAfter = settlementBalanceBefore;

          // STEP 1: Find unsettled history rows for this parent bet
          const betHistoryRecords = await betHistoryModel.find({
            betId: bet._id.toString(),
            status: 0,
          });

          // STEP 2: Pre-compute settlement plan for each row WITHOUT writing
          // anything yet. This lets us know betHistoryTotalPL before the
          // wallet $inc, and lets us stamp every field on each row in a
          // single atomic write at the end (eliminates the partial-update
          // window where settledBy/settledAt landed but balance audit
          // fields were lost on a process restart).
          let betHistoryTotalPL = 0;
          const rowPlans = [];
          for (const historyRecord of betHistoryRecords) {
            if (isVoid) {
              rowPlans.push({
                _id: historyRecord._id,
                isVoid: true,
                status: 3,
                resultAmount: Math.abs(historyRecord.price || 0),
                profitLossChange: 0,
                betResult: 'VOID',
              });
              continue;
            }

            const historyTeam = (historyRecord.teamName || '').trim();
            const winnerTeam = (bet.betResult || '').trim();
            const historyWin =
              historyTeam &&
              winnerTeam &&
              historyTeam.toLowerCase() === winnerTeam.toLowerCase();

            let historyStatus;
            let historyResultAmount;
            let historyProfitLossChange;
            if (historyRecord.otype === 'back') {
              if (historyWin) {
                historyStatus = 1;
                historyResultAmount = Math.abs(historyRecord.betAmount || 0);
                historyProfitLossChange = historyRecord.betAmount || 0;
              } else {
                historyStatus = 2;
                historyResultAmount = Math.abs(historyRecord.price || 0);
                historyProfitLossChange = -(historyRecord.price || 0);
              }
            } else {
              if (historyWin) {
                historyStatus = 2;
                historyResultAmount = Math.abs(historyRecord.price || 0);
                historyProfitLossChange = -(historyRecord.price || 0);
              } else {
                historyStatus = 1;
                historyResultAmount = Math.abs(historyRecord.betAmount || 0);
                historyProfitLossChange = historyRecord.betAmount || 0;
              }
            }

            betHistoryTotalPL += historyProfitLossChange;
            rowPlans.push({
              _id: historyRecord._id,
              isVoid: false,
              status: historyStatus,
              resultAmount: historyResultAmount,
              profitLossChange: historyProfitLossChange,
              betResult: winnerTeam,
              meta: { historyTeam, winnerTeam, historyWin },
            });
          }

          // STEP 3: Apply wallet $inc using betHistory sum as the single
          // source of truth (parent fallback only when no history rows).
          let effectiveDelta = 0;
          if (!isVoid && settlementResult.userUpdates) {
            const useHistorySum = betHistoryRecords.length > 0;
            const balanceInc = useHistorySum
              ? betHistoryTotalPL
              : settlementResult.userUpdates.balanceChange;
            const bplChange = useHistorySum
              ? betHistoryTotalPL
              : settlementResult.userUpdates.profitLossChange;
            effectiveDelta = roundTo2(
              useHistorySum ? betHistoryTotalPL : settlementDelta
            );

            console.log(
              `[SPORTS $inc] betId=${bet._id} userId=${bet.userId} balanceInc=${balanceInc} bplInc=${bplChange} parentDelta=${settlementDelta} useHistorySum=${useHistorySum}`
            );

            const updatedUser = await SubAdmin.findByIdAndUpdate(
              bet.userId,
              {
                $inc: {
                  balance: balanceInc,
                  bettingProfitLoss: bplChange,
                },
              },
              { new: true, select: 'balance' }
            );
            if (updatedUser) {
              settlementBalanceAfter = roundTo2(updatedUser.balance);
              settlementBalanceBefore = roundTo2(
                settlementBalanceAfter - effectiveDelta
              );
            } else {
              settlementBalanceAfter = roundTo2(
                settlementBalanceBefore + effectiveDelta
              );
            }

            // Keep parent betModel consistent with aggregate of children so
            // reports that read parent profitLossChange match the wallet.
            if (
              useHistorySum &&
              betHistoryTotalPL !==
                (settlementResult.betUpdates?.profitLossChange ?? null)
            ) {
              try {
                await betModel.updateOne(
                  { _id: bet._id },
                  {
                    $set: {
                      profitLossChange: betHistoryTotalPL,
                      resultAmount: Math.abs(betHistoryTotalPL),
                    },
                  }
                );
              } catch (syncErr) {
                console.error(
                  `[SPORTS] Failed to sync parent profitLossChange for ${bet._id}:`,
                  syncErr.message
                );
              }
            }
          }

          // STEP 4: Single ATOMIC write per row with EVERYTHING (status +
          // settledBy/settledAt + audit fields). One bulkWrite means a
          // process crash here either leaves all rows updated or none —
          // never the partially-updated state we used to see (settledBy
          // set but balanceDeltaApplied missing).
          if (rowPlans.length > 0) {
            const ops = rowPlans.map((plan) => ({
              updateOne: {
                filter: { _id: plan._id },
                update: {
                  $set: {
                    status: plan.status,
                    resultAmount: plan.resultAmount,
                    profitLossChange: plan.profitLossChange,
                    betResult: plan.betResult,
                    settledBy: bet.settledBy || 'api',
                    settledAt: settlementAt,
                    balanceBeforeSettlement: settlementBalanceBefore,
                    balanceAfterSettlement: settlementBalanceAfter,
                    balanceDeltaApplied: plan.isVoid ? 0 : effectiveDelta,
                    walletEntryRef: plan.isVoid
                      ? `sports:void:${bet._id}:${plan._id}:${settlementMs}`
                      : `sports:settle:${bet._id}:${plan._id}:${settlementMs}`,
                  },
                },
              },
            }));
            await betHistoryModel.bulkWrite(ops);

            for (const plan of rowPlans) {
              if (plan.isVoid) {
                console.log(` [SPORTS BETHISTORY] Voided: ${plan._id}`);
              } else {
                const m = plan.meta || {};
                console.log(
                  ` [SPORTS BETHISTORY] Settled: ${plan._id} Team:${m.historyTeam} Winner:${m.winnerTeam} Won:${m.historyWin} Status:${plan.status} Amount:${plan.resultAmount}`
                );
              }
            }
          }

          totalBetsProcessed++;
        } catch (err) {
          console.error(`Error processing bet ${bet._id}:`, err.message);
        }
      }
    }

    // Recalculate exposure and send updates
    const allProcessedUserIds = [
      ...new Set(gameBets.map((b) => b.userId.toString())),
    ];

    for (const userId of allProcessedUserIds) {
      try {
        const updatedPendingBets = await betModel.find({
          userId: userId,
          status: 0,
        });

        const newExposure =
          sportsSettlementService.calculateExposure(updatedPendingBets);

        // Atomic: set exposure and recalculate avbalance from fresh balance
        const freshUser = await SubAdmin.findByIdAndUpdate(
          userId,
          [
            {
              $set: {
                exposure: newExposure,
                avbalance: { $subtract: ['$balance', newExposure] },
              },
            },
          ],
          { new: true }
        );

        if (freshUser) {
          sendBalanceUpdates(userId, freshUser.avbalance);
          sendExposureUpdates(userId, newExposure);
          sendOpenBetsUpdates(userId, null);
        }
      } catch (err) {
        console.error(
          `Error recalculating exposure for user ${userId}:`,
          err.message
        );
      }
    }

    // USE SERVICE: Propagate upline updates
    if (allProcessedUserIds.length > 0) {
      await updateAllUplines(allProcessedUserIds);
    }

    const processingTime = Date.now() - startTime;

    return (
      res?.status?.(200).json({
        message: 'All bets processed successfully',
        total: totalBetsProcessed,
        processingTimeMs: processingTime,
        gamesProcessed: Object.keys(groupedBets).length,
      }) || { success: true, total: totalBetsProcessed }
    );
  } catch (error) {
    console.error('Error in updateResultOfBets:', error.message);
    return (
      res?.status?.(500).json({ message: 'Server error' }) || {
        success: false,
        error: error.message,
      }
    );
  }
};

export const updateResultOfCasinoBets = async (req, res) => {
  const startTime = new Date().toISOString();

  //  Check if already processing (prevent concurrent executions)
  if (isProcessingCasinoBets) {
    // console.log(` [${startTime}] SKIPPED - Already processing casino bets`);
    const response = {
      message: 'Already processing casino bets, skipped',
      total: 0,
    };
    return res?.status ? res.status(200).json(response) : response;
  }

  //  #1: Acquire lock
  isProcessingCasinoBets = true;
  // console.log(` [${startTime}] LOCK ACQUIRED - Starting casino settlement`);

  const TARGET_BETTYPE = 'casino';
  const TARGET_MARKET = 'WINNER';
  let totalBetsProcessed = 0;

  const timeStamp = new Date().toISOString();

  try {
    // Step 1: Fetch all unsettled casino bets
    const bets = await betModel.find({
      status: 0,
      betType: TARGET_BETTYPE,
      marketName: TARGET_MARKET,
    });

    if (!bets.length) {
      try {
        //  Get active game IDs from connected WebSocket clients
        const activeGameIds = [
          ...new Set(
            clients
              .filter((client) => client.apitype === 'casino' && client.gameid)
              .map((client) => client.gameid)
          ),
        ];

        // If no clients connected, use default game IDs
        const gameIds = activeGameIds.length > 0 ? activeGameIds : ['poison20'];

        for (const gameId of gameIds) {
          try {
            // Get results for this game with retry logic
            let providerResp = null;
            let retryCount = 0;
            const maxRetries = 2;

            while (retryCount <= maxRetries) {
              try {
                const casinoResultData = await apiFetchCasinoResult(gameId);
                providerResp = { data: casinoResultData };
                break; // Success, exit retry loop
              } catch (apiErr) {
                retryCount++;
                console.warn(
                  ` [RESULT BROADCAST] API attempt ${retryCount} failed for ${gameId}:`,
                  apiErr.message
                );

                if (retryCount > maxRetries) {
                  providerResp = {
                    data: {
                      res: [
                        {
                          mid: Date.now(),
                          winner: '1',
                          gameId: gameId,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    },
                  };
                } else {
                  await new Promise((resolve) =>
                    setTimeout(resolve, 1000 * retryCount)
                  );
                }
              }
            }

            const resultData = providerResp?.data;
            const resultsArray = resultData?.data?.res || resultData?.res || [];

            if (resultsArray && resultsArray.length > 0) {
              console.log(
                ` [DEBUG] Results array found for ${gameId}:`,
                resultsArray.length,
                'results'
              );

              //  FIXED: Only send RECENT results (not old cached results)
              if (resultsArray.length > 0) {
                const recentResults = resultsArray;

                if (recentResults.length > 0) {
                  // Sort by mid to get the most recent
                  const sortedRecentResults = recentResults.sort(
                    (a, b) => (b.mid || 0) - (a.mid || 0)
                  );
                  const latestRecentResult = sortedRecentResults[0];

                  const latestRoundId = latestRecentResult.mid.toString();
                } else {
                  console.log(` [FILTER] No results found for ${gameId}`);
                }
              }
            } else {
              console.log(
                ` [DEBUG] No results array or empty results for ${gameId}`
              );
            }
          } catch (err) {
            console.error(
              ` [RESULT BROADCAST] Error getting results for ${gameId}:`,
              err.message
            );
          }
        }
      } catch (err) {
        console.error(
          ` [RESULT BROADCAST] Error in result broadcasting:`,
          err.message
        );
      }

      const response = {
        message: 'All casino bets processed successfully',
        total: 0,
      };

      //  CRITICAL FIX: Release lock before early return
      const endTime = new Date().toISOString();
      isProcessingCasinoBets = false;

      return res?.status ? res.status(200).json(response) : response;
    }

    // Step 2: Group bets by gameId and collect unique userIds
    const groupedBets = bets.reduce((acc, b) => {
      const gid = b.gameId || 'unknown';
      if (!acc[gid]) acc[gid] = [];
      acc[gid].push(b);
      return acc;
    }, {});

    const userIds = [...new Set(bets.map((b) => b.userId))];
    let allProcessedUserIds = [];
    // console.log('The grouped bets of Casino are', groupedBets);

    // Step 4: Process each game group
    for (const gameId of Object.keys(groupedBets)) {
      const group = groupedBets[gameId];
      const roundId = group[0]?.roundId;
      // console.log('The group Of Casino is', group, 'and the roundId is', roundId);

      let providerResp = null;

      // Step 4a: Get provider response
      if (String(process.env.USE_MOCK_CASINO_API) === '0') {
        console.log(
          `[updateResultOfCasinoBets] using mock provider for gameId=${gameId}`
        );
        providerResp = {
          data: { res: [{ mid: 174250902211301, winner: '1' }] },
        };
      } else {
        try {
          // console.log('before lucky7eu2 api call');

          const casinoResultData = await apiFetchCasinoResult(gameId);
          providerResp = { data: casinoResultData };
        } catch (err) {
          console.error(
            `[updateResultOfCasinoBets] provider call failed for gameId=${gameId}`,
            err.message || err
          );
          continue;
        }
      }

      // Step 4b: Parse provider response
      let resultData = providerResp?.data;
      if (typeof resultData === 'string') {
        try {
          resultData = JSON.parse(resultData);
        } catch (e) {
          console.warn(
            `[updateResultOfCasinoBets] provider returned non-JSON body for gameId=${gameId}`
          );
          continue;
        }
      }

      const resultsArray = resultData?.data?.res || resultData?.res || [];
      // console.log('resultsArray is', resultsArray);
      if (!Array.isArray(resultsArray)) {
        console.warn(
          `[updateResultOfCasinoBets] provider returned unexpected shape for gameId=${gameId}`
        );
        continue;
      }

      // Step 4c: Create results map
      const resultsByMid = new Map();
      for (const r of resultsArray) {
        if (r?.mid != null) resultsByMid.set(String(r.mid), r);
      }

      // Step 5: Process bets in batch to avoid multiple saves
      const betUpdates = [];
      const userUpdates = new Map();

      for (const bet of group) {
        try {
          const freshBet = await betModel.findOne({
            _id: bet._id,
            status: 0,
          });

          if (!freshBet) {
            const skipTime = new Date().toISOString();
            console.log(
              ` [${skipTime}] SKIPPED Bet:${bet._id} Round:${bet.roundId} - Already settled`
            );
            continue;
          }

          Object.assign(bet, freshBet.toObject());

          const user = await SubAdmin.findById(bet.userId);
          if (!user) {
            console.warn(
              `[updateResultOfCasinoBets] user not found for bet ${bet._id}`
            );
            continue;
          }

          const roundIdStr = String(bet.roundId || bet.market_id || '');
          const matchingResult = resultsByMid.get(roundIdStr);

          if (!matchingResult) {
            console.warn(
              `[updateResultOfCasinoBets] no matching result for bet ${bet._id} roundId=${roundIdStr}`
            );
            continue;
          }

          let winnerTeam = '';
          let betTeam = '';
          let win = false;

          const winnerRaw = (
            matchingResult.winner ||
            matchingResult.win ||
            ''
          ).trim();
          winnerTeam =
            winnerRaw === '1'
              ? 'PLAYER A'
              : winnerRaw === '2'
                ? 'PLAYER B'
                : 'winner';

          betTeam = (bet.teamName || '').trim();
          win =
            betTeam &&
            winnerTeam &&
            betTeam.toLowerCase() === winnerTeam.toLowerCase();

          // Step 5c: Calculate settlement
          let winAmount = 0;
          let userBalanceChange = 0;
          let userAvBalanceChange = 0;
          let userProfitLossChange = 0;

          if (bet.otype === 'back') {
            if (win) {
              // console.log("jeet gya");
              // console.log("bet result amount is:",bet.betAmount);
              // Back bet wins - handle offset bets with negative betAmount
              if (bet.betAmount < 0) {
                // Offset bet: betAmount is the net result of combined position
                userBalanceChange = bet.betAmount; // -38 (net loss despite winning)
                userAvBalanceChange = 0; // No change - avbalance already reflects locked amount
                userProfitLossChange = bet.betAmount; // -38
                bet.resultAmount = Math.abs(bet.betAmount); // 38 (absolute loss amount)
                bet.status = 2; // ❗ Set status to LOSS because user loses money
              } else {
                // Normal back bet
                winAmount = bet.betAmount + bet.price;
                userBalanceChange = winAmount - bet.price;
                userAvBalanceChange = winAmount;
                userProfitLossChange = winAmount - bet.price;
                bet.resultAmount = Math.abs(winAmount - bet.price);
                bet.status = 1; //  Status 1 = WIN (user gains money)
              }
              bet.settledBy = 'api';
              bet.settledAt = Date.now();
            } else {
              // console.log("jeet gya2");
              // Back bet loses - unified logic using price (stake at risk)
              // Works for ALL cases:
              //   price > 0  → normal loss (user loses stake)
              //   price = 0  → break-even offset (no loss)
              //   price < 0  → guaranteed profit (user gains)
              //   betAmount < 0 with price > 0 → guaranteed loss (user loses price)
              {
                userBalanceChange = -bet.price;
                userAvBalanceChange = 0;
                userProfitLossChange = -bet.price;
                bet.resultAmount = Math.abs(bet.price);
                bet.status = bet.price === 0 ? 1 : 2; // break-even → status 1, actual loss → status 2
                // console.log("bet status is:",bet.status);
              }
              bet.settledBy = 'api';
              bet.settledAt = Date.now();
            }
          } else {
            // lay bet logic here if needed
            if (win) {
              userBalanceChange = -bet.price;
              userAvBalanceChange = 0;
              userProfitLossChange = -bet.price;
              bet.resultAmount = Math.abs(bet.price);
              bet.settledBy = 'api';
              bet.settledAt = Date.now();
              bet.status = 2;
            } else {
              // LAY bet wins when the team LOSES

              // Handle negative price (guaranteed profit scenario from offset bets)
              if (bet.price < 0) {
                // Negative price means user has guaranteed profit locked in
                // Don't use totalReturn formula which would produce negative value
                userBalanceChange = bet.betAmount; // +100
                userAvBalanceChange = bet.betAmount; // +100 (NOT negative!)
                userProfitLossChange = bet.betAmount; // +100
                winAmount = bet.betAmount;
                bet.resultAmount = Math.abs(bet.betAmount);
              } else {
                // Normal LAY bet wins
                // User gets back their staked amount (price) + profit (betAmount)
                const stakedAmount = bet.price;
                const profitAmount = bet.betAmount;
                const totalReturn = stakedAmount + profitAmount;

                userBalanceChange = profitAmount;
                userAvBalanceChange = totalReturn;
                userProfitLossChange = profitAmount;
                winAmount = totalReturn;
                bet.resultAmount = Math.abs(profitAmount);
              }

              bet.settledBy = 'api';
              bet.settledAt = Date.now();
              bet.status = 1;
            }
          }

          const claimedCasinoBet = await betModel.findOneAndUpdate(
            { _id: bet._id, status: 0 },
            {
              $set: {
                status: bet.status,
                resultAmount: bet.resultAmount,
                settledBy: bet.settledBy,

                settledAt: bet.settledAt,
                profitLossChange: userProfitLossChange,
                betResult: Array.isArray(winnerTeam)
                  ? winnerTeam.join(',')
                  : winnerTeam,
                betResultArray: bet.betResultArray,
              },
            },
            { new: true }
          );

          console.log(
            'claimedCasinoBet is:',
            JSON.stringify(claimedCasinoBet, null, 2)
          );

          // console.log("claimedCasinoBet is:",JSON.stringify(claimedCasinoBet, null, 2));
          if (!claimedCasinoBet) {
            console.log(
              `[CASINO] SKIPPED Bet ${bet._id} - Already settled by another process`
            );
            continue;
          }

          // Step 5d: Accumulate user changes (avoid multiple saves)
          const userId = user._id.toString();
          if (!userUpdates.has(userId)) {
            userUpdates.set(userId, {
              user,
              balanceChange: 0,
              avBalanceChange: 0,
              profitLossChange: 0,
            });
          }

          const userUpdate = userUpdates.get(userId);
          userUpdate.balanceChange += userBalanceChange;
          userUpdate.avBalanceChange += userAvBalanceChange;
          userUpdate.profitLossChange += userProfitLossChange;

          betUpdates.push(claimedCasinoBet);
          totalBetsProcessed++;
        } catch (err) {
          console.error(
            `[updateResultOfCasinoBets] error processing bet ${bet._id}:`,
            err.message || err
          );
        }
      }

      // Step 6: Batch update users (atomic $inc per user - prevents lost updates)
      for (const [userId, update] of userUpdates) {
        try {
          const { balanceChange, avBalanceChange, profitLossChange } = update;

          console.log(
            `[CASINO $inc] userId=${userId} balanceChange=${balanceChange} avBalanceChange=${avBalanceChange} bplChange=${profitLossChange}`
          );
          await SubAdmin.findByIdAndUpdate(userId, {
            $inc: {
              balance: balanceChange,
              avbalance: avBalanceChange,
              bettingProfitLoss: profitLossChange,
            },
          });

          // Send WebSocket updates with fresh values
          const freshUser = await SubAdmin.findById(userId);
          sendBalanceUpdates(userId, freshUser.avbalance);
          sendExposureUpdates(userId, freshUser.exposure);
          sendOpenBetsUpdates(userId, null);
        } catch (err) {
          console.error(
            `[updateResultOfCasinoBets] error saving user:`,
            err.message || err
          );
        }
      }

      // Step 7: Batch update bets
      if (betUpdates.length > 0) {
        try {
          await Promise.all(betUpdates.map((bet) => bet.save()));
          console.log(
            ` [SETTLEMENT] Saved ${betUpdates.length} bets for gameId=${gameId}`
          );

          //  UPDATE BETHISTORY: Settle each individual bet history record
          // Each betHistory record represents an individual bet and must be settled based on its OWN teamName
          let totalBetHistoryUpdated = 0;

          for (const bet of betUpdates) {
            try {
              // Find ALL betHistory records linked to this bet (unsettled only)
              const betHistoryRecords = await betHistoryModel.find({
                betId: bet._id.toString(),
                status: 0,
              });

              // Settle each betHistory record INDIVIDUALLY based on its own teamName
              for (const historyRecord of betHistoryRecords) {
                const historyTeam = (historyRecord.teamName || '').trim();

                let historyWin;
                let winnerTeam;

                winnerTeam = (bet.betResult || '').trim();
                historyWin =
                  historyTeam &&
                  winnerTeam &&
                  historyTeam.toLowerCase() === winnerTeam.toLowerCase();

                let historyStatus;
                let historyResultAmount;
                let historyProfitLossChange;

                if (historyRecord.otype === 'back') {
                  if (historyWin) {
                    // Individual back bet WON - profit is betAmount
                    historyStatus = 1;
                    historyResultAmount = Math.abs(
                      historyRecord.betAmount || 0
                    );
                    historyProfitLossChange = historyRecord.betAmount || 0;
                  } else {
                    // Individual back bet LOST - lost the stake (price)
                    historyStatus = 2;
                    historyResultAmount = Math.abs(historyRecord.price || 0);
                    historyProfitLossChange = -(historyRecord.price || 0);
                  }
                } else {
                  // Lay bet
                  if (historyWin) {
                    // Lay bet LOSES when selection wins
                    historyStatus = 2;
                    historyResultAmount = Math.abs(historyRecord.price || 0);
                    historyProfitLossChange = -(historyRecord.price || 0);
                  } else {
                    // Lay bet WINS when selection loses
                    historyStatus = 1;
                    historyResultAmount = Math.abs(
                      historyRecord.betAmount || 0
                    );
                    historyProfitLossChange = historyRecord.betAmount || 0;
                  }
                }

                await betHistoryModel.updateOne(
                  { _id: historyRecord._id },
                  {
                    $set: {
                      status: historyStatus,
                      resultAmount: historyResultAmount,
                      profitLossChange: historyProfitLossChange,
                      betResult: Array.isArray(winnerTeam)
                        ? winnerTeam.join(',')
                        : winnerTeam,
                      settledBy: bet.settledBy || 'api',
                      settledAt: bet.settledAt || Date.now(),
                    },
                  }
                );

                totalBetHistoryUpdated++;

                console.log(
                  ` [BETHISTORY] Settled: ${historyRecord._id} Team:${historyTeam} Winner:${winnerTeam} Won:${historyWin} Status:${historyStatus} Amount:${historyResultAmount}`
                );
              }
            } catch (err) {
              console.error(
                `[updateResultOfCasinoBets] error updating bet history for bet ${bet._id}:`,
                err.message || err
              );
            }
          }

          console.log(
            ` [SETTLEMENT] Updated ${totalBetHistoryUpdated} bet history records for gameId=${gameId}`
          );
        } catch (err) {
          console.error(
            `[updateResultOfCasinoBets] error saving bets:`,
            err.message || err
          );
        }
      }

      // const allProcessedUserIds = [...new Set(group.map(b => b.userId.toString()))];
      const currentGroupUserIds = [
        ...new Set(group.map((b) => b.userId.toString())),
      ];
      allProcessedUserIds = [
        ...new Set([...allProcessedUserIds, ...currentGroupUserIds]),
      ];

      for (const userId of currentGroupUserIds) {
        try {
          const updatedPendingBets = await betModel.find({
            userId: userId,
            status: 0,
          });

          // Market-based exposure calculation (handles offsetting correctly)
          const newExposure = calculateAllExposure(updatedPendingBets);

          // Atomic exposure + avbalance update (prevents stale overwrites from concurrent cron jobs)
          const freshUser = await SubAdmin.findByIdAndUpdate(
            userId,
            [
              {
                $set: {
                  exposure: newExposure,
                  avbalance: { $subtract: ['$balance', newExposure] },
                },
              },
            ],
            { new: true }
          );

          if (freshUser) {
            console.log('The exposure of the user is', freshUser.exposure);
            console.log('The avbalance of the user is', freshUser.avbalance);
            console.log(
              `[DEBUG] User ${freshUser.userName} saved successfully`
            );
          }
        } catch (err) {
          console.error(
            ` Error recalculating exposure for user ${userId}:`,
            err.message
          );
        }
      }
    }

    const socketUpdates = allProcessedUserIds.map(async (userId) => {
      try {
        const user = await SubAdmin.findById(userId);
        if (user) {
          return Promise.all([
            sendBalanceUpdates(userId, user.avbalance),
            sendExposureUpdates(userId, user.exposure),
            sendOpenBetsUpdates(userId, null),
          ]);
        }
      } catch (err) {
        console.error(
          ` Error sending WebSocket update for user ${userId}:`,
          err.message
        );
      }
    });

    await Promise.all(socketUpdates);
    console.timeEnd('CASINO_SOCKET_UPDATES');
    console.log(
      ` WebSocket updates sent for ${allProcessedUserIds.length} users`
    );

    // Update all upline balances after casino bet settlement
    try {
      console.time('CASINO_RESULT_UPLINE_UPDATE');
      await updateAllUplines(allProcessedUserIds);
      console.timeEnd('CASINO_RESULT_UPLINE_UPDATE');
      // await updateAllUplines(user._id);
    } catch (err) {
      console.error(
        ` [CASINO SETTLEMENT] Error updating upline balances:`,
        err.message
      );
    }

    //  Result broadcasting - runs regardless of whether there are bets or not
    // This ensures all users get casino results, even if they haven't placed bets
    for (const gameId of Object.keys(groupedBets)) {
      try {
        // Get results for this game
        const resultData = await apiFetchCasinoResult(gameId);
        const resultsArray = resultData?.data?.res || resultData?.res || [];

        if (resultsArray.length > 0) {
          console.log(
            ` [DEBUG] Found ${resultsArray.length} results for ${gameId}`
          );

          // Frontend now fetches results via API when round changes (useRef detection)

          const sortedResults = resultsArray.sort(
            (a, b) => (b.mid || 0) - (a.mid || 0)
          );
          const latestResult = sortedResults[0];
          const latestRoundId = latestResult.mid.toString();

          console.log(
            ` [SETTLEMENT] Results available via API for ${gameId} (latest: ${latestRoundId})`
          );
        } else {
          console.log(
            ` [DEBUG] No results array or empty results for ${gameId}`
          );
        }
      } catch (err) {
        console.error(
          ` [RESULT BROADCAST] Error getting results for ${gameId}:`,
          err.message
        );
      }
    }

    // Step 8: Final response
    const response = {
      message: 'All casino bets processed successfully',
      total: totalBetsProcessed,
    };

    //  Release lock after successful processing
    const endTime = new Date().toISOString();
    isProcessingCasinoBets = false;
    console.log(
      ` [${endTime}] LOCK RELEASED - Processed ${totalBetsProcessed} bets`
    );

    return res?.status ? res.status(200).json(response) : response;
  } catch (err) {
    const errorTime = new Date().toISOString();
    console.error(` [${errorTime}] ERROR in casino settlement:`, err.message);

    // FIX #1: Release lock on error (prevents permanent lock)
    isProcessingCasinoBets = false;
    console.log(` [${errorTime}] LOCK RELEASED after error`);

    const errorResponse = {
      message: 'Casino Server error',
      error: err.message || err,
    };
    return res?.status ? res.status(500).json(errorResponse) : errorResponse;
  }
};

export const updateFancyBetResult = async (req, res) => {
  try {
    const betTypes = [
      { gameType: 'Normal', marketName: 'Toss' },
      { gameType: 'meter', marketName: 'Match Odds' },
      { gameType: 'line', marketName: 'Tied Match' },
      { gameType: 'ball', marketName: 'Bookmaker' },
      { gameType: 'khado', marketName: 'Bookmaker' },
      // fancy1: yes/no outcome markets. Reuses the fancyresult endpoint (has
      // fancyId from placement) but settles on a raw "1"/"0" flag instead of
      // a score threshold.
      { gameType: 'fancy1', marketName: 'fancy1' },
      // oddeven: parity-based settlement. Reuses fancyresult; result is a
      // number whose parity determines the winning side ("Odd"/"Even").
      { gameType: 'oddeven', marketName: 'oddeven' },
    ];

    let totalBetsProcessed = 0;
    let allProcessedUserIds = [];

    for (const { gameType, marketName } of betTypes) {
      // Fetch ONLY fancy bets for settlement
      const bets = await betModel.find({
        status: 0,
        gameType,
        betType: { $in: ['fancy', 'sports'] },
      });
      console.log(`Processing ${gameType} fancy bets:`, bets.length);

      if (!bets.length) {
        console.log(`No ${gameType} bets found with status 0`);
        continue;
      }

      // Group bets by gameId
      const groupedBets = bets.reduce((acc, bet) => {
        if (!acc[bet.gameId]) acc[bet.gameId] = [];
        acc[bet.gameId].push(bet);
        return acc;
      }, {});

      for (const gameId of Object.keys(groupedBets)) {
        try {
          const isProviderB =
            getProviderName() === 'providerb' ||
            getProviderName() === 'provider_b';

          const isProviderC =
            getProviderName() === 'providerc' ||
            getProviderName() === 'provider_c';

          for (const bet of groupedBets[gameId]) {
            const sid = bet.sid;

            // Get API result (or use mock for testing)
            let score;

            if (process.env.DEV_MOCK_API === '1') {
              score = '200';
              console.log(` [MOCK API] Using test score: ${score}`);
            } else if ((isProviderB || isProviderC) && bet.fancyId) {
              // Provider B: use /cricket/fancyresult with eventId + fancyId
              try {
                const fancyResult = await apiFetchCricketFancyResult(
                  bet.gameId,
                  bet.fancyId
                );

                console.log(
                  `[SETTLE-FANCY] Bet ${bet._id} Game ${bet.gameId} fancyId=${bet.fancyId} ProviderB response:`,
                  JSON.stringify(fancyResult)
                );

                if (!fancyResult || fancyResult.result == null) {
                  console.log(
                    `[SETTLE-FANCY] Bet ${bet._id} No result yet for fancyId=${bet.fancyId}`
                  );
                  continue;
                }

                score = fancyResult.result;
              } catch (err) {
                console.error(
                  `[SETTLE-FANCY] Bet ${bet._id} fancyresult API failed:`,
                  err.message
                );
                continue;
              }
            } else {
              // Provider A or bets without fancyId: use generic getResult endpoint
              const resultData = await apiGetResult({
                event_id: Number(bet.gameId),
                event_name: bet.eventName,
                market_id: bet.market_id,
                market_name: toApiMarketName(bet.marketName),
                client_ref: null,
                sport_id: bet.sid,
              });

              console.log(
                `[SETTLE-FANCY] Bet ${bet._id} Game ${bet.gameId} fallback response:`,
                JSON.stringify(resultData)
              );

              if (!resultData?.final_result) {
                continue;
              }

              score = resultData.final_result;
            }

            // Check if match is voided (case-insensitive)
            const isVoid = score && score.toString().toLowerCase() === 'void';

            const user = await SubAdmin.findById(bet.userId);

            if (!user) {
              console.warn(`User not found for bet ${bet._id}`);
              continue;
            }

            // USE SERVICE: Settle or void fancy bet
            let settlementResult;
            if (isVoid) {
              settlementResult =
                await fancyBetSettlementService.voidFancyBet(bet);
            } else if (bet.gameType === 'fancy1') {
              // fancy1 uses yes/no comparison, not score threshold
              settlementResult =
                await fancyBetSettlementService.settleFancy1Bet(
                  bet,
                  user,
                  score
                );
            } else if (bet.gameType === 'oddeven') {
              // oddeven compares teamName ("Odd"/"Even") to parity of result
              settlementResult =
                await fancyBetSettlementService.settleOddEvenBet(
                  bet,
                  user,
                  score
                );
            } else {
              settlementResult = await fancyBetSettlementService.settleFancyBet(
                bet,
                user,
                score
              );
            }

            if (!settlementResult.success) {
              console.error(
                `Failed to ${isVoid ? 'void' : 'settle'} fancy bet ${bet._id}:`,
                settlementResult.message
              );
              continue;
            }

            // Atomic claim: only settle if bet is still unsettled
            // Prevents double settlement when multiple PM2 processes run cron simultaneously
            const claimedBet = await betModel.findOneAndUpdate(
              { _id: bet._id, status: 0 },
              { $set: settlementResult.betUpdates },
              { new: true }
            );
            if (!claimedBet) {
              console.log(
                `[FANCY] SKIPPED Bet ${bet._id} - Already settled by another process`
              );
              continue;
            }
            Object.assign(bet, settlementResult.betUpdates);
            const settlementAt = bet.settledAt || new Date();
            const settlementMs = new Date(settlementAt).getTime();
            const settlementDelta = roundTo2(
              settlementResult.userUpdates?.balanceChange || 0
            );
            let settlementBalanceBefore = roundTo2(user.balance || 0);
            let settlementBalanceAfter = settlementBalanceBefore;

            // STEP 1: Find unsettled history rows for this parent bet
            const betHistoryRecords = await betHistoryModel.find({
              betId: bet._id.toString(),
              status: 0,
            });

            // STEP 2: Pre-compute settlement plan for each row WITHOUT writing
            // anything yet. This lets us know betHistoryTotalPL before the
            // wallet $inc, and lets us stamp every field on each row in a
            // single atomic write at the end (eliminates the partial-update
            // window where settledBy/settledAt landed but balance audit
            // fields were lost on a process restart).
            let betHistoryTotalPL = 0;
            const rowPlans = [];
            for (const historyRecord of betHistoryRecords) {
              if (isVoid) {
                rowPlans.push({
                  _id: historyRecord._id,
                  isVoid: true,
                  status: 3,
                  resultAmount: Math.abs(historyRecord.price || 0),
                  profitLossChange: 0,
                  betResult: 'VOID',
                });
                continue;
              }

              // Branch on gameType:
              // fancy1:  raw yes/no flag (back wins on yes/"1")
              // oddeven: teamName ("Odd"/"Even") vs winningSide
              // others:  score threshold (back wins if score >= fancyScore)
              let isWin;
              if (bet.gameType === 'fancy1') {
                const normalizedResult = String(bet.betResult || '')
                  .trim()
                  .toLowerCase();
                const yesHappened = ['1', 'yes', 'y', 'true'].includes(
                  normalizedResult
                );
                isWin =
                  historyRecord.otype === 'back' ? yesHappened : !yesHappened;
              } else if (bet.gameType === 'oddeven') {
                const winningSide = (bet.betResult || '')
                  .toString()
                  .trim()
                  .toLowerCase();
                const historySide = (historyRecord.teamName || '')
                  .trim()
                  .toLowerCase();
                isWin = historySide === winningSide;
              } else {
                const actualScore = parseFloat(bet.betResult || '0');
                const fancyScore = parseFloat(historyRecord.fancyScore || '0');
                isWin =
                  historyRecord.otype === 'back'
                    ? actualScore >= fancyScore
                    : actualScore < fancyScore;
              }

              let historyStatus;
              let historyResultAmount;
              let historyProfitLossChange;
              if (isWin) {
                historyStatus = 1;
                historyResultAmount = Math.abs(historyRecord.betAmount || 0);
                historyProfitLossChange = historyRecord.betAmount || 0;
              } else {
                historyStatus = 2;
                historyResultAmount = Math.abs(historyRecord.price || 0);
                historyProfitLossChange = -(historyRecord.price || 0);
              }

              betHistoryTotalPL += historyProfitLossChange;
              rowPlans.push({
                _id: historyRecord._id,
                isVoid: false,
                status: historyStatus,
                resultAmount: historyResultAmount,
                profitLossChange: historyProfitLossChange,
                betResult: bet.betResult,
              });
            }

            // STEP 3: Apply wallet $inc using betHistory sum as the single
            // source of truth (parent fallback only when no history rows).
            let effectiveDelta = 0;
            if (!isVoid && settlementResult.userUpdates) {
              const useHistorySum = betHistoryRecords.length > 0;
              const balanceInc = useHistorySum
                ? betHistoryTotalPL
                : settlementResult.userUpdates.balanceChange;
              const bplChange = useHistorySum
                ? betHistoryTotalPL
                : settlementResult.userUpdates.profitLossChange;
              effectiveDelta = roundTo2(
                useHistorySum ? betHistoryTotalPL : settlementDelta
              );

              console.log(
                `[FANCY $inc] betId=${bet._id} userId=${bet.userId} balanceInc=${balanceInc} bplInc=${bplChange} parentDelta=${settlementDelta} useHistorySum=${useHistorySum}`
              );

              const updatedUser = await SubAdmin.findByIdAndUpdate(
                bet.userId,
                {
                  $inc: {
                    balance: balanceInc,
                    bettingProfitLoss: bplChange,
                  },
                },
                { new: true, select: 'balance' }
              );
              if (updatedUser) {
                settlementBalanceAfter = roundTo2(updatedUser.balance);
                settlementBalanceBefore = roundTo2(
                  settlementBalanceAfter - effectiveDelta
                );
              } else {
                settlementBalanceAfter = roundTo2(
                  settlementBalanceBefore + effectiveDelta
                );
              }

              // Keep parent betModel consistent with aggregate of children so
              // reports that read parent profitLossChange match the wallet.
              if (
                useHistorySum &&
                betHistoryTotalPL !==
                  (settlementResult.betUpdates?.profitLossChange ?? null)
              ) {
                try {
                  await betModel.updateOne(
                    { _id: bet._id },
                    {
                      $set: {
                        profitLossChange: betHistoryTotalPL,
                        resultAmount: Math.abs(betHistoryTotalPL),
                      },
                    }
                  );
                } catch (syncErr) {
                  console.error(
                    `[FANCY] Failed to sync parent profitLossChange for ${bet._id}:`,
                    syncErr.message
                  );
                }
              }
            }

            // STEP 4: Single ATOMIC write per row with EVERYTHING (status +
            // settledBy/settledAt + audit fields). One bulkWrite means a
            // process crash here either leaves all rows updated or none —
            // never the partially-updated state we used to see (settledBy
            // set but balanceDeltaApplied missing).
            if (rowPlans.length > 0) {
              const ops = rowPlans.map((plan) => ({
                updateOne: {
                  filter: { _id: plan._id },
                  update: {
                    $set: {
                      status: plan.status,
                      resultAmount: plan.resultAmount,
                      profitLossChange: plan.profitLossChange,
                      betResult: plan.betResult,
                      settledBy: bet.settledBy || 'api',
                      settledAt: settlementAt,
                      balanceBeforeSettlement: settlementBalanceBefore,
                      balanceAfterSettlement: settlementBalanceAfter,
                      balanceDeltaApplied: plan.isVoid ? 0 : effectiveDelta,
                      walletEntryRef: plan.isVoid
                        ? `fancy:void:${bet._id}:${plan._id}:${settlementMs}`
                        : `fancy:settle:${bet._id}:${plan._id}:${settlementMs}`,
                    },
                  },
                },
              }));
              await betHistoryModel.bulkWrite(ops);

              for (const plan of rowPlans) {
                if (plan.isVoid) {
                  console.log(
                    ` [FANCY BETHISTORY] Voided: ${plan._id}`
                  );
                } else {
                  console.log(
                    ` [FANCY BETHISTORY] Settled: ${plan._id} Status:${plan.status} P/L:${plan.profitLossChange}`
                  );
                }
              }
            }

            totalBetsProcessed++;
          }
        } catch (err) {
          console.error(
            `Error processing fancy bets for gameId ${gameId}:`,
            err.message
          );
        }
      }

      //  USE SERVICE: Recalculate exposure and send updates
      const currentGroupUserIds = [
        ...new Set(bets.map((b) => b.userId.toString())),
      ];
      allProcessedUserIds = [
        ...new Set([...allProcessedUserIds, ...currentGroupUserIds]),
      ];

      for (const userId of currentGroupUserIds) {
        try {
          const updatedPendingBets = await betModel.find({
            userId: userId,
            status: 0,
          });

          const newExposure =
            fancyBetSettlementService.calculateExposure(updatedPendingBets);

          // Atomic: set exposure and recalculate avbalance from fresh balance
          const freshUser = await SubAdmin.findByIdAndUpdate(
            userId,
            [
              {
                $set: {
                  exposure: newExposure,
                  avbalance: { $subtract: ['$balance', newExposure] },
                },
              },
            ],
            { new: true }
          );

          if (freshUser) {
            sendBalanceUpdates(userId, freshUser.avbalance);
            sendExposureUpdates(userId, newExposure);
            sendOpenBetsUpdates(userId, null);

            console.log(
              ` [FANCY] User ${freshUser.userName}: exposure=${newExposure}, balance=${freshUser.balance}, avbalance=${freshUser.avbalance}`
            );
          }
        } catch (err) {
          console.error(
            `Error recalculating exposure for user ${userId}:`,
            err.message
          );
        }
      }
    }

    //  USE SERVICE: Propagate upline updates
    if (allProcessedUserIds.length > 0) {
      // await propagateUplineUpdates(allProcessedUserIds);
      await updateAllUplines(allProcessedUserIds);
    }

    // Handle response differently for cron vs HTTP
    if (res && typeof res.status === 'function') {
      return res.status(200).json({
        message: 'All fancy bets processed successfully',
        total: totalBetsProcessed,
      });
    } else {
      return { total: totalBetsProcessed };
    }
  } catch (error) {
    console.error('Error in updateFancyBetResult:', error);
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ message: 'Server error' });
    }
    throw error;
  }
};
export const updateResultOfBetsHistory = async (req, res) => {
  // Track all processed user IDs for upline update at the end
  const processedUserIds = new Set();
  const betTypes = [
    { gameType: 'casino', marketName: 'WINNER', category: 'casino' },
  ];

  let totalBetsProcessed = 0;

  try {
    for (const { gameType, category } of betTypes) {
      const filterQuery = { status: 0, gameType };
      if (category === 'casino') {
        filterQuery.betType = 'casino'; // Additional filter for casino bets
      }

      const bets = await betHistoryModel.find(filterQuery);

      if (!bets.length) {
        continue;
      }

      const groupedBets = bets.reduce((acc, bet) => {
        const key =
          category === 'casino' ? `${bet.gameId}_${bet.roundId}` : bet.gameId;

        if (!acc[key]) acc[key] = [];
        acc[key].push(bet);
        return acc;
      }, {});

      for (const groupKey of Object.keys(groupedBets)) {
        try {
          for (const bet of groupedBets[groupKey]) {
            const user = await SubAdmin.findById(bet.userId);
            if (!user) {
              continue;
            }

            let response;
            if (process.env.DEV_LOCAL_SETTLE_ENABLED === '0') {
              // For development/testing
              response = {
                data: {
                  final_result:
                    category === 'casino' ? 'PLAYER A' : 'Daniel Elahi Galan',
                },
              };
            } else {
              // Different API calls for sports vs casino
              if (category === 'sports') {
                const sid = bet.sid;
                const resultBody = await apiGetResult({
                  event_id: Number(bet.gameId),
                  event_name: bet.eventName,
                  market_id: bet.market_id,
                  market_name: toApiMarketName(bet.marketName),
                  client_ref: null,
                  sport_id: sid,
                });
                response = { data: resultBody };
              } else {
                // Casino API call
                const casinoDetailData = await apiFetchCasinoDetailResult(
                  bet.gameId,
                  bet.roundId
                );
                response = { data: casinoDetailData };
              }
            }

            const resultData = response?.data;
            console.log(
              `The result data of updateResultOfBetsHistory ${category} is`,
              resultData
            );

            if (!resultData) {
              continue;
            }

            // Extract winner differently for sports vs casino
            let winner;
            if (category === 'sports') {
              // Sports API returns { final_result: "PlayerName" }
              winner = resultData?.final_result?.trim();
            } else {
              // Casino API returns { data: { t1: { winnat: "..." } } }
              winner = resultData?.data?.t1?.winnat;
            }
            console.log(
              `The winner of updateResultOfBetHistory ${category} is`,
              winner
            );

            // Skip if no result available yet
            if (!winner) {
              continue;
            }
            const betTeam = bet.teamName?.trim();
            let winAmount = 0;

            const win =
              winner &&
              betTeam &&
              winner.toLowerCase() === betTeam.toLowerCase();

            //Settlement Logic
            if (
              bet.gameType === 'Match Odds' ||
              bet.gameType === 'Tied Match'
            ) {
              if (bet.otype === 'back') {
                if (win) {
                  winAmount = bet.betAmount;
                  bet.resultAmount = Math.abs(winAmount);
                  bet.profitLossChange = bet.betAmount;
                  bet.betResult = winner;
                  bet.settledBy = 'api';
                  bet.settledAt = Date.now();
                  bet.status = 1;
                } else {
                  bet.resultAmount = Math.abs(bet.price);
                  bet.profitLossChange = -bet.price;
                  bet.betResult = winner;
                  bet.settledBy = 'api';
                  bet.settledAt = Date.now();
                  bet.status = 2;
                }
              } else {
                // lay
                if (win) {
                  bet.resultAmount = Math.abs(bet.price);
                  bet.profitLossChange = -bet.price;
                  bet.betResult = winner;
                  bet.settledBy = 'api';
                  bet.settledAt = Date.now();
                  bet.status = 2;
                } else {
                  winAmount = bet.betAmount;
                  bet.resultAmount = Math.abs(winAmount);
                  bet.profitLossChange = bet.betAmount;
                  bet.betResult = winner;
                  bet.settledBy = 'api';
                  bet.settledAt = Date.now();
                  bet.status = 1;
                }
              }
            } else if (bet.gameType === 'casino') {
              // Casino bet logic (including individual bet history records)
              if (bet.otype === 'back') {
                if (win) {
                  // Back bet wins
                  winAmount = bet.betAmount;
                  bet.resultAmount = Math.abs(winAmount);
                  bet.profitLossChange = bet.betAmount;
                  bet.status = 1;
                } else {
                  // Back bet loses
                  bet.resultAmount = Math.abs(bet.price);
                  bet.profitLossChange = -bet.price;
                  bet.status = 2;
                }
              } else if (bet.otype === 'lay') {
                // Lay bet logic
                if (win) {
                  // Lay bet loses (team they bet against won)
                  bet.resultAmount = Math.abs(bet.price);
                  bet.profitLossChange = -bet.price;
                  bet.status = 2; // LOSE
                } else {
                  // Lay bet wins (team they bet against lost)
                  winAmount = bet.betAmount;
                  bet.resultAmount = Math.abs(winAmount);
                  bet.profitLossChange = bet.betAmount;
                  bet.status = 1; // WIN
                }
              }
              bet.betResult = winner;
              bet.settledBy = 'api';
              bet.settledAt = Date.now();
            } else if (
              gameType === 'Bookmaker' ||
              gameType === 'Bookmaker IPL CUP'
            ) {
              if (bet.otype === 'back') {
                if (win) {
                  winAmount = bet.betAmount + bet.price;
                  bet.resultAmount = Math.abs(winAmount);
                  bet.profitLossChange = bet.betAmount;
                  bet.betResult = winner;
                  bet.settledBy = 'api';
                  bet.settledAt = Date.now();
                  bet.status = 1;
                } else {
                  bet.resultAmount = Math.abs(bet.price);
                  bet.profitLossChange = -bet.price;
                  bet.betResult = winner;
                  bet.settledBy = 'api';
                  bet.settledAt = Date.now();
                  bet.status = 2;
                }
              } else {
                // lay
                if (win) {
                  bet.resultAmount = Math.abs(bet.price);
                  bet.profitLossChange = -bet.price;
                  bet.betResult = winner;
                  bet.settledBy = 'api';
                  bet.settledAt = Date.now();
                  bet.status = 2;
                } else {
                  winAmount = bet.betAmount + bet.price;
                  bet.resultAmount = Math.abs(winAmount);
                  bet.profitLossChange = bet.betAmount;
                  bet.betResult = winner;
                  bet.settledBy = 'api';
                  bet.settledAt = Date.now();
                  bet.status = 1;
                }
              }
            } else if (gameType === 'Toss' || gameType === '1st 6 over') {
              if (win) {
                winAmount = bet.betAmount + bet.price;
                bet.resultAmount = Math.abs(winAmount);
                bet.profitLossChange = bet.betAmount;
                bet.betResult = winner;
                bet.settledBy = 'api';
                bet.settledAt = Date.now();
                bet.status = 1;
              } else {
                bet.betResult = winner;
                bet.settledBy = 'api';
                bet.settledAt = Date.now();
                bet.status = 2;
                bet.resultAmount = Math.abs(bet.price);
                bet.profitLossChange = -bet.price;
              }
            }

            await bet.save();
            totalBetsProcessed++;

            //  ADD THIS: WebSocket call for open bets update
            console.log(' [BET HISTORY] Bet settled, sending open bets update');
            // Send open bets update to trigger frontend refresh
            sendOpenBetsUpdates(bet.userId, null);
          }
        } catch (err) {
          console.error(
            `Error processing ${category} group ${groupKey}:`,
            err.message
          );
        }
      }
    }

    // Handle response differently for HTTP vs cron
    if (res && typeof res.status === 'function') {
      return res.status(200).json({
        message: 'All sports and casino bets processed successfully',
        total: totalBetsProcessed,
      });
    } else {
      return { success: true, total: totalBetsProcessed };
    }
  } catch (error) {
    console.error('Error in updateResultOfBets:', error);

    if (res && typeof res.status === 'function') {
      return res.status(500).json({ message: 'Server error' });
    } else {
      throw error; // Let the cron job handle the error
    }
  }
};
export const updateFancyBetHistory = async (req, res) => {
  try {
    const betTypes = [
      { gameType: 'Normal', marketName: 'Toss' },
      { gameType: 'meter', marketName: 'Match Odds' },
      { gameType: 'line', marketName: 'Tied Match' },
      { gameType: 'ball', marketName: 'Bookmaker' },
      { gameType: 'khado', marketName: 'Bookmaker' },
    ];

    let totalBetsProcessed = 0;

    for (const { gameType, marketName } of betTypes) {
      // CRITICAL FIX: Skip fancy  bets to prevent double settlement
      const bets = await betHistoryModel.find({
        status: 0,
        gameType,
        betType: { $in: ['fancy', 'sports'] },
      });

      if (!bets.length) {
        // console.log(`No ${gameType} bets found with status 0`);
        continue;
      }

      // Group bets by gameId
      const groupedBets = bets.reduce((acc, bet) => {
        if (!acc[bet.gameId]) acc[bet.gameId] = [];
        acc[bet.gameId].push(bet);
        return acc;
      }, {});

      for (const gameId of Object.keys(groupedBets)) {
        try {
          for (const bet of groupedBets[gameId]) {
            const sid = bet.sid;

            const resultData = await apiGetResult({
              event_id: Number(bet.gameId),
              event_name: bet.eventName,
              market_id: bet.market_id,
              market_name: toApiMarketName(bet.marketName),
              client_ref: null,
              sport_id: sid,
            });
            if (!resultData) {
              continue;
            }

            console.log('resultData', resultData);

            const fancyScore = bet.fancyScore;
            const score = resultData.final_result;

            const win = score && fancyScore && score >= fancyScore;
            console.log('winnn', win);

            const betTeam = bet.teamName?.trim();
            let winAmount = 0;

            // console.log("result responce", response)

            const user = await SubAdmin.findById(bet.userId);

            if (!user) {
              continue;
            }
            // Process bet based on otype
            if (bet.otype === 'back') {
              if (win) {
                winAmount = bet.betAmount + bet.price;
                bet.resultAmount = Math.abs(winAmount);
                bet.profitLossChange = bet.betAmount;
                bet.betResult = score;
                bet.status = 1; // Mark as won
              } else {
                bet.resultAmount = Math.abs(bet.price);
                bet.profitLossChange = -bet.price;
                bet.betResult = score;
                bet.status = 2; // Mark as lost
              }
            } else {
              if (win) {
                bet.resultAmount = Math.abs(bet.price);
                bet.profitLossChange = -bet.price;
                bet.betResult = score;
                bet.status = 2; // Mark as lost (for lay bets)
              } else {
                winAmount = bet.betAmount + bet.price;
                bet.resultAmount = Math.abs(winAmount);
                bet.profitLossChange = bet.betAmount;
                bet.betResult = score;
                bet.status = 1; // Mark as won (for lay bets)
              }
            }
            await user.save();
            await bet.save();
            totalBetsProcessed++;
          }
        } catch (err) {
          console.error('error in updatefancybethistory', err.message);
        }
      }
    }

    // Handle response differently for cron vs HTTP
    if (res && typeof res.status === 'function') {
      return res.status(200).json({
        message: 'All bets processed successfully',
        total: totalBetsProcessed,
      });
    } else {
      // console.log(`Cron job completed: Processed ${totalBetsProcessed} bets`);
      return { total: totalBetsProcessed };
    }
  } catch (error) {
    console.error('Error in updateFancyBetResult:', error);
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ message: 'Server error' });
    }
    throw error; // Let the cron job handle the error
  }
};

export const reconcileOrphanedBetHistory = async () => {
  const FANCY_GAME_TYPES = ['Normal', 'meter', 'line', 'ball', 'khado'];
  let totalReconciled = 0;

  try {
    // Only check bets settled in the last 24 hours (orphans older than this are rare)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const settledBets = await betModel.find({
      status: { $in: [1, 2, 3] },
      updatedAt: { $gte: oneDayAgo },
    });

    if (!settledBets.length) {
      return { success: true, total: 0 };
    }

    for (const bet of settledBets) {
      try {
        const betId = bet._id.toString();
        const betResult = (bet.betResult || '').trim();

        // Find orphaned betHistory records (status=0 means unsettled)
        const orphanedRecords = await betHistoryModel.find({
          betId: betId,
          status: 0,
        });

        if (!orphanedRecords.length) continue;

        console.log(
          `[RECONCILE] Found ${orphanedRecords.length} orphaned betHistory for betModel ${betId}`
        );

        const isFancy = FANCY_GAME_TYPES.includes(bet.gameType);
        const isVoid = bet.status === 3;
        const reconcileAt = new Date();
        const reconcileMs = reconcileAt.getTime();

        // Pre-compute per-row plans so we can stamp consistent
        // before/after balance audit fields across siblings.
        let totalReconcilePL = 0;
        const rowPlans = [];
        for (const historyRecord of orphanedRecords) {
          if (isVoid) {
            rowPlans.push({
              _id: historyRecord._id,
              isVoid: true,
              status: 3,
              resultAmount: Math.abs(historyRecord.price || 0),
              profitLossChange: 0,
              betResult: 'VOID',
              userId: historyRecord.userId,
            });
            continue;
          }

          let isWin;
          if (isFancy) {
            const actualScore = parseFloat(betResult || '0');
            const fancyScore = parseFloat(historyRecord.fancyScore || '0');
            isWin =
              historyRecord.otype === 'back'
                ? actualScore >= fancyScore
                : actualScore < fancyScore;
          } else {
            const historyTeam = (historyRecord.teamName || '').trim();
            const teamMatches =
              historyTeam &&
              betResult &&
              historyTeam.toLowerCase() === betResult.toLowerCase();
            isWin =
              historyRecord.otype === 'back' ? teamMatches : !teamMatches;
          }

          let historyStatus;
          let historyResultAmount;
          let historyProfitLossChange;
          if (isWin) {
            historyStatus = 1;
            historyResultAmount = Math.abs(historyRecord.betAmount || 0);
            historyProfitLossChange = historyRecord.betAmount || 0;
          } else {
            historyStatus = 2;
            historyResultAmount = Math.abs(historyRecord.price || 0);
            historyProfitLossChange = -(historyRecord.price || 0);
          }

          totalReconcilePL += historyProfitLossChange;
          rowPlans.push({
            _id: historyRecord._id,
            isVoid: false,
            status: historyStatus,
            resultAmount: historyResultAmount,
            profitLossChange: historyProfitLossChange,
            betResult: betResult,
            userId: historyRecord.userId,
            isWin,
          });
        }

        // Snapshot the user's CURRENT balance. The primary settlement
        // already moved the wallet (that's why we're only backfilling
        // history rows here), so the current balance already reflects
        // the aggregate impact. We synthesize a consistent
        // before/after pair: after = currentBalance, before =
        // currentBalance - totalReconcilePL. This keeps the audit math
        // (after - before == delta) consistent across sibling rows
        // even though we cannot reconstruct the actual historical
        // pre-settlement balance.
        let snapshotAfter = 0;
        try {
          const u = await SubAdmin.findById(bet.userId).select('balance');
          snapshotAfter = roundTo2(u?.balance || 0);
        } catch {
          snapshotAfter = 0;
        }
        const snapshotBefore = roundTo2(snapshotAfter - totalReconcilePL);
        const effectiveDelta = roundTo2(totalReconcilePL);

        // Atomic per-row writes with status=0 guard so we never
        // overwrite rows already settled by the primary path.
        for (const plan of rowPlans) {
          try {
            const setFields = {
              status: plan.status,
              resultAmount: plan.resultAmount,
              profitLossChange: plan.profitLossChange,
              betResult: plan.betResult,
              settledBy: 'api-reconcile',
              settledAt: reconcileAt,
              balanceBeforeSettlement: plan.isVoid
                ? snapshotAfter
                : snapshotBefore,
              balanceAfterSettlement: snapshotAfter,
              balanceDeltaApplied: plan.isVoid ? 0 : effectiveDelta,
              walletEntryRef: plan.isVoid
                ? `reconcile:void:${betId}:${plan._id}:${reconcileMs}`
                : `reconcile:settle:${betId}:${plan._id}:${reconcileMs}`,
            };
            const result = await betHistoryModel.updateOne(
              { _id: plan._id, status: 0 },
              { $set: setFields }
            );
            if (result.modifiedCount > 0) {
              totalReconciled++;
              if (plan.isVoid) {
                console.log(`  [RECONCILE] Voided: ${plan._id}`);
              } else {
                console.log(
                  `  [RECONCILE] Settled: ${plan._id} ` +
                    `Type:${isFancy ? 'FANCY' : 'SPORTS'} Won:${plan.isWin} ` +
                    `Status:${plan.status} P/L:${plan.profitLossChange}`
                );
              }
              sendOpenBetsUpdates(plan.userId, null);
            }
          } catch (recordErr) {
            console.error(
              `[RECONCILE] Error processing ${plan._id}:`,
              recordErr.message
            );
          }
        }
      } catch (betErr) {
        console.error(
          `[RECONCILE] Error processing bet ${bet._id}:`,
          betErr.message
        );
      }
    }

    if (totalReconciled > 0) {
      console.log(`[RECONCILE] Complete: reconciled=${totalReconciled}`);
    }

    return { success: true, total: totalReconciled };
  } catch (error) {
    console.error(
      '[RECONCILE] Error in reconcileOrphanedBetHistory:',
      error.message
    );
    return { success: false, error: error.message };
  }
};

/**
 * Backfill the balance audit fields (balanceBeforeSettlement,
 * balanceAfterSettlement, balanceDeltaApplied, walletEntryRef) on
 * already-settled betHistory rows that were settled before the atomic
 * single-write change went live. Safe to run repeatedly: only touches
 * rows where audit fields are missing.
 *
 * Optional query params:
 *   - userId:  limit to one user's history rows
 *   - betId:   limit to history rows under one parent bet
 *   - sinceDays: how far back to scan (default 7; max 90)
 *   - dryRun:  if 'true', report what would change without writing
 */
export const backfillBetHistoryAuditFields = async (req, res) => {
  try {
    const { userId, betId, sinceDays, dryRun } = req.query || {};
    const sinceDaysNum = Math.min(
      Math.max(parseInt(sinceDays || '7', 10) || 7, 1),
      90
    );
    const since = new Date(Date.now() - sinceDaysNum * 24 * 60 * 60 * 1000);
    const isDryRun = String(dryRun || '').toLowerCase() === 'true';

    // Find rows that are settled (status 1/2/3) but missing the audit fields.
    const baseFilter = {
      status: { $in: [1, 2, 3] },
      updatedAt: { $gte: since },
      $or: [
        { balanceBeforeSettlement: { $exists: false } },
        { balanceAfterSettlement: { $exists: false } },
        { walletEntryRef: { $exists: false } },
      ],
    };
    if (userId) baseFilter.userId = userId;
    if (betId) baseFilter.betId = betId;

    const orphans = await betHistoryModel.find(baseFilter).lean();
    if (!orphans.length) {
      return res.status(200).json({
        success: true,
        scanned: 0,
        updated: 0,
        message: 'No rows missing audit fields in scan window',
      });
    }

    // Group siblings by parent betId so before/after stay consistent
    // across rows that were settled together.
    const groups = new Map();
    for (const r of orphans) {
      const key = r.betId || String(r._id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    let updated = 0;
    const dryReport = [];

    for (const [betIdKey, siblings] of groups.entries()) {
      const totalPL = siblings.reduce(
        (acc, r) => acc + (Number(r.profitLossChange) || 0),
        0
      );
      const sampleUserId = siblings[0].userId;

      // Snapshot current balance to derive a consistent before/after
      // pair (wallet movement already happened earlier).
      let snapshotAfter = 0;
      try {
        const u = await SubAdmin.findById(sampleUserId).select('balance');
        snapshotAfter = roundTo2(u?.balance || 0);
      } catch {
        snapshotAfter = 0;
      }
      const snapshotBefore = roundTo2(snapshotAfter - totalPL);
      const effectiveDelta = roundTo2(totalPL);
      const stampMs = Date.now();

      for (const r of siblings) {
        const isVoid = r.status === 3;
        const setFields = {
          balanceBeforeSettlement: isVoid ? snapshotAfter : snapshotBefore,
          balanceAfterSettlement: snapshotAfter,
          balanceDeltaApplied: isVoid ? 0 : effectiveDelta,
          walletEntryRef:
            r.walletEntryRef ||
            `backfill:${isVoid ? 'void' : 'settle'}:${betIdKey}:${r._id}:${stampMs}`,
        };

        if (isDryRun) {
          dryReport.push({
            _id: String(r._id),
            betId: betIdKey,
            userId: String(sampleUserId),
            currentBalance: snapshotAfter,
            wouldSet: setFields,
          });
          continue;
        }

        try {
          const result = await betHistoryModel.updateOne(
            { _id: r._id },
            { $set: setFields }
          );
          if (result.modifiedCount > 0) updated++;
        } catch (err) {
          console.error(
            `[BACKFILL] Failed for history row ${r._id}:`,
            err.message
          );
        }
      }
    }

    return res.status(200).json({
      success: true,
      scanned: orphans.length,
      updated: isDryRun ? 0 : updated,
      dryRun: isDryRun,
      ...(isDryRun ? { sample: dryReport.slice(0, 50) } : {}),
    });
  } catch (error) {
    console.error('[BACKFILL] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Backfill failed',
      error: error.message,
    });
  }
};

export const getPendingBets = async (req, res) => {
  const { id } = req;
  let { gameId } = req.query;

  try {
    const query = {
      userId: id,
      status: 0,
    };
    if (gameId && gameId !== 'undefined') {
      query.gameId = gameId;
    }
    const bets = await betHistoryModel.find(query).sort({ createdAt: -1 });

    return res.status(200).json({ data: bets });
  } catch (error) {
    console.error('Error fetching bets:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};

export const getPendingBetsAmounts = async (req, res) => {
  const { id } = req;
  const { gameId, roundId } = req.query;

  try {
    const betTypes = [
      { gameType: 'Toss', marketName: 'Toss', category: 'sports' },
      { gameType: 'Match Odds', marketName: 'Match Odds', category: 'sports' },
      { gameType: 'fancy1', marketName: 'fancy1', category: 'sports' },
      { gameType: 'oddeven', marketName: 'oddeven', category: 'sports' },
      { gameType: 'Tied Match', marketName: 'Tied Match', category: 'sports' },
      { gameType: 'Bookmaker', marketName: 'Bookmaker', category: 'sports' },
      { gameType: 'Normal', marketName: 'Toss', category: 'sports' },
      { gameType: 'meter', marketName: 'Match Odds', category: 'sports' },
      { gameType: 'line', marketName: 'Tied Match', category: 'sports' },
      { gameType: 'ball', marketName: 'Bookmaker', category: 'sports' },
      { gameType: 'khado', marketName: 'Bookmaker', category: 'sports' },
      { gameType: 'Winner', marketName: 'Winner', category: 'sports' },
      {
        gameType: '1st 6 over',
        marketName: '1st 6 over',
        category: 'sports',
      },
      {
        gameType: 'OVER_UNDER_05',
        marketName: 'OVER_UNDER_05',
        category: 'sports',
      },
      {
        gameType: 'OVER_UNDER_15',
        marketName: 'OVER_UNDER_15',
        category: 'sports',
      },
      {
        gameType: 'OVER_UNDER_25',
        marketName: 'OVER_UNDER_25',
        category: 'sports',
      },

      //Category fo Casino
      { gameType: 'casino', marketName: 'WINNER', category: 'casino' },
    ];

    const validGameTypes = betTypes.map((bt) => bt.gameType);
    // console.log("The validGameTypes are", validGameTypes);

    const casinoFilter = roundId
      ? { betType: 'casino', roundId: String(roundId) }
      : { betType: 'casino' };

    const bets = await betModel
      .find({
        userId: id,
        status: 0,
        gameId,
        $or: [
          { gameType: { $in: validGameTypes } }, // Sports bets
          casinoFilter, // All casino bets
        ],
      })
      .sort({ createdAt: -1 });

    // Separate cashed-out bets from active bets
    const activeBets = bets.filter((b) => !b.isCashedOut);
    const cashedOutBets = bets.filter((b) => b.isCashedOut);

    // Group cashout P/L by gameType so each market only sees its own cashout values
    const cashoutPLByGameType = {};
    for (const b of cashedOutBets) {
      const gt = b.gameType;
      if (!cashoutPLByGameType[gt]) cashoutPLByGameType[gt] = 0;
      cashoutPLByGameType[gt] += b.cashoutValue || 0;
    }

    // Group active bets by gameType + teamName (+ marketName for oddeven,
    // since the same teamName "Odd"/"Even" recurs across propositions).
    const grouped = {};

    const perTeamActiveBets = activeBets.filter((b) =>
      PER_TEAM_MARKET_TYPES.includes(b.gameType)
    );
    const otherActiveBets = activeBets.filter(
      (b) => !PER_TEAM_MARKET_TYPES.includes(b.gameType)
    );

    const addToGrouped = (bet, betAmount, price) => {
      const key =
        bet.gameType === 'oddeven'
          ? `${bet.gameType}|${bet.marketName}|${bet.teamName}|${bet.otype}`
          : PER_TEAM_MARKET_TYPES.includes(bet.gameType)
            ? `${bet.gameType}|${bet.teamName}|${bet.otype}`
            : `${bet.gameType}|${bet.teamName}`;
      if (!grouped[key]) {
        grouped[key] = {
          gameType: bet.gameType,
          marketName: bet.marketName,
          teamName: bet.teamName,
          otype: bet.otype,
          totalBetAmount: 0,
          totalPrice: 0,
          subtype: bet.subtype,
        };
      }

      grouped[key].totalBetAmount += Number(betAmount);
      grouped[key].totalPrice += Number(price);

      if (FANCY_GAME_TYPES.includes(bet.gameType)) {
        if (!grouped[key].fancyBets) grouped[key].fancyBets = [];
        grouped[key].fancyBets.push({
          fancyScore: bet.fancyScore,
          otype: bet.otype,
          betAmount: Number(betAmount),
          price: Number(price),
          subtype: bet.subtype,
        });
      }
    };

    for (const bet of otherActiveBets) {
      addToGrouped(bet, bet.betAmount, bet.price);
    }

    // Per-team markets: use bet history rows so cross-team hedges are not lost
    // when legacy merged betModel records exist.
    if (gameId && perTeamActiveBets.length > 0) {
      const historyEntries = await betHistoryModel
        .find({
          userId: id,
          gameId,
          gameType: { $in: PER_TEAM_MARKET_TYPES },
          status: 0,
        })
        .sort({ createdAt: 1 });

      if (historyEntries.length > 0) {
        for (const entry of historyEntries) {
          addToGrouped(entry, entry.betAmount, entry.price);
        }
      } else {
        for (const bet of perTeamActiveBets) {
          addToGrouped(bet, bet.betAmount, bet.price);
        }
      }
    }

    const result = Object.values(grouped);
    return res.status(200).json({
      success: true,
      data: result,
      cashoutPL: cashoutPLByGameType,
    });
  } catch (error) {
    console.error('Error fetching bets:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};

export const getFancyMasterBook = async (req, res) => {
  const { id } = req;
  const { gameId, teamName, gameType, minScore, maxScore } = req.query;

  try {
    if (!gameId || !teamName || !gameType) {
      return res.status(400).json({
        success: false,
        message: 'gameId, teamName, and gameType are required',
      });
    }

    if (!FANCY_GAME_TYPES.includes(gameType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid fancy gameType: ${gameType}`,
      });
    }

    // Fetch pending bets for this specific fancy market
    // Same query pattern as placeFancyBet (betController.js:1237-1243)
    const bets = await betModel.find({
      userId: id,
      gameId,
      teamName,
      gameType,
      status: 0,
      isCashedOut: { $ne: true },
    });

    if (!bets || bets.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        meta: { gameId, teamName, gameType, totalBets: 0 },
      });
    }

    // Extract the fields needed for ladder calculation
    const fancyBets = bets.map((bet) => ({
      fancyScore: bet.fancyScore,
      otype: bet.otype,
      price: Number(bet.price),
      betAmount: Number(bet.betAmount),
    }));

    // Pass null to let the utility auto-detect range from bet lines,
    // or use explicit values if provided in query params
    const parsedMin = minScore != null ? parseInt(minScore, 10) : null;
    const parsedMax = maxScore != null ? parseInt(maxScore, 10) : null;

    const ladder = generateFancyLadder(fancyBets, parsedMin, parsedMax);

    return res.status(200).json({
      success: true,
      data: ladder,
      meta: {
        gameId,
        teamName,
        gameType,
        totalBets: bets.length,
      },
    });
  } catch (error) {
    console.error('Error generating fancy master book:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// export const getBetHistory = async (req, res) => {
//   const { id } = req;
//   const {
//     page = 1,
//     limit = 10,
//     startDate,
//     endDate,
//     selectedGame,
//     selectedVoid,
//   } = req.query;

//   try {
//     const query = { userId: id, status: 0 };

//     // Filter by date if both start and end dates are provided
//     if (startDate && endDate) {
//       query.createdAt = getDateRangeUTC(startDate, endDate);
//     }

//     // Filter by selectedGame if provided
//     if (selectedGame) {
//       query.gameName = selectedGame;
//     }

//     // Filter by selectedVoid if provided
//     if (selectedVoid === 'settel') {
//       query.status = { $ne: 0 };
//       query.betResult = { $not: { $regex: /^VOID$/i } };
//     } else if (selectedVoid === 'void') {
//       query.status = 2;
//       query.betResult = { $regex: /^VOID$/i };
//     } else if (selectedVoid === 'unsettel') {
//       query.status = 0;
//     }

//     const bets = await betHistoryModel
//       .find(query)
//       .sort({ date: -1 }) // most recent first
//       .skip((page - 1) * limit)
//       .limit(parseInt(limit));

//     const total = await betHistoryModel.countDocuments(query);

//     res.status(200).json({
//       success: true,
//       data: bets,
//       pagination: {
//         total,
//         page: parseInt(page),
//         pages: Math.ceil(total / limit),
//       },
//     });
//   } catch (error) {
//     console.error('Error fetching bet history:', error);
//     res.status(500).json({ message: 'Server error' });
//   }
// };

// export const getProfitlossHistory = async (req, res) => {
//   const { id } = req; // User ID from auth middleware
//   const {
//     startDate,
//     endDate,
//     page = 1,
//     limit = 10,
//     eventName,
//     gameName,
//     marketName,
//     marketId,
//   } = req.query;

//   try {
//     const pageNum = Math.max(parseInt(page), 1);
//     const limitNum = Math.max(parseInt(limit), 1);
//     const skip = (pageNum - 1) * limitNum;

//     const betQuery = {
//       userId: id,
//       status: { $in: [1, 2] },
//     };

//     if (startDate && endDate) {
//       betQuery.date = getDateRangeUTC(startDate, endDate);
//     }

//     // Apply filters if provided
//     if (gameName) betQuery.gameName = gameName;
//     if (eventName) betQuery.eventName = eventName;
//     if (marketName) betQuery.marketName = marketName;
//     if (marketId) {
//       betQuery.market_id = { $regex: `${marketId}$` };
//     }
//     const fullFilterMode = gameName && eventName && marketName;

//     const bets = await betHistoryModel.find(betQuery);

//     if (fullFilterMode) {
//       const betsWithMarketId = bets.map((bet) => ({
//         ...bet.toObject(),
//         marketId: bet.market_id ? bet.market_id.match(/\d+/g)?.pop() : null,
//       }));
//       return res.status(200).json({
//         success: true,
//         data: {
//           report: betsWithMarketId,
//           total: {
//             totalBets: bets.length,
//             totalWinAmount: bets
//               .filter((b) => b.status === 1)
//               .reduce((sum, b) => sum + (b.resultAmount || 0), 0),
//             totalLossAmount: bets
//               .filter((b) => b.status === 2)
//               .reduce((sum, b) => sum + (b.resultAmount || 0), 0),
//           },
//         },
//       });
//     }

//     // 7. Existing grouping logic for partial filters
//     let groupKey = 'gameName';
//     if (gameName && !eventName && !marketName) {
//       groupKey = 'eventName';
//     } else if (gameName && eventName && !marketName) {
//       groupKey = 'marketName';
//     } else if (eventName && !gameName && !marketName) {
//       groupKey = 'marketName';
//     }

//     const reportMap = {};

//     const processedRounds = new Set();

//     for (const bet of bets) {
//       // const key = bet[groupKey]?.trim() || "Unknown";
//       let key;
//       if (eventName && !gameName && !marketName) {
//         // For EventMatches page, show individual markets
//         key =
//           `${bet.marketName}_${bet.market_id || bet._id}`.trim() || 'Unknown';
//       } else {
//         // Use existing logic for other cases
//         key = bet[groupKey]?.trim() || 'Unknown';
//       }

//       // const key = bet[groupKey]?.trim() || "Unknown";

//       if (!reportMap[key]) {
//         reportMap[key] = {
//           name: key,
//           eventName: bet.eventName,
//           gameName: bet.gameName,
//           marketName: bet.marketName,
//           marketId: bet.market_id ? bet.market_id.match(/\d+/g)?.pop() : null,
//           result: bet.betResult,
//           userName: bet.userName,
//           date: bet.createdAt,
//           WinAmount: 0,
//           LossAmount: 0,
//           myProfit: 0,
//         };
//       }

//       // Handle casino bets with round-based grouping
//       if (bet.betType === 'casino') {
//         const roundKey = `${bet.userId}_${bet.roundId}_${bet.gameId}_${key}`;

//         if (!processedRounds.has(roundKey)) {
//           processedRounds.add(roundKey);

//           // Get all bets for this round
//           const roundBets = bets.filter(
//             (b) =>
//               b.roundId === bet.roundId &&
//               b.gameId === bet.gameId &&
//               b.userId === bet.userId
//           );

//           // Calculate net result
//           let netWin = 0;
//           let netLoss = 0;

//           for (const roundBet of roundBets) {
//             const rplChange = roundBet.profitLossChange || 0;
//             if (rplChange > 0) {
//               netWin += rplChange;
//             } else if (rplChange < 0) {
//               netLoss += Math.abs(rplChange);
//             }
//           }

//           const netResult = netWin - netLoss;

//           if (netResult > 0) {
//             reportMap[key].WinAmount += netResult;
//           } else if (netResult < 0) {
//             reportMap[key].LossAmount += Math.abs(netResult);
//           }
//         }
//       } else {
//         // Normal bets - existing logic
//         const plChange = bet.profitLossChange || 0;
//         if (plChange > 0) {
//           reportMap[key].WinAmount += plChange;
//         } else if (plChange < 0) {
//           reportMap[key].LossAmount += Math.abs(plChange);
//         }
//       }
//       // Calculate individual profit for this bet entry
//       reportMap[key].myProfit =
//         reportMap[key].WinAmount - reportMap[key].LossAmount;
//     }

//     // 4. Get paginated bets and totals in parallel
//     const reportArray = Object.values(reportMap);
//     const total = reportArray.reduce(
//       (acc, curr) => ({
//         name: 'Total',
//         WinAmount: acc.WinAmount + curr.WinAmount,
//         LossAmount: acc.LossAmount + curr.LossAmount,
//         myProfit: acc.myProfit + curr.myProfit,
//       }),
//       { name: 'Total', WinAmount: 0, LossAmount: 0, myProfit: 0 }
//     );

//     console.log('reportArray', reportArray);

//     return res.status(200).json({
//       success: true,
//       data: {
//         report: reportArray,
//         total,
//       },
//     });
//   } catch (error) {
//     console.error('getMyReportByEvents error:', error);
//     return res.status(500).json({
//       success: false,
//       message: error.message,
//     });
//   }
// };

export const getBetHistory = async (req, res) => {
  const { id } = req;
  const {
    page = 1,
    limit = 10,
    startDate,
    endDate,
    selectedGame,
    selectedVoid,
  } = req.query;

  try {
    const query = { userId: id, status: 0 };

    // Filter by date if both start and end dates are provided
    if (startDate && endDate) {
      query.createdAt = getDateRangeUTC(startDate, endDate);
    }

    // Filter by selectedGame if provided
    if (selectedGame) {
      // Account Statement sends "Sport" to represent all sports.
      if (selectedGame === 'Sport') {
        query.gameName = {
          $in: ['Cricket Game', 'Soccer Game', 'Tennis Game'],
        };
      } else {
        query.gameName = selectedGame;
      }
    }

    // Filter by selectedVoid if provided
    if (selectedVoid === 'settel') {
      query.status = { $ne: 0 };
      query.betResult = { $not: { $regex: /^VOID$/i } };
    } else if (selectedVoid === 'void') {
      query.status = 3;
      query.betResult = { $regex: /^VOID$/i };
    } else if (selectedVoid === 'unsettel') {
      query.status = 0;
    }

    const bets = await betHistoryModel
      .find(query)
      // Show statement rows in settlement order first to match before/after balances.
      .sort({ settledAt: -1, date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await betHistoryModel.countDocuments(query);

    res.status(200).json({
      success: true,
      data: bets,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching bet history:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
export const getProfitlossHistory = async (req, res) => {
  const { id } = req; // User ID from auth middleware
  const {
    startDate,
    endDate,
    page = 1,
    limit = 10,
    eventName,
    gameName,
    marketName,
    marketId,
  } = req.query;

  try {
    const pageNum = Math.max(parseInt(page), 1);
    const limitNum = Math.max(parseInt(limit), 1);
    const skip = (pageNum - 1) * limitNum;

    const betQuery = {
      userId: id,
      status: { $in: [1, 2] },
    };

    if (startDate && endDate) {
      betQuery.date = getDateRangeUTC(startDate, endDate);
    }

    // Apply filters if provided
    if (gameName) betQuery.gameName = gameName;
    if (eventName) betQuery.eventName = eventName;
    if (marketName) betQuery.marketName = marketName;
    if (marketId) {
      betQuery.market_id = { $regex: `${marketId}$` };
    }
    const fullFilterMode = gameName && eventName && marketName;

    const bets = await betHistoryModel.find(betQuery);

    if (fullFilterMode) {
      const betsWithMarketId = bets.map((bet) => ({
        ...bet.toObject(),
        marketId: bet.market_id ? bet.market_id.match(/\d+/g)?.pop() : null,
      }));
      return res.status(200).json({
        success: true,
        data: {
          report: betsWithMarketId,
          total: {
            totalBets: bets.length,
            totalWinAmount: bets
              .filter((b) => b.status === 1)
              .reduce((sum, b) => sum + (b.resultAmount || 0), 0),
            totalLossAmount: bets
              .filter((b) => b.status === 2)
              .reduce((sum, b) => sum + (b.resultAmount || 0), 0),
          },
        },
      });
    }

    // 7. Existing grouping logic for partial filters
    let groupKey = 'gameName';
    if (gameName && !eventName && !marketName) {
      groupKey = 'eventName';
    } else if (gameName && eventName && !marketName) {
      groupKey = 'marketName';
    } else if (eventName && !gameName && !marketName) {
      groupKey = 'marketName';
    }

    const reportMap = {};

    const processedRounds = new Set();

    for (const bet of bets) {
      // const key = bet[groupKey]?.trim() || "Unknown";
      let key;
      if (eventName && !gameName && !marketName) {
        // For EventMatches page, show individual markets
        key =
          `${bet.marketName}_${bet.market_id || bet._id}`.trim() || 'Unknown';
      } else {
        // Use existing logic for other cases
        key = bet[groupKey]?.trim() || 'Unknown';
      }

      // const key = bet[groupKey]?.trim() || "Unknown";

      if (!reportMap[key]) {
        reportMap[key] = {
          name: key,
          eventName: bet.eventName,
          gameName: bet.gameName,
          marketName: bet.marketName,
          marketId: bet.market_id ? bet.market_id.match(/\d+/g)?.pop() : null,
          result: bet.betResult,
          userName: bet.userName,
          date: bet.createdAt,
          WinAmount: 0,
          LossAmount: 0,
          myProfit: 0,
        };
      }

      // Handle casino bets with round-based grouping
      if (bet.betType === 'casino') {
        const roundKey = `${bet.userId}_${bet.roundId}_${bet.gameId}_${key}`;

        if (!processedRounds.has(roundKey)) {
          processedRounds.add(roundKey);

          // Get all bets for this round
          const roundBets = bets.filter(
            (b) =>
              b.roundId === bet.roundId &&
              b.gameId === bet.gameId &&
              b.userId === bet.userId
          );

          // Calculate net result
          let netWin = 0;
          let netLoss = 0;

          for (const roundBet of roundBets) {
            const rplChange = roundBet.profitLossChange || 0;
            if (rplChange > 0) {
              netWin += rplChange;
            } else if (rplChange < 0) {
              netLoss += Math.abs(rplChange);
            }
          }

          const netResult = netWin - netLoss;

          if (netResult > 0) {
            reportMap[key].WinAmount += netResult;
          } else if (netResult < 0) {
            reportMap[key].LossAmount += Math.abs(netResult);
          }
        }
      } else {
        // Normal bets - existing logic
        const plChange = bet.profitLossChange || 0;
        if (plChange > 0) {
          reportMap[key].WinAmount += plChange;
        } else if (plChange < 0) {
          reportMap[key].LossAmount += Math.abs(plChange);
        }
      }
      // Calculate individual profit for this bet entry
      reportMap[key].myProfit =
        reportMap[key].WinAmount - reportMap[key].LossAmount;
    }

    // 4. Get paginated bets and totals in parallel
    const reportArray = Object.values(reportMap);
    const total = reportArray.reduce(
      (acc, curr) => ({
        name: 'Total',
        WinAmount: acc.WinAmount + curr.WinAmount,
        LossAmount: acc.LossAmount + curr.LossAmount,
        myProfit: acc.myProfit + curr.myProfit,
      }),
      { name: 'Total', WinAmount: 0, LossAmount: 0, myProfit: 0 }
    );

    console.log('reportArray', reportArray);

    return res.status(200).json({
      success: true,
      data: {
        report: reportArray,
        total,
      },
    });
  } catch (error) {
    console.error('getMyReportByEvents error:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
export const getTransactionHistoryByUserAndDate = async (req, res) => {
  try {
    const { id } = req;
    const { startDate, endDate, page, limit } = req.query;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
      });
    }

    const filter = {
      userId: id,
    };

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);

      end.setDate(end.getDate() + 1);

      filter.createdAt = {
        $gte: start,
        $lte: end,
      };
    }

    const user = await SubAdmin.findById(id, { userName: 1 }).lean();
    const currentUserName = user?.userName;

    const transactions = await TransactionHistory.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    // Privacy: hide master/upline name from client users
    const maskedTransactions = transactions.map((txn) => {
      const masked = { ...txn };
      if (masked.to === currentUserName && masked.from !== currentUserName) {
        masked.from = 'Upline';
      }
      return masked;
    });

    console.log('Found transactions:', maskedTransactions.length);

    return res.status(200).json({
      success: true,
      data: maskedTransactions,
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};
