/**
 * casinoEngine.js
 * Pure betting logic (no DB, no Express) - easy to unit test.
 *
 * Outcome strings: 'win' | 'lose' | 'push' | 'half_loss'
 * Bet shape: { side: 'back'|'lay', selection: string, odds: number, stake: number }
 */

// ---------------------------------------------------------------- constants
const RED_SET = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const LIMITS = {
  default: { min: 100, max: 50000 },
  dt: { min: 100, max: 100000 },
  baccarat: { min: 100, max: 100000 },
  roulette: { min: 25, max: 100000 },
};

const GAME_FAMILY = {
  lucky7: ['lucky7', 'lucky7eu', 'lucky7eu2', 'plucky7', 'vlucky7'],
  aaa: ['aaa', 'aaa2', 'vaaa'],
  dt: ['dt20', 'dt202', 'dt6', 'pdt20', 'pdt6', 'vdt6'],
  baccarat: ['baccarat', 'baccarat2', 'pbaccarat'],
  teen: ['teen', 'teen20', 'teen20b', 'teen20c', 'teen3', 'teen32', 'teen33', 'teen6', 'teen8', 'teen9',
    'pteen', 'pteen20', 'vteen', 'vteen20', 'poison', 'poison20', 'joker1', 'joker20', 'joker120',
    'teenunique', 'teen41', 'teen42'],
  muflis: ['teenmuf', 'vteenmuf'],
  roulette: ['roulette11', 'roulette12', 'roulette13', 'ourroullete'],
  sicbo: ['sicbo', 'sicbo2', 'dolidana'],
  card32: ['card32', 'card32eu', 'pcard32'],
  andarbahar: ['ab20', 'abj', 'ab3', 'ab4'],
  matka: ['worli', 'worli2', 'worli3'],
};

const familyOf = (slug) =>
  Object.keys(GAME_FAMILY).find((f) => GAME_FAMILY[f].includes(slug)) || null;

// ------------------------------------------------------------ money helpers
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function getLimits(slug) {
  const fam = familyOf(slug);
  return LIMITS[fam] || LIMITS.default;
}

/** Back = stake, Lay = liability = stake * (odds - 1) */
function calcExposure({ side, stake, odds }) {
  if (side === 'lay') return round2(stake * (odds - 1));
  return round2(stake);
}

function validateBet(slug, bet, { allowLay = true } = {}) {
  const errors = [];
  const { min, max } = getLimits(slug);
  if (!['back', 'lay'].includes(bet.side)) errors.push('side must be back or lay');
  if (!bet.selection) errors.push('selection required');
  if (!(bet.odds > 1)) errors.push('odds must be > 1');
  if (!Number.isFinite(bet.stake)) errors.push('stake must be a number');
  else if (bet.stake < min || bet.stake > max) errors.push(`stake must be between ${min} and ${max}`);
  if (bet.side === 'lay' && !allowLay) errors.push('lay not allowed on this market');
  // half-loss markets cannot be laid (no clean lay settlement)
  if (bet.side === 'lay' && isHalfLossMarket(slug, bet.selection)) errors.push('lay not allowed on this market');
  return errors;
}

function isHalfLossMarket(slug, selection) {
  const fam = familyOf(slug);
  if (fam === 'lucky7') return ['low', 'high'].includes(selection);
  if (fam === 'aaa') return ['under7', 'over7'].includes(selection);
  if (fam === 'dt') return ['dragon', 'tiger'].includes(selection);
  return false;
}

// --------------------------------------------------------------- settlement
/**
 * @returns {{ payout:number, net:number, exposure:number, outcome:string }}
 * payout = gross amount credited back to balance
 * net    = payout - exposure (final P&L)
 */
function settleBet(bet, selectionOutcome) {
  const exposure = calcExposure(bet);
  let payout = 0;
  let outcome = selectionOutcome;

  if (bet.side === 'back') {
    if (selectionOutcome === 'win') payout = bet.stake * bet.odds;
    else if (selectionOutcome === 'push') payout = bet.stake;
    else if (selectionOutcome === 'half_loss') payout = Math.round(bet.stake * 0.5);
    else payout = 0;
  } else {
    // lay: wins when the laid selection loses
    if (selectionOutcome === 'lose') { payout = exposure + bet.stake; outcome = 'win'; }
    else if (selectionOutcome === 'win') { payout = 0; outcome = 'lose'; }
    else if (selectionOutcome === 'push') payout = exposure;
    else payout = exposure; // half_loss on lay is blocked at validation
  }
  payout = round2(payout);
  return { payout, net: round2(payout - exposure), exposure, outcome };
}

