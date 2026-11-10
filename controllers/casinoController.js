import dotenv from 'dotenv';

import redis, { connectRedis } from '../config/redis.js';
import { saveCasinoRoundSnapshot } from '../services/casinoRoundSync.js';
import { getCasinoTable } from '../services/casinoTableCache.js';
import {
  fetchCasinoDetailResult as fetchCasinoDetailResultApi,
  fetchCasinoResult as fetchCasinoResultApi,
  fetchCasinoTables,
} from '../services/matchApi/index.js';

dotenv.config();

export const isCasinoGame = (gameId, cid, gid, tabno) => {
  try {
    if (cid != null && Number(cid) === 4) return true;
    if (gid != null && Number(gid) === 35) return true;
    if (tabno != null && Number(tabno) === 6) return true;
    if (typeof gameId === 'string' && !/^\d+$/.test(gameId)) return true;
    return false;
  } catch {
    return false;
  }
};

const EVENT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

// Fallback TTL in SECONDS (60 = 1 min).
const DEFAULT_TTL_SECONDS = Number(process.env.CASINO_CACHE_TTL) || 60;

// Har route ka apna alag Redis key prefix aur apna alag TTL.
// Saare TTL seconds me hain (list ko chhodkar, wo hours me hai).
// .env se bhi change kar sakte ho.
const CACHE = {
  list: {
    prefix: 'casino:list',
    // 6 ghante
    ttl: (Number(process.env.CASINO_LIST_TTL_HOURS) || 6) * 60 * 60,
  },
  betting: {
    prefix: 'casino:betting',
    // 1 min
    ttl: Number(process.env.CASINO_BETTING_TTL) || 60,
  },
  result: {
    prefix: 'casino:result',
    // 1 min
    ttl: Number(process.env.CASINO_RESULT_TTL) || 60,
  },
  resultDetail: {
    prefix: 'casino:result-detail',
    // 1 min
    ttl: Number(process.env.CASINO_RESULT_DETAIL_TTL) || 60,
  },
};

// Collapse Redis reads for requests arriving during the same refresh window.
const CASINO_LIST_LOCAL_CACHE_TTL_MS = 500;
let casinoListLocalCache = null;
let casinoListRequest = null;

/* -------------------------------------------------------------------------- */
/*  Redis helpers: pehle redis check, miss hone par API, phir redis me save    */
/* -------------------------------------------------------------------------- */

const getFromRedis = async (key) => {
  try {
    await connectRedis();
    const cached = await redis.get(key);

    if (cached !== null) {
      console.log('[REDIS] HIT ', key);
      return JSON.parse(cached);
    }

    console.log('[REDIS] MISS', key);
    return null;
  } catch (err) {
    console.error('[REDIS] GET failed:', key, err.message);
    return null; // redis down ho to API se data lenge
  }
};

const saveToRedis = async (key, data, ttl = DEFAULT_TTL_SECONDS) => {
  try {
    if (data === undefined) return;
    await connectRedis();
    // EX = seconds
    const res = await redis.set(key, JSON.stringify(data), { EX: ttl });
    console.log('[REDIS] SET', res, `ttl=${ttl}s`, key);
  } catch (err) {
    console.error('[REDIS] SET failed:', key, err.message);
  }
};

/**
 * 1. Redis check
 * 2. Nahi mila to API call (loader)
 * 3. API ka data Redis me save
 */
const getWithCache = async (key, loader, ttl = DEFAULT_TTL_SECONDS) => {
  const cached = await getFromRedis(key);
  if (cached !== null) return cached;

  const fresh = await loader();

  await saveToRedis(key, fresh, ttl);

  return fresh;
};

/* -------------------------------------------------------------------------- */
/*  Controllers                                                               */
/* -------------------------------------------------------------------------- */

const loadCasinoList = async () => {
  const payload = await fetchCasinoTables();

  // Provider A returns a bare array; other providers may wrap it in { success, data }.
  if (Array.isArray(payload)) return payload;
  if (payload?.success) return payload.data || [];

  const error = new Error('Failed to fetch casino data from provider');
  error.provider = payload;
  throw error;
};

