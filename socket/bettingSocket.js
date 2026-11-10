// socket/bettingSocket.js

// WebSocketServer - from the ws library, lets you create a WebSocketServer that client (browsers, app) can connect to
import dotenv from 'dotenv';
import io from 'socket.io-client';
import { WebSocketServer } from 'ws';
import betModel from '../models/betModel.js';
import {
  calculateCashoutValue,
  isCashoutEligible,
  CASHOUT_GAME_TYPES,
} from '../utils/cashoutUtils.js';
import { getBestOddsForTeam } from '../controllers/cashoutController.js';
import {
  fetchMatchData,
} from '../services/matchApi/index.js';
import { getCasinoTable } from '../services/casinoTableCache.js';
import {
  getLatestScore,
  isValidScoreEventId,
  requestScore,
  startLiveScoreFeed,
} from '../services/liveScoreFeed.js';

dotenv.config();

// Global State
// clients -> Array holding all connected clients each with
// --> ws (the websocket connection)
// --> gameid (the match they subscribed to)
// --> apitype (the sport: cricket, tennis, soccer, etc)
// --> His browser sends { "type": "subscribe", "gameid": "1234", "apitype": "cricket" }
// --> His server adds him to clients[]
// --> clients = [ { ws: RahulSocket, gameid: "1234", apitype: "cricket" } ]
export let clients = [];

// Cached data -> Stores the latest data fetched for each gameid + apitype combo so you can avoid sending duplicate updates
export let cachedData = {};
let wssInstance = null;

const casinoBettingCache = new Map();
const roundIdCache = new Map();

//  NEW: Cache for casino results to prevent duplicate result broadcasts
let cachedCasinoResults = new Map();

//  NEW: Cache for recent results to prevent sending old results
let recentResultsCache = new Map();

// Store score socket connection per match
let liveScoreSockets = {};

// helper: subscribe to the Live score
const subscribeToLiveScore = (gameid, apitype) => {
  const key = `${gameid}_${apitype}`;

  // Prevent duplicate socket connections for same game
  if (liveScoreSockets[key]) {
    console.log(` Already subscribed to live score for ${gameid} (${apitype})`);
    return;
  }

  try {
    console.log(` Connecting to live score for ${gameid} (${apitype})...`);

    const scoreSocket = io(BASE_SCORE_URL, {
      transports: ['websocket'],
      reconnection: false, // disable auto reconnect
      timeout: 20000,
      forceNew: true,
    });

    liveScoreSockets[key] = scoreSocket;

    //  When connected
    scoreSocket.on('connect', () => {
      console.log(` Connected to live score for ${gameid} (${apitype})`);
      scoreSocket.emit('subscribe', { gameid, apitype });
    });

    //  When score updates arrive
    scoreSocket.on('score_update', (data) => {
      console.log(` Live update for ${gameid} (${apitype}):`, data);
    });

    // When disconnected
    scoreSocket.on('disconnect', (reason) => {
      console.warn(` Disconnected from ${gameid} (${apitype}):`, reason);
      delete liveScoreSockets[key];
    });

    //  Handle connection errors safely
    scoreSocket.on('connect_error', (err) => {
      console.error(
        ` Score socket error for ${gameid} (${apitype}):`,
        err.message
      );

      // Close and clean current socket
      try {
        scoreSocket.close();
      } catch (closeErr) {
        console.error(' Error while closing socket:', closeErr.message);
      }

      delete liveScoreSockets[key];

      // Retry safely after 5 seconds (no recursion)
      setTimeout(() => {
        console.log(` Reconnecting to ${gameid} (${apitype})...`);
        subscribeToLiveScore(gameid, apitype);
      }, 5000);
    });
  } catch (err) {
    console.error(
      ' Unexpected error while subscribing to live score:',
      err.message
    );
  }
};

