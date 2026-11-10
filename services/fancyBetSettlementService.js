/**
 * Fancy Bet Settlement Service
 * Complete settlement with WebSocket updates, upline updates, and history tracking
 * Handles fancy/score-based bets: Normal, meter, line, ball, khado
 *
 * See: BETTING_SETTLEMENT_LOGIC.md for detailed rules
 */

import { updateAllUplines } from '../controllers/admin/subAdminController.js';
import betHistoryModel from '../models/betHistoryModel.js';
import {
  sendBalanceUpdates,
  sendExposureUpdates,
  sendOpenBetsUpdates,
} from '../socket/bettingSocket.js';
import { calculateAllExposure } from '../utils/exposureUtils.js';

/**
 * Settle a single fancy bet (score-based)
 * @param {Object} bet - Bet document
 * @param {Object} user - User document
 * @param {String|Number} actualScore - Actual final score
 * @returns {Object} { success, betUpdates, userUpdates }
 */
async function settleFancyBet(bet, user, actualScore) {
  try {
    const fancyScore = parseFloat(bet.fancyScore);
    const score = parseFloat(actualScore);

    if (isNaN(fancyScore) || isNaN(score)) {
      return {
        success: false,
        message: `Invalid fancy score: fancyScore=${bet.fancyScore}, actualScore=${actualScore}`,
      };
    }

    // Determine win: back wins if score >= fancyScore, lay wins if score < fancyScore
    const isWin =
      bet.otype === 'back' ? score >= fancyScore : score < fancyScore;

    let balanceChange = 0;
    let avBalanceChange = 0;
    let profitLossChange = 0;
    let resultAmount = 0;
    let status = 0;

    // Same offset/normal logic as sports bets
    if (isWin) {
      if (bet.betAmount < 0) {
        // Offset bet wins (loss scenario)
        balanceChange = bet.betAmount;
        avBalanceChange = 0;
        profitLossChange = bet.betAmount;
        resultAmount = Math.abs(bet.betAmount);
        status = 2; // LOSS
      } else {
        // Normal bet wins
        const winAmount = bet.betAmount + bet.price;
        balanceChange = bet.betAmount;
        avBalanceChange = winAmount;
        profitLossChange = bet.betAmount;
        resultAmount = Math.abs(bet.betAmount);
        status = 1; // WIN
      }
    } else {
      if (bet.betAmount < 0) {
        // Offset bet loses (break even)
        balanceChange = 0;
        avBalanceChange = -bet.betAmount;
        profitLossChange = 0;
        resultAmount = 0;
        status = 1; // WIN (break even)
      } else {
        // Normal bet loses
        balanceChange = -bet.price;
        avBalanceChange = -bet.price;
        profitLossChange = -bet.price;
        resultAmount = Math.abs(bet.price);
        status = 2; // LOSS
      }
    }

    // NOTE: User updates are applied via atomic $inc in the controller, not here
    // This prevents lost updates from concurrent cron jobs

    return {
      success: true,
      betUpdates: {
        status,
        resultAmount,
        profitLossChange,
        betResult: score.toString(),
        settledBy: 'api',
        settledAt: new Date(),
      },
      userUpdates: {
        balanceChange,
        avBalanceChange,
        profitLossChange,
      },
    };
  } catch (error) {
    console.error(`Error settling fancy bet ${bet._id}:`, error);
    return {
      success: false,
      message: error.message,
    };
  }
}

export function normalizeFancy1Result(rawResult) {
  const normalized = String(rawResult).trim().toLowerCase();

  if (['1', 'yes', 'y', 'true'].includes(normalized)) return '1';
  if (['0', 'no', 'n', 'false'].includes(normalized)) return '0';

  return null;
}

async function settleFancy1Bet(bet, user, rawResult) {
  try {
    const normalized = normalizeFancy1Result(rawResult);
    if (!normalized) {
      return {
        success: false,
        message: `Invalid fancy1 result: ${rawResult}`,
      };
    }

    const yesHappened = normalized === '1';
    const isWin = bet.otype === 'back' ? yesHappened : !yesHappened;

    let balanceChange = 0;
    let avBalanceChange = 0;
    let profitLossChange = 0;
    let resultAmount = 0;
    let status = 0;

    if (isWin) {
      if (bet.betAmount < 0) {
        balanceChange = bet.betAmount;
        avBalanceChange = 0;
        profitLossChange = bet.betAmount;
        resultAmount = Math.abs(bet.betAmount);
        status = 2;
      } else {
        const winAmount = bet.betAmount + bet.price;
        balanceChange = bet.betAmount;
        avBalanceChange = winAmount;
        profitLossChange = bet.betAmount;
        resultAmount = Math.abs(bet.betAmount);
        status = 1;
      }
    } else {
      if (bet.betAmount < 0) {
        balanceChange = 0;
        avBalanceChange = -bet.betAmount;
        profitLossChange = 0;
        resultAmount = 0;
        status = 1;
      } else {
        balanceChange = -bet.price;
        avBalanceChange = -bet.price;
        profitLossChange = -bet.price;
        resultAmount = Math.abs(bet.price);
        status = 2;
      }
    }

    return {
      success: true,
      betUpdates: {
        status,
        resultAmount,
        profitLossChange,
        betResult: normalized,
        settledBy: 'api',
        settledAt: new Date(),
      },
      userUpdates: {
        balanceChange,
        avBalanceChange,
        profitLossChange,
      },
    };
  } catch (error) {
    console.error(`Error settling fancy1 bet ${bet._id}:`, error);
    return {
      success: false,
      message: error.message,
    };
  }
}

