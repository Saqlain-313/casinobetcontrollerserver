import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

/** App sport ids (controllers/socket) → 81club.fun API sid */
const APP_SPORT_ID_TO_API_SID = {
  1: 1, // football
  2: 2, // tennis
  4: 3, // cricket (app uses 4; API uses 3)
};

function toApiSportId(sportId) {
  const id = Number(sportId);
  return APP_SPORT_ID_TO_API_SID[id] ?? id;
}

function parseBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.toLowerCase() === 'true';
  return Boolean(val);
}

const MONTH_ABBR = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function parseEventName(eventName = '') {
  const trimmed = String(eventName).trim();
  const slashIdx = trimmed.lastIndexOf(' / ');
  if (slashIdx === -1) return { ename: trimmed, stime: '' };
  return {
    ename: trimmed.slice(0, slashIdx).trim(),
    stime: trimmed.slice(slashIdx + 3).trim(),
  };
}

/** 81club "May 25 2026 10:00AM (IST)" → "5/25/2026 10:00:00 AM" for client Date parsing */
function normalizeStime(stimeRaw) {
  if (!stimeRaw) return '';

  const cleaned = String(stimeRaw).replace(/\s*\(IST\)\s*/gi, '').trim();
  if (!cleaned) return '';

  if (cleaned.includes('/')) {
    const d = new Date(cleaned);
    if (!Number.isNaN(d.getTime())) return cleaned;
  }

  const m = cleaned.match(
    /^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i
  );
  if (!m) return cleaned;

  const monthIdx = MONTH_ABBR[m[1].slice(0, 3).toLowerCase()];
  if (monthIdx === undefined) return cleaned;

  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  const month = monthIdx + 1;
  const hours12 = parseInt(m[4], 10);
  const minutes = String(parseInt(m[5], 10)).padStart(2, '0');
  const ampm = m[6].toUpperCase();

  return `${month}/${day}/${year} ${hours12}:${minutes}:00 ${ampm}`;
}

function buildSectionOdds(back, lay) {
  return [
    { odds: Number(back) || 0, oname: 'back1', otype: 'back' },
    { odds: Number(lay) || 0, oname: 'lay1', otype: 'lay' },
  ];
}

function hasStructuredSection(raw) {
  return (
    Array.isArray(raw.section) &&
    raw.section.length > 0 &&
    Array.isArray(raw.section[0]?.odds)
  );
}

/** 81club /esid: flat cricket array or { body: [...] } tennis/soccer — normalize for controllers */
function normalizeEsidMatch(raw) {
  const hasApiStime =
    raw.stime != null && String(raw.stime).trim() !== '';

  let ename;
  let stime;

  if (hasApiStime) {
    ename = String(raw.ename || raw.eventName || '').trim();
    stime = normalizeStime(raw.stime);
  } else {
    const parsed = parseEventName(raw.eventName || raw.ename || '');
    ename = parsed.ename;
    stime = normalizeStime(parsed.stime);
  }

  const sections = raw.section || [];
  const defaultEtid = Number(raw.eid ?? raw.etid) || 4;

  return {
    gmid: raw.gameId ?? raw.gmid,
    oldgmid: raw.oldgmid ?? raw.gameId ?? raw.gmid,
    beventId: raw.beventId ?? raw.oldgmid ?? null,
    ename,
    stime,
    cname: raw.cname,
    iplay: parseBool(raw.inPlay ?? raw.iplay),
    tv: parseBool(raw.tv),
    bm: parseBool(raw.m1 ?? raw.bm),
    f: parseBool(raw.f),
    etid: defaultEtid,
    cid: raw.cid,
    section: hasStructuredSection(raw)
      ? raw.section
      : [
        {
          sid: sections[0]?.sid ?? 0,
          nat: sections[0]?.nat ?? '',
          odds: buildSectionOdds(raw.back1, raw.lay1),
        },
        {
          sid: sections[1]?.sid ?? 0,
          nat: sections[1]?.nat ?? '',
          odds: buildSectionOdds(raw.back11, raw.lay11),
        },
      ],
  };
}

function normalizeEsidResponse(data) {
  if (data?.success && data?.data?.t1) return data;

  if (Array.isArray(data?.body)) {
    const matches = data.body.map(normalizeEsidMatch);
    return {
      success: true,
      msg: 'Success',
      status: data.status ?? 200,
      data: { t1: matches, t2: [] },
    };
  }

  if (Array.isArray(data)) {
    const matches = data.map(normalizeEsidMatch);
    return {
      success: true,
      msg: 'Success',
      status: 200,
      data: { t1: matches, t2: [] },
    };
  }

  if (data?.t1 || data?.t2) {
    return {
      success: true,
      data: {
        t1: (data.t1 || []).map(normalizeEsidMatch),
        t2: (data.t2 || []).map(normalizeEsidMatch),
      },
    };
  }

  return { success: false, msg: 'Unexpected esid response from Provider C' };
}