const getUniqueSubscriptions = () => {
  const uniqueSubscriptions = clients
    .map((c) => {
      if (!c.gameid) return null;

      if (c.apitype === 'casino') {
        return {
          gameid: c.gameid,
          apitype: c.apitype,
          roundId: c.roundId,
        };
      } else {
        return {
          gameid: c.gameid,
          apitype: c.apitype || 'cricket',
        };
      }
    })
    .filter(Boolean);

  return [
    ...new Map(
      uniqueSubscriptions.map((obj) => {
        if (obj.apitype === 'casino' && obj.roundId) {
          return [`${obj.gameid}_${obj.apitype}_${obj.roundId}`, obj];
        } else {
          return [`${obj.gameid}_${obj.apitype}`, obj];
        }
      })
    ).values(),
  ];
};

/**
 * Compute and push live cashout values for all users with open eligible bets on a game.
 * Called after odds change in pollBettingData.
 */
const computeAndPushCashoutValues = async (gameid) => {
  try {
    // Find all open, cashout-eligible bets for this game
    const openBets = await betModel.find({
      gameId: gameid,
      status: 0,
      gameType: { $in: CASHOUT_GAME_TYPES },
      isCashoutHedge: { $ne: true },
      isCashedOut: { $ne: true },
    });

    if (openBets.length === 0) return;

    // Group bets by userId
    const betsByUser = new Map();
    for (const bet of openBets) {
      const uid = bet.userId.toString();
      if (!betsByUser.has(uid)) betsByUser.set(uid, []);
      betsByUser.get(uid).push(bet);
    }

    // For each user, calculate cashout per bet and push
    for (const [uid, userBets] of betsByUser) {
      const cashoutData = [];

      for (const bet of userBets) {
        const { bestLay, bestBack } = getBestOddsForTeam(
          bet.gameId,
          bet.gameName,
          bet.teamName
        );
        const value = calculateCashoutValue([bet], bestLay, bestBack);
        if (value !== null) {
          cashoutData.push({
            betId: bet._id.toString(),
            cashoutValue: value,
          });
        }
      }

      if (cashoutData.length > 0) {
        sendCashoutUpdates(uid, cashoutData);
      }
    }
  } catch (err) {
    console.error(`[CASHOUT PUSH] Error for game ${gameid}:`, err.message);
  }
};

// Poll betting data for cricket, tennis, soccer
const pollBettingData = async () => {
  const groupedByGameId = getUniqueSubscriptions();

  for (const { gameid, apitype } of groupedByGameId) {
    try {
      // Skip casino games in this function
      if (apitype === 'casino') continue;

      let sid = 4; // default cricket
      if (apitype === 'tennis') sid = 2;
      else if (apitype === 'soccer') sid = 1;
      else if (apitype === 'horse-racing') sid = 10;

      const newData = await fetchMatchData(gameid, sid);

      if (newData.success) {
        const cacheKey = `${gameid}_${apitype}`;
        if (JSON.stringify(newData) !== JSON.stringify(cachedData[cacheKey])) {
          cachedData[cacheKey] = newData;

          clients.forEach((client) => {
            if (
              client.gameid === gameid &&
              client.apitype === apitype &&
              client.ws.readyState === 1
            ) {
              client.ws.send(
                JSON.stringify({
                  type: 'bettingData',
                  gameid,
                  apitype,
                  data: newData.data,
                })
              );
            }
          });

          // Push live cashout values for users watching this game
          computeAndPushCashoutValues(gameid).catch((err) =>
            console.error(`Cashout push error for ${gameid}:`, err.message)
          );
        }
      }
    } catch (error) {
      console.error(`Polling error for ${gameid} (${apitype}):`, error.message);
    }
  }
};

