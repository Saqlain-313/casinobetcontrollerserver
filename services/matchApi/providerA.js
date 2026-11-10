import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export function createProviderA() {
  const API_URL = process.env.API_URL;
  const API_KEY = process.env.API_KEY;
  const RESULT_API_URL = process.env.RESULT_API_URL;

  // console.log("API_URL********", API_URL)
  // console.log("API_KEY**********", API_KEY)
  // console.log("RESULT_API_URL********", RESULT_API_URL)
  // /diamond/events

  return {
    name: 'providerA',

    // async fetchMatchList(sportId) {
    //   const response = await axios.get(
    //     `${API_URL}/esid?sid=${sportId}&key=${API_KEY}`
    //   );
    //   return response.data;
    // },
    async fetchMatchList(sportId) {
      console.log("sportId******", sportId)
      const response = await axios.get(
        `${API_URL}/diamond/events/${sportId}`,
        {
          headers: {
            "X-API-Key": API_KEY,
          },
        }
      );

      console.log("API_URL Response******", response)
      return response.data.data;
    },

    // async fetchMatchData(gameId, sportId) {
    //   const response = await axios.get(
    //     `${API_URL}/getPriveteData?key=${API_KEY}&gmid=${gameId}&sid=${sportId}`
    //   );
    //   return response.data;
    // },
    async fetchMatchData(gameId, sportId) {
      const response = await axios.get(
        `${API_URL}/diamond/odds/${sportId}_${gameId}`,
        {
          headers: {
            "X-API-Key": API_KEY,
          },
        }
      );

      // console.log('Provider A Fetch Match Data Response******', response.data.data)
      return response.data.data;
    },

    // async getResult(payload) {
    //   const response = await axios.post(
    //     `${RESULT_API_URL}/get-result?key=${API_KEY}`,
    //     { ...payload, api_key: API_KEY },
    //     { headers: { 'Content-Type': 'application/json' } }
    //   );
    //   return response.data;
    // },
    async getResult(payload) {
      const response = await axios.post(
        `${RESULT_API_URL}/all-results?key=${API_KEY}`,
        { ...payload, api_key: API_KEY },
        { headers: { 'Content-Type': 'application/json' } }
      );
      return response.data;
    },

    async sendBetIncoming(payload = {}) {
      // Provider A consumes a slimmer payload than Provider B.
      // Strip fields Provider A's API does not accept
      // (fancymid, bevent_id/beventId, runners, fancyId) and ensure
      // market_id is always present in the outgoing body.
      // Note: doing this here keeps the betController call sites
      // provider-agnostic — Provider B's own whitelist in
      // providerB.sendBetIncoming is not affected by these strips.
      const {
        fancymid: _fancymid,
        bevent_id: _bevent_id,
        beventId: _beventId,
        runners: _runners,
        fancyId: _fancyId,
        fancyType,
        ...rest
      } = payload;

      const body = {
        ...rest,
        market_id: payload.market_id ?? null,
        api_key: API_KEY,
      };

      // Provider A uses a single `market_type` field for every bet type.
      // Sport bets already pass `market_type` from the caller (kept via
      // ...rest). For fancy / fancy1 / oddeven the caller passes
      // `fancyType`, which we rename to `market_type` here so the
      // outgoing payload is consistent. Provider B is untouched: it
      // still reads `fancyType` from the original caller payload.
      if (fancyType !== undefined && body.market_type === undefined) {
        body.market_type = fancyType;
      }

      const response = await axios.post(
        `${RESULT_API_URL}/bet-incoming?key=${API_KEY}`,
        body,
        { headers: { 'Content-Type': 'application/json' } }
      );
      return response.data;
    },

    async fetchCasinoTables() {
      const response = await axios.get(
        `${API_URL}/diamond/casino-table-list?key=${API_KEY}`,
        { timeout: 10000 }
      );

      return response.data;
    },
    // async fetchCasinoTables() {
    //   console.log('Fetching casino tables...');
    //   const response = await axios.get(
    //     `${API_URL}/casino/tableid?key=${API_KEY}`,
    //     // { timeout: 10000 }
    //   );
    //   console.log('Fetched casino tables:', response);

    //   return response.data;
    // },

    async fetchCasinoData(eventName) {
      const response = await axios.get(
        `${API_URL}/diamond/casino/data/${encodeURIComponent(eventName)}?key=${API_KEY}`,
        { timeout: 10000 }
      );


      // The provider wraps the table as { fetchedAt, eventName, data: { success, data } }.
      // Everything downstream (socket polling, bet validation, the API) expects
      // { success, data }, so unwrap it once here.
      const table = response.data?.data;

      return table
      // return {
      //   success: Boolean(table?.success && table?.data),
      //   data: table?.data ?? null,
      // };
    },
    // async fetchCasinoData(gameId) {
    // //   const response = await axios.get(
    // //     `${API_URL}/casino/data?key=${API_KEY}&type=${gameId}`
    // //   );
    // //   return response.data;
    // },

    async fetchCasinoResult(eventName) {
      const response = await axios.get(
        `${API_URL}/diamond/casino/result/${encodeURIComponent(eventName)}?key=${API_KEY}`,
        { timeout: 10000 }
      );
      return response.data;
    },

    async fetchCasinoDetailResult(gtype, mid) {
      const response = await axios.get(
        `${API_URL}/diamond/casino/detail_result?key=${API_KEY}&type=${gtype}&mid=${mid}`
      );

      return response.data;
    },

    async fetchCricketFancyResult(eventId, fancyId) {
      return { success: false, message: 'Not supported by Provider A' };
    },

    async fetchCricketFancyByEvent(eventId) {
      return { success: false, message: 'Not supported by Provider A' };
    },

    async fetchStFancyByEvent(eventId) {
      return { success: false, message: 'Not supported by Provider A' };
    },

    async fetchScore(gmid, sid) {
      return { success: false, message: 'Not supported by Provider A' };
    },

    async fetchAllIframes(gmid) {
      return { success: false, message: 'Not supported by Provider A' };
    },
  };
}
