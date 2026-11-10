import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

// One shared connection to the live-score provider for ALL viewers. Each active
// match is re-requested every REFRESH_MS, so provider/server load depends on the
// number of live matches, never on the number of users watching.
const SCORE_WS_URL =
  process.env.LIVE_SCORE_WS_URL ||
  'wss://dimclscore.external247services.com/socket.io/?EIO=3&transport=websocket';
const PROVIDER_ID = process.env.LIVE_SCORE_PROVIDER_ID || '1';
const REFRESH_MS = 5000;
const RECONNECT_MS = 3000;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export const isValidScoreEventId = (id) =>
  typeof id === 'string' && EVENT_ID_PATTERN.test(id);

let socket = null;
let pingTimer = null;
let reconnectTimer = null;
let refreshTimer = null;
let onScore = () => {};
let getActiveEventIds = () => [];

const latestScores = new Map();

export const getLatestScore = (eventId) => latestScores.get(eventId) || null;

const subscribeEvent = (eventId) => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(
    `420["subscribe_event",{"eventId":"${eventId}","providerId":"${PROVIDER_ID}"}]`
  );
};

// Used when a viewer joins so they don't wait for the next 5s refresh tick.
export const requestScore = subscribeEvent;

const handleScore = (payload) => {
  const eventId = String(payload?.eventId ?? payload?.summary?.eventid ?? '');
  const data = payload?.summary?.data || payload?.data;
  if (!eventId || !data || typeof data !== 'object') return;

  const next = JSON.stringify(data);
  if (latestScores.get(eventId)?.json === next) return;

  latestScores.set(eventId, { json: next, data });
  onScore(eventId, data);
};

const clearTimers = () => {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
};

const connect = () => {
  if (socket) return;

  const ws = new WebSocket(SCORE_WS_URL);
  socket = ws;

  ws.on('message', (raw) => {
    const msg = String(raw);

    if (msg.startsWith('0')) {
      let interval = 25000;
      try {
        interval = JSON.parse(msg.slice(1)).pingInterval || interval;
      } catch {
        // keep default ping interval
      }
      clearTimers();
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('2');
      }, interval);
      return;
    }

    if (msg === '2') {
      ws.send('3');
      return;
    }

    if (msg === '40') {
      getActiveEventIds().forEach(subscribeEvent);
      return;
    }

    if (!msg.startsWith('42')) return;

    try {
      const [type, payload] = JSON.parse(msg.slice(2));
      if (type === 'summary_snapshot' || type === 'update') {
        handleScore(payload);
      }
    } catch (err) {
      console.error('[LIVE SCORE] Parse error:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('[LIVE SCORE] Socket error:', err.message);
  });

  ws.on('close', () => {
    clearTimers();
    if (socket === ws) socket = null;
    scheduleReconnect();
  });
};

export const startLiveScoreFeed = ({ activeEventIds, onUpdate }) => {
  if (refreshTimer) return;

  getActiveEventIds = activeEventIds;
  onScore = onUpdate;
  connect();

  refreshTimer = setInterval(() => {
    const active = new Set(getActiveEventIds());

    for (const eventId of latestScores.keys()) {
      if (!active.has(eventId)) latestScores.delete(eventId);
    }

    // Re-subscribing makes the provider send a fresh snapshot, so the score
    // stays current even if a push update is ever missed.
    active.forEach(subscribeEvent);
  }, REFRESH_MS);
};