// Poll casino betting data - IMMEDIATE (no delays)
let casinoPollRunning = false;
const pollCasinoBettingData = async () => {
  // A slow provider must not let ticks pile up on top of each other
  if (casinoPollRunning) return;
  casinoPollRunning = true;

  try {
    const casinoGames = [
      ...new Set(
        getUniqueSubscriptions()
          .filter((s) => s.apitype === 'casino')
          .map((s) => s.gameid)
      ),
    ];

    // Tables are fetched in parallel; the shared cache means a table that was just
    // read for bet validation is not fetched again.
    const updates = await Promise.all(
      casinoGames.map(async (gameid) => {
        try {
          const newBettingData = await getCasinoTable(gameid, 900);
          if (!newBettingData?.success || !newBettingData.data) return null;

          const cacheKey = `betting_${gameid}_casino`;
          // Simple check: only send if data changed
          if (
            JSON.stringify(cachedData[cacheKey]) ===
            JSON.stringify(newBettingData)
          ) {
            return null;
          }

          cachedData[cacheKey] = newBettingData;

          // Serialised once and reused for every viewer of this table
          return [
            gameid,
            JSON.stringify({
              type: 'casino_update',
              gameid,
              apitype: 'casino',
              data: newBettingData.data,
            }),
          ];
        } catch (error) {
          console.error(
            `Casino betting data polling error for ${gameid}:`,
            error.message
          );
          return null;
        }
      })
    );

    const changed = new Map(updates.filter(Boolean));
    if (changed.size === 0) return;

    for (const client of clients) {
      if (client.apitype !== 'casino' || client.ws.readyState !== 1) continue;
      const message = changed.get(client.gameid);
      if (message) client.ws.send(message);
    }
  } finally {
    casinoPollRunning = false;
  }
};

// setupWebSocket is called with your HTTP server so that the WebSocket server can share the same port
export const setupWebSocket = (server) => {
  // Create a WebSocket server (wss) that listens for client connections
  const wss = new WebSocketServer({ server });

  // Every time someone connects we:
  wss.on('connection', (ws) => {
    //  Create client object with roundId and userId
    let client = {
      ws,
      gameid: null,
      apitype: null,
      roundId: null,
      userId: null,
      userName: null,
      scoreEventId: null,
    };
    clients.push(client);

    //  Complete message handler
    ws.on('message', (message) => {
      try {
        const jsonStr = message.toString();
        const data = JSON.parse(jsonStr);

        // Register userId for account-level updates (balance, exposure, open bets, cashout)
        if (data.type === 'register' && data.userId) {
          client.userId = data.userId;
          indexClientUser(client, client.userId);
        }

        if (data.type === 'subscribe' && data.gameid) {
          client.gameid = data.gameid;
          client.apitype = data.apitype || 'cricket';
          client.roundId = data.roundId || null;
          // Keep an earlier registration if this subscribe carries no userId
          client.userId = data.userId || client.userId || null;
          indexClientUser(client, client.userId);

          // A new subscriber gets the latest table right away from the shared cache;
          // clearing it instead would make the poller re-broadcast to every viewer.
          if (client.apitype === 'casino') {
            const latest = cachedData[`betting_${client.gameid}_casino`];
            if (latest?.data && ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: 'casino_update',
                  gameid: client.gameid,
                  apitype: 'casino',
                  data: latest.data,
                })
              );
            }
          }

          //  FIX: Subscribe to live score socket for this game
          subscribeToLiveScore(client.gameid, client.apitype);

          // Live scorecard: viewers share one provider feed per event
          if (isValidScoreEventId(data.scoreEventId)) {
            client.scoreEventId = data.scoreEventId;
            const cached = getLatestScore(client.scoreEventId);
            if (cached && ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: 'scoreData',
                  scoreEventId: client.scoreEventId,
                  data: cached.data,
                })
              );
            }
            requestScore(client.scoreEventId);
          } else {
            client.scoreEventId = null;
          }
        }
      } catch (err) {
        console.error(' [WS] Invalid message:', err.message);
      }
    });

    // Remove the disconnected client from the clients array
    ws.on('close', () => {
      indexClientUser(client, null);
      clients = clients.filter((c) => c.ws !== ws);
    });
  });

  // Start all polling intervals
  setInterval(pollBettingData, 1000);
  setInterval(pollCasinoBettingData, 1000);

  // Live scorecards: one shared provider feed, refreshed every 5s per active event
  startLiveScoreFeed({
    activeEventIds: () => [
      ...new Set(clients.map((c) => c.scoreEventId).filter(Boolean)),
    ],
    onUpdate: (eventId, data) => {
      const message = JSON.stringify({
        type: 'scoreData',
        scoreEventId: eventId,
        data,
      });
      clients.forEach((client) => {
        if (client.scoreEventId === eventId && client.ws.readyState === 1) {
          client.ws.send(message);
        }
      });
    },
  });
};