export function createProviderC() {
  const API_URL =
    process.env.PROVIDER_C_API_URL || 'https://81club.fun/api/v1';
  const API_KEY = process.env.PROVIDER_C_API_KEY || process.env.API_KEY;

  // console.log("API_URL", API_URL);
  // console.log("API_KEY", API_KEY);
  const RESULT_API_URL =
    process.env.PROVIDER_C_RESULT_API_URL ||
    process.env.RESULT_API_URL ||
    API_URL;

  return {
    name: 'providerC',

    async fetchMatchList(sportId) {
      const apiSid = toApiSportId(sportId);
      const response = await axios.get(`${API_URL}/esid`, {
        params: { sid: apiSid, key: API_KEY },
      });
      return normalizeEsidResponse(response.data);
    },

    async fetchMatchData(gameId, sportId) {
      const apiSid = toApiSportId(sportId);
      const response = await axios.get(`${API_URL}/getPriveteData`, {
        params: { key: API_KEY, gmid: gameId, sid: apiSid },
      });
      return response.data;
    },

    async getResult(payload) {
      const { event_id, market_name, sport_id } = payload;
      const sid = Number(sport_id);

      try {
        let fancyUrl;
        if (sid === 4) {
          fancyUrl = `${API_URL}/cricket/fancybyevent?eventId=${event_id}&key=${API_KEY}`;
        } else if (sid === 1) {
          fancyUrl = `${API_URL}/stfancybyevent?eventId=${event_id}&key=${API_KEY}`;
        } else if (sid === 2) {
          fancyUrl = `${API_URL}/tennis/fancybyevent?eventId=${event_id}&key=${API_KEY}`;
        }

        if (fancyUrl) {
          const response = await axios.get(fancyUrl);
          const results = Array.isArray(response.data)
            ? response.data
            : response.data?.body || [];

          if (results.length > 0) {
            const needle = (market_name || '').toLowerCase().trim();

            const match =
              results.find(
                (r) =>
                  r.isResult &&
                  r.fancyType &&
                  r.fancyType.toLowerCase().trim() === needle
              ) ||
              results.find(
                (r) =>
                  r.isResult &&
                  r.fancyName &&
                  r.fancyName.toLowerCase().trim() === needle
              );

            if (match && match.result != null) {
              return { final_result: match.result };
            }
          }
        }
      } catch (err) {
        console.warn(
          `[ProviderB] fancybyevent failed for event ${event_id}, falling back to POST /get-result:`,
          err.message
        );
      }

      const response = await axios.post(
        `${API_URL}/get-result?key=${API_KEY}`,
        payload,
        { headers: { 'Content-Type': 'application/json' } }
      );
      return response.data;
    },

    async sendBetIncoming(payload) {
      let fullPayload;

      const apiSportId = String(toApiSportId(payload.sport_id));

      if (payload.fancyId) {
        fullPayload = {
          api_key: API_KEY,
          sport_id: apiSportId,
          sportName: payload.sportName || '',
          event_id: payload.event_id,
          beventId: payload.beventId ?? null,
          event_name: payload.event_name || '',
          fancyId: String(payload.fancyId),
          market_name: payload.market_name || '',
          fancyType: payload.fancyType || 'Normal',
        };
      } else {
        const beventId = payload.bevent_id ?? null;

        fullPayload = {
          api_key: API_KEY,
          event_id: payload.event_id,
          event_name: payload.event_name,
          market_id: payload.market_id,
          market_name: payload.market_name,
          market_type: payload.market_type,
          client_ref: payload.client_ref || null,
          sport_id: apiSportId,
          fancyId: null,
          fancymid: payload.fancymid ? String(payload.fancymid) : null,
          bevent_id: beventId || null,
          runners: payload.runners || [],
        };
      }
      console.log("fullPayload", fullPayload)
      const response = await axios.post(
        `${API_URL}/bet-incoming?key=${API_KEY}`,
        fullPayload,
        { headers: { 'Content-Type': 'application/json' } }
      );
      console.log("response", response.data)
      return response.data;
    },

    async fetchCasinoTables() {
      const response = await axios.get(
        `${API_URL}/casino/tableid?key=${API_KEY}`,
        { timeout: 10000 }
      );
      return response.data;
    },

    async fetchCasinoData(gameId) {
      const response = await axios.get(
        `${API_URL}/casino/data?key=${API_KEY}&type=${gameId}`
      );
      return response.data;
    },

    async fetchCasinoResult(gameId) {
      const response = await axios.get(
        `${API_URL}/casino/result?key=${API_KEY}&type=${gameId}`,
        { timeout: 10000 }
      );
      return response.data;
    },

    async fetchCasinoDetailResult(gameId, mid) {
      const response = await axios.get(
        `${API_URL}/casino/detail_result?key=${API_KEY}&type=${gameId}&mid=${mid}`
      );
      return response.data;
    },

    async fetchCricketFancyResult(eventId, fancyId) {
      const response = await axios.get(`${API_URL}/fancyresult?key=${API_KEY}`, {
        params: {
          key: API_KEY,
          eventId: String(eventId),
          fancyId: String(fancyId),
        },
      });
      return response.data;
    },

    async fetchCricketFancyByEvent(eventId) {
      const response = await axios.get(
        `${API_URL}/fancyresultbyeventId?eventId=${eventId}&key=${API_KEY}`
      );
      return response.data;
    },

    async fetchStFancyByEvent(eventId) {
      const response = await axios.get(
        `${API_URL}/stfancyresultbyeventId?eventId=${eventId}&key=${API_KEY}`
      );
      return response.data;
    },

    async fetchScore(gmid, sid) {
      const apiSid = toApiSportId(sid);
      const response = await axios.get(
        `${API_URL}/score?gtv=${gmid}&sid=${apiSid}&sportid=${apiSid}&key=${API_KEY}`
      );
      return response.data;
    },

    async fetchAllIframes(gmid) {
      const response = await axios.get(
        `${API_URL}/all-iframes?gmid=${gmid}&key=${API_KEY}`
      );
      return response.data;
    },
  };
}