// ----------------------------------------------------- card / rank helpers
const isRed = (c) => c.suit === 'H' || c.suit === 'D';
const rankVal = (c) => c.rank; // 1..13 (A=1, J=11, Q=12, K=13)
const bool = (v) => (v ? 'win' : 'lose');

// ------------------------------------------------------------ Lucky 7 family
// result: { card:{rank,suit} }
function evalLucky7(sel, { card }) {
  const r = card.rank;
  const [key, arg] = sel.split(':');
  switch (key) {
    case 'low': return r === 7 ? 'half_loss' : bool(r < 7);
    case 'high': return r === 7 ? 'half_loss' : bool(r > 7);
    case 'seven': return bool(r === 7);
    case 'even': return bool(r % 2 === 0);
    case 'odd': return bool(r % 2 === 1);
    case 'red': return bool(isRed(card));
    case 'black': return bool(!isRed(card));
    case 'card': return bool(r === Number(arg));
    case 'group': { // group:1 (A-3) 2 (4-6) 3 (8-10) 4 (J-K)
      const g = { 1: [1, 3], 2: [4, 6], 3: [8, 10], 4: [11, 13] }[arg];
      return bool(g && r >= g[0] && r <= g[1]);
    }
    default: throw new Error(`Unknown lucky7 selection: ${sel}`);
  }
}

// --------------------------------------------------- Amar Akbar Anthony family
function evalAAA(sel, { card }) {
  const r = card.rank;
  const [key, arg] = sel.split(':');
  switch (key) {
    case 'amar': return bool(r >= 1 && r <= 6);
    case 'akbar': return bool(r >= 7 && r <= 10);
    case 'anthony': return bool(r >= 11);
    case 'even': return bool(r % 2 === 0);
    case 'odd': return bool(r % 2 === 1);
    case 'red': return bool(isRed(card));
    case 'black': return bool(!isRed(card));
    case 'under7': return r === 7 ? 'half_loss' : bool(r < 7);
    case 'over7': return r === 7 ? 'half_loss' : bool(r > 7);
    case 'card': return bool(r === Number(arg));
    default: throw new Error(`Unknown aaa selection: ${sel}`);
  }
}

// ---------------------------------------------------------- Dragon Tiger
// result: { dragon:{rank,suit}, tiger:{rank,suit} }   (Ace low, King high)
function evalDragonTiger(sel, { dragon, tiger }) {
  const tie = dragon.rank === tiger.rank;
  const [key, who, arg] = sel.split(':'); // e.g. "dragon", "pair:dragon", "color:tiger:red"
  const pick = (w) => (w === 'dragon' ? dragon : tiger);
  switch (key) {
    case 'dragon': return tie ? 'half_loss' : bool(dragon.rank > tiger.rank);
    case 'tiger': return tie ? 'half_loss' : bool(tiger.rank > dragon.rank);
    case 'tie': return bool(tie);
    case 'suitedtie': return bool(tie && dragon.suit === tiger.suit);
    case 'pair': return bool(tie); // spec: pair payout 11 on equal rank
    case 'color': return bool(arg === 'red' ? isRed(pick(who)) : !isRed(pick(who)));
    case 'parity': return bool(arg === 'even' ? pick(who).rank % 2 === 0 : pick(who).rank % 2 === 1);
    default: throw new Error(`Unknown dt selection: ${sel}`);
  }
}

// ---------------------------------------------------------------- Baccarat
// result: { playerPoints, bankerPoints, playerPair, bankerPair }
function evalBaccarat(sel, r) {
  const tie = r.playerPoints === r.bankerPoints;
  switch (sel) {
    case 'player': return tie ? 'push' : bool(r.playerPoints > r.bankerPoints);
    case 'banker': return tie ? 'push' : bool(r.bankerPoints > r.playerPoints); // odds 1.95 => 5% commission
    case 'tie': return bool(tie);
    case 'playerPair': return bool(r.playerPair);
    case 'bankerPair': return bool(r.bankerPair);
    case 'eitherPair': return bool(r.playerPair || r.bankerPair);
    default: throw new Error(`Unknown baccarat selection: ${sel}`);
  }
}