//  REMOVED: sendCasinoResultUpdate function
// Frontend now uses API calls (fetchCasinoResultData) triggered by useRef round detection
// This function is no longer needed and has been replaced with the optimized approach

// userId -> Set of that user's sockets. Account updates (balance/exposure/open bets)
// go straight to the owner instead of scanning or broadcasting to every connection.
const clientsByUser = new Map();

const indexClientUser = (client, userId) => {
  const next = userId ? String(userId) : null;
  if (client.userKey === next) return;

  if (client.userKey) {
    const previous = clientsByUser.get(client.userKey);
    previous?.delete(client);
    if (previous && previous.size === 0) clientsByUser.delete(client.userKey);
  }

  client.userKey = next;
  if (next) {
    let sockets = clientsByUser.get(next);
    if (!sockets) {
      sockets = new Set();
      clientsByUser.set(next, sockets);
    }
    sockets.add(client);
  }
};

const sendToUserSockets = (userId, payload) => {
  const sockets = clientsByUser.get(String(userId?._id ?? userId));
  if (!sockets) return 0;

  const message = JSON.stringify(payload);
  let sentCount = 0;
  for (const client of sockets) {
    if (client.ws.readyState === 1) {
      client.ws.send(message);
      sentCount++;
    }
  }
  return sentCount;
};

//FUNCTION THAT SENDS BALANCE UPDATES TO THE USER'S CONNECTED CLIENTS
export const sendBalanceUpdates = (userId, newBalance) => {
  sendToUserSockets(userId, {
    type: 'balance_update',
    userId,
    newBalance,
  });
};

//FUNCTION THAT SENDS EXPOSURE UPDATES TO THE USER'S CONNECTED CLIENTS
export const sendExposureUpdates = (userId, newExposure) => {
  sendToUserSockets(userId, {
    type: 'exposure_update',
    userId,
    newExposure,
  });
};

//FUNCTION THAT UPDATES OPEN BETS TO THE USER'S CONNECTED CLIENTS AFTER BET SETTLEMENT
export const sendOpenBetsUpdates = (userId, newOpenBets) => {
  sendToUserSockets(userId, {
    type: 'open_bets_update',
    userId: userId?._id ?? userId,
    newOpenBets,
  });
};

export const sendToUser = (userName, payload) => {
  if (!wssInstance) return console.warn(' WebSocket not initialized yet');

  clients.forEach((client) => {
    if (client.userName === userName && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify(payload));
    }
  });
};

// Function to send user refresh message (triggers getUser() on frontend)
export const sendUserRefresh = (userId) => {
  console.log(' [WEBSOCKET] Sending user refresh request for userId:', userId);

  let sentCount = 0;
  clients.forEach((client) => {
    if (client.userId === userId && client.ws.readyState === 1) {
      client.ws.send(
        JSON.stringify({
          type: 'user_refresh_needed',
          userId: userId,
        })
      );
      sentCount++;
      console.log(` [WEBSOCKET] Sent refresh request to client ${sentCount}`);
    }
  });

  console.log(
    ` [WEBSOCKET] Sent refresh request to ${sentCount} clients for userId: ${userId}`
  );
};

//FUNCTION THAT SENDS CASHOUT UPDATES TO SPECIFIC USER'S CONNECTED CLIENTS
export const sendCashoutUpdates = (userId, cashoutData) => {
  clients.forEach((client) => {
    if (client.userId === userId && client.ws.readyState === 1) {
      client.ws.send(
        JSON.stringify({
          type: 'cashout_update',
          userId,
          bets: cashoutData, // array of { betId, cashoutValue }
        })
      );
    }
  });
};

// In short — the flow
// Client connects → added to clients
// Client subscribes → sends { type: "subscribe", gameid, apitype }
// Server subscribes to live score socket (1 connection per game + apitype)
// Server polls API every 3 seconds for each unique subscription
// If data changed, sends update to subscribed clients
// If client disconnects, they're removed from the list