const getCasinoList = () => {
  if (
    casinoListLocalCache &&
    Date.now() - casinoListLocalCache.cachedAt < CASINO_LIST_LOCAL_CACHE_TTL_MS
  ) {
    return Promise.resolve(casinoListLocalCache);
  }

  if (!casinoListRequest) {
    casinoListRequest = getWithCache(
      CACHE.list.prefix,
      loadCasinoList,
      CACHE.list.ttl
    )
      .then((data) => {
        casinoListLocalCache = {
          json: JSON.stringify({ success: true, data }),
          cachedAt: Date.now(),
        };
        return casinoListLocalCache;
      })
      .finally(() => {
        casinoListRequest = null;
      });
  }

  return casinoListRequest;
};

export const getCasinoData = async (req, res) => {
  try {
    const response = await getCasinoList();

    return res.status(200).type('json').send(response.json);
  } catch (error) {
    console.error('getCasinoData error:', error?.message || error);

    if (error.provider !== undefined) {
      return res.status(502).json({
        success: false,
        message: error.message,
        provider: error.provider,
      });
    }

    return res.status(503).json({
      success: false,
      message: 'Casino provider temporarily unavailable',
    });
  }
};


export const getCasinoBettingData = async (req, res) => {
  // Support both frontend query formats
  const eventName = req.query.eventName || req.query.type;

  if (!eventName) {
    return res.status(400).json({
      success: false,
      message: 'Event Name is required',
    });
  }

  if (
    typeof eventName !== 'string' ||
    !EVENT_NAME_PATTERN.test(eventName)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid event name',
    });
  }

  try {
    // 1. Fetch casino data using existing Redis cache
    const data = await getWithCache(
      `${CACHE.betting.prefix}:${eventName}`,
      () => getCasinoTable(eventName, 0),
      CACHE.betting.ttl
    );

    // 2. Validate provider MID
    if (!data || data.mid === undefined || data.mid === null) {
      return res.status(502).json({
        success: false,
        message: 'Casino round data not found',
      });
    }

    // 3. Automatically save MID-wise snapshot
    // Existing MID update hoga, new MID separate document banayega.
    await saveCasinoRoundSnapshot(eventName, data);

    // 4. Return original response to frontend
    return res.status(200).json({
      message: 'Casino Betting data fetched Successfully',
      data,
    });

  } catch (error) {
    if (error?.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: 'This game is not available right now',
      });
    }

    console.error(
      'getCasinoBettingData error:',
      error?.message || error
    );

    return res.status(503).json({
      success: false,
      message: 'Casino provider temporarily unavailable',
    });
  }
};


export const getCasinoResultData = async (req, res) => {
  const { eventName } = req.query;

  if (!eventName) {
    return res.status(400).json({
      success: false,
      message: 'Game event is required',
    });
  }

  if (typeof eventName !== 'string' || !EVENT_NAME_PATTERN.test(eventName)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid event name',
    });
  }

  try {
    const data = await getWithCache(`${CACHE.result.prefix}:${eventName}`, async () => {
      const response = await fetchCasinoResultApi(eventName);

      if (!response?.success) {
        const error = new Error('Invalid Response from API');
        error.provider = response;
        throw error;
      }

      return response.data;
    }, CACHE.result.ttl);

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('getCasinoResultData error:', error?.message || error);

    return res.status(error.provider !== undefined ? 502 : 503).json({
      success: false,
      message: error.message || 'Casino provider temporarily unavailable',
      ...(error.provider !== undefined ? { provider: error.provider } : {}),
    });
  }
};

export const getCasinoResultDetailData = async (req, res) => {
  const { gtype, mid } = req.query;

  if (!gtype || !mid) {
    return res.status(400).json({
      success: false,
      message: 'gtype or mid is missing',
    });
  }

  if (
    typeof gtype !== 'string' ||
    typeof mid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,40}$/.test(gtype) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(mid)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid gtype or mid',
    });
  }

  try {
    const data = await getWithCache(
      `${CACHE.resultDetail.prefix}:${gtype}:${mid}`,
      async () => {
        const response = await fetchCasinoDetailResultApi(gtype, mid);

        if (!response) {
          throw new Error('Invalid provider response');
        }

        return response?.data?.t1 ?? null;
      },
      CACHE.resultDetail.ttl
    );

    return res.status(200).json({ message: 'Success', data });
  } catch (error) {
    console.error('getCasinoResultDetailData error:', error?.message || error);

    return res.status(503).json({
      success: false,
      message: 'Casino provider temporarily unavailable',
    });
  }
};