// ------------------------------------------------------------- Teen Patti
// 3-card hand ranking. hand = [{rank,suit} x3]
function rankHand(hand) {
  const rs = hand.map((c) => c.rank).sort((a, b) => a - b);
  const flush = hand.every((c) => c.suit === hand[0].suit);
  const trio = rs[0] === rs[2];
  const pair = rs[0] === rs[1] || rs[1] === rs[2];
  // straight: consecutive, plus A-2-3 and Q-K-A valid, K-A-2 invalid
  let straight = false;
  let high = [...rs].map((r) => (r === 1 ? 14 : r)).sort((a, b) => b - a);
  if (new Set(rs).size === 3) {
    if (rs[2] - rs[0] === 2) straight = true;
    else if (rs[0] === 1 && rs[1] === 12 && rs[2] === 13) straight = true; // Q K A
    else if (rs[0] === 1 && rs[1] === 2 && rs[2] === 3) { straight = true; high = [3, 2, 1]; }
  }
  let cat = 1;
  if (trio) cat = 6;
  else if (straight && flush) cat = 5;
  else if (straight) cat = 4;
  else if (flush) cat = 3;
  else if (pair) {
    cat = 2;
    const p = rs[0] === rs[1] ? rs[0] : rs[1];
    const k = rs[0] === rs[1] ? rs[2] : rs[0];
    high = [p === 1 ? 14 : p, k === 1 ? 14 : k];
  }
  return { cat, high };
}

