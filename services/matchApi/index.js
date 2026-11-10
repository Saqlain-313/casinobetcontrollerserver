import dotenv from 'dotenv';

import { createProviderA } from './providerA.js';
import { createProviderB } from './providerB.js';
import { createProviderC } from './providerC.js';

dotenv.config();

const PROVIDER = (process.env.API_PROVIDER || 'provider A').toLowerCase();

console.log("Active Provider", PROVIDER);

let activeProvider;

switch (PROVIDER) {
  case 'providerb':
  case 'provider_b':
    activeProvider = createProviderB();
    break;
  case 'providerc':
  case 'provider_c':
    activeProvider = createProviderC();
    break;
  case 'providera':
  case 'provider_a':
    activeProvider = createProviderA();
    break;
  default:
    activeProvider = createProviderA();
    break;
}

console.log(`[API PROVIDER] Active provider: ${PROVIDER}`);

export const fetchMatchList = (sportId) => activeProvider.fetchMatchList(sportId);
export const fetchMatchData = (gameId, sportId) =>
  activeProvider.fetchMatchData(gameId, sportId);

export const getResult = (payload) => activeProvider.getResult(payload);
export const sendBetIncoming = (payload) =>
  activeProvider.sendBetIncoming(payload);

export const fetchCasinoTables = () => activeProvider.fetchCasinoTables();
export const fetchCasinoData = (eventName) =>
  activeProvider.fetchCasinoData(eventName);
export const fetchCasinoResult = (eventName) =>
  activeProvider.fetchCasinoResult(eventName);
export const fetchCasinoDetailResult = (gtype, mid) =>
  activeProvider.fetchCasinoDetailResult(gtype, mid);

export const fetchCricketFancyResult = (eventId, fancyId) =>
  activeProvider.fetchCricketFancyResult(eventId, fancyId);
export const fetchCricketFancyByEvent = (eventId) =>
  activeProvider.fetchCricketFancyByEvent(eventId);
export const fetchStFancyByEvent = (eventId) =>
  activeProvider.fetchStFancyByEvent(eventId);

export const fetchScore = (gmid, sid) => activeProvider.fetchScore(gmid, sid);
export const fetchAllIframes = (gmid) => activeProvider.fetchAllIframes(gmid);

export const getProviderName = () => PROVIDER;

export default activeProvider;