/** Parse manual/API result into winning side for oddeven markets. */
export function normalizeOddEvenResult(rawResult) {
  const normalized = String(rawResult).trim().toLowerCase();

  if (['odd', 'odds'].includes(normalized)) {
    return { winningSide: 'odd', betResult: 'odd' };
  }
  if (['even', 'evens'].includes(normalized)) {
    return { winningSide: 'even', betResult: 'even' };
  }

  const n = parseInt(normalized, 10);
  if (Number.isFinite(n)) {
    const winningSide = n % 2 === 0 ? 'even' : 'odd';
    return { winningSide, betResult: winningSide, sourceScore: n };
  }

  return null;
}

export function isOddEvenHistoryWin(historyRecord, betResult) {
  const winningSide = (betResult || '').trim().toLowerCase();
  const historySide = (historyRecord.teamName || '').trim().toLowerCase();
  return Boolean(winningSide && historySide && historySide === winningSide);
}

async function settleOddEvenBet(bet, user, rawResult) {
  try {
    const parsed = normalizeOddEvenResult(rawResult);
    if (!parsed) {
      return {
        success: false,
        message: `Invalid oddeven result: ${rawResult} (use odd, even, or a numeric score)`,
      };
    }

    const { winningSide, betResult } = parsed;
    const betSide = (bet.teamName || '').trim().toLowerCase();
    const isWin = betSide === winningSide;

    let balanceChange = 0;
    let avBalanceChange = 0;
    let profitLossChange = 0;
    let resultAmount = 0;
    let status = 0;

    if (isWin) {
      if (bet.betAmount < 0) {
        balanceChange = bet.betAmount;
        avBalanceChange = 0;
        profitLossChange = bet.betAmount;
        resultAmount = Math.abs(bet.betAmount);
        status = 2;
      } else {
        const winAmount = bet.betAmount + bet.price;
        balanceChange = bet.betAmount;
        avBalanceChange = winAmount;
        profitLossChange = bet.betAmount;
        resultAmount = Math.abs(bet.betAmount);
        status = 1;
      }
    } else {
      if (bet.betAmount < 0) {
        balanceChange = 0;
        avBalanceChange = -bet.betAmount;
        profitLossChange = 0;
        resultAmount = 0;
        status = 1;
      } else {
        balanceChange = -bet.price;
        avBalanceChange = -bet.price;
        profitLossChange = -bet.price;
        resultAmount = Math.abs(bet.price);
        status = 2;
      }
    }

    return {
      success: true,
      betUpdates: {
        status,
        resultAmount,
        profitLossChange,
        betResult,
        settledBy: 'api',
        settledAt: new Date(),
      },
      userUpdates: {
        balanceChange,
        avBalanceChange,
        profitLossChange,
      },
    };
  } catch (error) {
    console.error(`Error settling oddeven bet ${bet._id}:`, error);
    return {
      success: false,
      message: error.message,
    };
  }
}

async function voidFancyBet(bet) {
  try {
    return {
      success: true,
      betUpdates: {
        status: 3, // VOID
        resultAmount: Math.abs(bet.price), // Show refunded amount
        profitLossChange: 0,
        betResult: 'VOID',
        settledBy: 'api',
        settledAt: new Date(),
      },
    };
  } catch (error) {
    console.error(`Error voiding fancy bet ${bet._id}:`, error);
    return {
      success: false,
      message: error.message,
    };
  }
}

//Calculate exposure from pending bets using market-based scenario analysis
function calculateExposure(pendingBets) {
  return calculateAllExposure(pendingBets);
}

function recalculateAvbalance(user, exposure) {
  user.avbalance = user.balance - exposure;
}

async function sendSettlementUpdates(
  userId,
  user,
  newExposure,
  gameId,
  resultData
) {
  try {
    // Recalculate avbalance based on new exposure
    recalculateAvbalance(user, newExposure);

    // Send WebSocket updates to user
    sendBalanceUpdates(userId, user.avbalance);
    sendExposureUpdates(userId, newExposure);
    sendOpenBetsUpdates(userId, null);

    console.log(
      ` [FANCY] WebSocket updates sent: balance=${user.avbalance}, exposure=${newExposure}`
    );
  } catch (error) {
    console.error(
      ` Error sending settlement updates for user ${userId}:`,
      error.message
    );
  }
}

async function propagateUplineUpdates(userIds) {
  try {
    await updateAllUplines(userIds);
    console.log(` [FANCY] Updated uplines for ${userIds.length} users`);
  } catch (error) {
    console.error(` Error updating uplines:`, error.message);
  }
}

async function recordBetHistory(
  gameId,
  finalScore,
  gameData,
  betsCount,
  stats
) {
  try {
    await betHistoryModel.create({
      gameId,
      final_result: finalScore,
      eventName: gameData.eventName,
      marketName: gameData.marketName,
      gameType: gameData.gameType || 'fancy',
      gameName: gameData.gameName,
      sport_id: gameData.sport_id,
      betsSettled: betsCount,
      totalAmount: (stats?.totalPaidOut || 0) + (stats?.totalCollected || 0),
      settledBy: 'api',
      settlementDate: new Date(),
    });

    console.log(` [FANCY] Bet history recorded for game ${gameId}`);
  } catch (error) {
    console.error(`Error recording bet history:`, error.message);
  }
}

/** Whether a betHistory row won for a settled fancy1 parent (yes/no result). */
export function isFancy1HistoryWin(historyRecord, betResult) {
  const normalized = normalizeFancy1Result(betResult);
  if (!normalized) return false;
  const yesHappened = normalized === '1';
  return historyRecord.otype === 'back' ? yesHappened : !yesHappened;
}

export {
  calculateExposure,
  propagateUplineUpdates,
  recalculateAvbalance,
  recordBetHistory,
  sendSettlementUpdates,
  settleFancy1Bet,
  settleFancyBet,
  settleOddEvenBet,
  voidFancyBet,
};