function compareHands(a, b) {
  if (a.cat !== b.cat) return a.cat > b.cat ? 1 : -1;
  for (let i = 0; i < Math.max(a.high.length, b.high.length); i++) {
    const x = a.high[i] || 0, y = b.high[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

const PAIR_PLUS_ODDS = { 2: 2, 3: 5, 4: 7, 6: 31, 5: 41 }; // cat -> odds (1:1,4:1,6:1,30:1,40:1)

const baccaratValue = (h) => h.reduce((s, c) => s + (c.rank >= 10 ? 0 : c.rank), 0) % 10;
const sumTotal = (h) => h.reduce((s, c) => s + c.rank, 0);

// result: { A:[3 cards], B:[3 cards] }  muflis=true inverts the winner
function evalTeen(sel, { A, B }, { muflis = false } = {}) {
  const ra = rankHand(A), rb = rankHand(B);
  let cmp = compareHands(ra, rb);
  if (muflis) cmp = -cmp;
  const [key, who] = sel.split(':'); // "playerA", "pairplus:A", "total:A", "baccarat:A", "redblack:red"
  const hand = who === 'B' ? B : A;
  switch (key) {
    case 'playerA': return cmp === 0 ? 'push' : bool(cmp > 0);
    case 'playerB': return cmp === 0 ? 'push' : bool(cmp < 0);
    case 'pairplus': return bool(rankHand(hand).cat >= 2); // payout via bet.odds
    case 'total': {
      const ta = sumTotal(A), tb = sumTotal(B);
      if (ta === tb) return 'half_loss';
      return bool(who === 'A' ? ta > tb : tb > ta);
    }
    case 'baccarat': {
      const va = baccaratValue(A), vb = baccaratValue(B);
      if (va === vb) return 'push';
      return bool(who === 'A' ? va > vb : vb > va);
    }
    case 'redblack': {
      const all = [...A, ...B];
      const reds = all.filter(isRed).length;
      return bool(who === 'red' ? reds >= 3 : all.length - reds >= 3);
    }
    default: throw new Error(`Unknown teen selection: ${sel}`);
  }
}

// ---------------------------------------------------------------- Roulette
function evalRoulette(sel, { number: n }) {
  const [key, arg] = sel.split(':');
  const x = Number(arg);
  if (key === 'straight') return bool(n === x);
  if (key === 'split' || key === 'street' || key === 'corner' || key === 'sixline') {
    return bool(arg.split('-').map(Number).includes(n));
  }
  if (n === 0) return 'lose'; // zero kills all outside bets
  switch (key) {
    case 'red': return bool(RED_SET.has(n));
    case 'black': return bool(!RED_SET.has(n));
    case 'even': return bool(n % 2 === 0);
    case 'odd': return bool(n % 2 === 1);
    case 'low': return bool(n >= 1 && n <= 18);
    case 'high': return bool(n >= 19 && n <= 36);
    case 'dozen': return bool(n > (x - 1) * 12 && n <= x * 12);
    case 'column': return bool(n % 3 === (x === 3 ? 0 : x));
    default: throw new Error(`Unknown roulette selection: ${sel}`);
  }
}

// ----------------------------------------------------------- Sic Bo / dice
// result: { dice:[d1,d2,d3] }
function evalSicBo(sel, { dice }) {
  const sum = dice.reduce((a, b) => a + b, 0);
  const triple = dice[0] === dice[1] && dice[1] === dice[2];
  const [key, arg] = sel.split(':');
  const x = Number(arg);
  switch (key) {
    case 'small': return bool(!triple && sum >= 4 && sum <= 10);
    case 'big': return bool(!triple && sum >= 11 && sum <= 17);
    case 'even': return bool(sum % 2 === 0);
    case 'odd': return bool(sum % 2 === 1);
    case 'anytriple': return bool(triple);
    case 'triple': return bool(triple && dice[0] === x);
    case 'double': return bool(dice.filter((d) => d === x).length >= 2);
    case 'sum': return bool(sum === x);
    case 'single': return bool(dice.includes(x));
    default: throw new Error(`Unknown sicbo selection: ${sel}`);
  }
}

// ------------------------------------------------------------------ 32 Cards
// result: { cards:{8:rank,9:rank,10:rank,11:rank} }  base points + card value
function evalCard32(sel, { cards }) {
  const score = {};
  [8, 9, 10, 11].forEach((p) => { score[p] = p + cards[p]; });
  const max = Math.max(...Object.values(score));
  const winners = Object.keys(score).filter((p) => score[p] === max);
  const p = sel.split(':')[1] || sel.replace('player', '');
  if (!winners.includes(String(p))) return 'lose';
  return winners.length > 1 ? 'push' : 'win';
}

// ------------------------------------------------------------- Andar Bahar
// result: { winner:'andar'|'bahar', cardsDealt:number }
function evalAndarBahar(sel, { winner, cardsDealt }) {
  if (sel === 'andar' || sel === 'bahar') return bool(winner === sel);
  const m = sel.match(/^cards:(\d+)-(\d+)$/); // cards:1-5 ... cards:41-999
  if (m) return bool(cardsDealt >= Number(m[1]) && cardsDealt <= Number(m[2]));
  throw new Error(`Unknown andar bahar selection: ${sel}`);
}

// -------------------------------------------------------------------- Matka
// result: { open:digit, close:digit, openPana:'147', closePana:'258' }
function evalMatka(sel, r) {
  const [key, arg] = sel.split(':');
  switch (key) {
    case 'single': return bool(Number(arg) === r.open || Number(arg) === r.close);
    case 'jodi': return bool(arg === `${r.open}${r.close}`);
    case 'pana': return bool(arg === r.openPana || arg === r.closePana);
    default: throw new Error(`Unknown matka selection: ${sel}`);
  }
}

// ------------------------------------------------------------- dispatcher
function evaluateSelection(slug, selection, result) {
  switch (familyOf(slug)) {
    case 'lucky7': return evalLucky7(selection, result);
    case 'aaa': return evalAAA(selection, result);
    case 'dt': return evalDragonTiger(selection, result);
    case 'baccarat': return evalBaccarat(selection, result);
    case 'teen': return evalTeen(selection, result);
    case 'muflis': return evalTeen(selection, result, { muflis: true });
    case 'roulette': return evalRoulette(selection, result);
    case 'sicbo': return evalSicBo(selection, result);
    case 'card32': return evalCard32(selection, result);
    case 'andarbahar': return evalAndarBahar(selection, result);
    case 'matka': return evalMatka(selection, result);
    default: throw new Error(`Game not supported yet: ${slug}`);
  }
}

// -------------------------------------------------------------- nation book
/**
 * Live P&L per scenario. scenarios = [{ id, result }]
 * pnl(scenario) = sum over bets of (payout - exposure)  -> works for every market
 * incl. half-loss, push and lay, so no hand-written formula can drift.
 */
function nationBook(slug, bets, scenarios) {
  const book = {};
  for (const sc of scenarios) {
    let pnl = 0;
    for (const bet of bets) {
      const o = evaluateSelection(slug, bet.selection, sc.result);
      pnl += settleBet(bet, o).net;
    }
    book[sc.id] = round2(pnl);
  }
  return book;
}

const c = (rank, suit = 'S') => ({ rank, suit });
/** Main-runner scenarios for the live book (cards are representative). */
function defaultScenarios(slug) {
  switch (familyOf(slug)) {
    case 'dt': return [
      { id: 'dragon', result: { dragon: c(10), tiger: c(3) } },
      { id: 'tiger', result: { dragon: c(3), tiger: c(10) } },
      { id: 'tie', result: { dragon: c(7), tiger: c(7) } },
    ];
    case 'teen': return [
      { id: 'A', result: { A: [c(13), c(13, 'H'), c(2)], B: [c(9), c(5, 'H'), c(2, 'C')] } },
      { id: 'B', result: { A: [c(9), c(5, 'H'), c(2, 'C')], B: [c(13), c(13, 'H'), c(2)] } },
    ];
    case 'lucky7': return [
      { id: 'low', result: { card: c(3) } },
      { id: 'seven', result: { card: c(7) } },
      { id: 'high', result: { card: c(10) } },
    ];
    case 'aaa': return [
      { id: 'amar', result: { card: c(3) } },
      { id: 'akbar', result: { card: c(8) } },
      { id: 'anthony', result: { card: c(12) } },
    ];
    case 'baccarat': return [
      { id: 'player', result: { playerPoints: 8, bankerPoints: 3 } },
      { id: 'banker', result: { playerPoints: 3, bankerPoints: 8 } },
      { id: 'tie', result: { playerPoints: 5, bankerPoints: 5 } },
    ];
    default: return [];
  }
}

// -------------------------------------------------------------- statistics
const pct = (n, total) => (total ? round2((n / total) * 100) : 0);

function baccaratStats(history) { // history: ['p'|'b'|'t']
  const n = history.length;
  const cnt = (k) => history.filter((x) => x === k).length;
  return { p: pct(cnt('p'), n), b: pct(cnt('b'), n), t: pct(cnt('t'), n) };
}

function dragonTigerStats(history) { // history: ['D'|'T'|'TIE']
  const n = history.length;
  const cnt = (k) => history.filter((x) => x === k).length;
  let streak = 0;
  for (let i = n - 1; i >= 0 && history[i] === history[n - 1]; i--) streak++;
  return { dragon: pct(cnt('D'), n), tiger: pct(cnt('T'), n), tie: pct(cnt('TIE'), n), streak: { side: history[n - 1] || null, length: streak } };
}

function lucky7Stats(ranks) {
  const n = ranks.length;
  return {
    low: pct(ranks.filter((r) => r < 7).length, n),
    high: pct(ranks.filter((r) => r > 7).length, n),
    seven: pct(ranks.filter((r) => r === 7).length, n),
  };
}

function rouletteStats(numbers) {
  const n = numbers.length;
  const freq = Array(37).fill(0);
  numbers.forEach((x) => { freq[x]++; });
  const order = [...freq.keys()].sort((a, b) => freq[b] - freq[a]);
  const nz = numbers.filter((x) => x > 0);
  return {
    dozen: [1, 2, 3].map((d) => pct(nz.filter((x) => x > (d - 1) * 12 && x <= d * 12).length, n)),
    column: [1, 2, 3].map((k) => pct(nz.filter((x) => x % 3 === (k === 3 ? 0 : k)).length, n)),
    red: pct(nz.filter((x) => RED_SET.has(x)).length, n),
    black: pct(nz.filter((x) => !RED_SET.has(x)).length, n),
    odd: pct(nz.filter((x) => x % 2 === 1).length, n),
    even: pct(nz.filter((x) => x % 2 === 0).length, n),
    low: pct(nz.filter((x) => x <= 18).length, n),
    high: pct(nz.filter((x) => x >= 19).length, n),
    hot: order.slice(0, 5),
    cold: order.slice(-5).reverse(),
  };
}

export {
  GAME_FAMILY, familyOf, getLimits,
  calcExposure, validateBet, settleBet, evaluateSelection, nationBook, defaultScenarios,
  rankHand, compareHands, PAIR_PLUS_ODDS,
  baccaratStats, dragonTigerStats, lucky7Stats, rouletteStats,
};