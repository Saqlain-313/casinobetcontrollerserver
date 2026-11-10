import crypto from 'crypto';
import redis, { connectRedis } from '../config/redis.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEBUG = process.env.CACHE_DEBUG === '1';
const log = (...args) => DEBUG && console.log('[CACHE]', ...args);

const RELEASE_LOCK = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

export const redisCache = async (key, fetchFunction, ttl = 1) => {
  const cacheKey = `casino:${key}`;
  const lockKey = `${cacheKey}:lock`;
  const lockToken = crypto.randomUUID();

  // 1. Make sure Redis is connected (startup me call na hua ho to bhi chalega)
  try {
    await connectRedis();
  } catch (err) {
    console.error('[CACHE] Redis connect failed, calling provider directly:', err.message);
    return fetchFunction();
  }

  // 2. Cache read
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      log('HIT', cacheKey);
      return JSON.parse(cached);
    }
    log('MISS', cacheKey);
  } catch (err) {
    console.error('[CACHE] GET failed, calling provider directly:', err.message);
    return fetchFunction();
  }

  // 3. Lock: sirf ek request provider ko call karegi
  let locked = null;
  try {
    locked = await redis.set(lockKey, lockToken, { NX: true, PX: 15000 });
  } catch (err) {
    console.error('[CACHE] LOCK failed, calling provider directly:', err.message);
    return fetchFunction();
  }

  if (locked) {
    try {
      // Double-check after lock
      const secondCheck = await redis.get(cacheKey);
      if (secondCheck !== null) return JSON.parse(secondCheck);

      const data = await fetchFunction();

      // undefined ko JSON.stringify karne par undefined milta hai, cache nahi karenge
      if (data === undefined) {
        console.warn('[CACHE] fetchFunction returned undefined, not caching:', cacheKey);
        return data;
      }

      try {
        const res = await redis.set(cacheKey, JSON.stringify(data), { EX: ttl });
        log('SET', res, 'ttl:', ttl, cacheKey);
      } catch (err) {
        console.error('[CACHE] SET failed:', err.message);
      }

      return data;
    } finally {
      try {
        await redis.eval(RELEASE_LOCK, { keys: [lockKey], arguments: [lockToken] });
      } catch (err) {
        console.error('[CACHE] Lock release failed:', err.message);
      }
    }
  }

  // 4. Dusri request fetch kar rahi hai, uska result wait karo
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    try {
      const result = await redis.get(cacheKey);
      if (result !== null) return JSON.parse(result);
    } catch {
      break;
    }
  }

  throw new Error('Casino provider request is busy. Please retry.');
};