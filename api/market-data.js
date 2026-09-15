/* ============================================================
   /api/market-data — agrega TODAS as cotações no servidor.
   Roda no servidor (Vercel Serverless Function), não no navegador do usuário.
   O Vercel cacheia a resposta por CACHE_SECONDS (ver Cache-Control no fim do
   handler): enquanto o cache estiver válido, nenhum usuário dispara uma nova
   chamada às APIs externas — todos recebem a mesma resposta cacheada.

   Isso elimina o problema de "N usuários abrindo o link = N x M chamadas às
   APIs externas": agora é sempre 1 chamada a cada CACHE_SECONDS, não importa
   quantas pessoas abram o site ou o quão curto seja o auto-refresh de cada uma.

   Mesma lógica de fontes/fallback que já existia no client, só que executada
   aqui. Uma vantagem extra de rodar no servidor: não há mais restrição de CORS,
   então HRC Steel/Enxofre podem ler a página pública da Trading Economics
   diretamente, sem depender de um proxy de terceiro (allorigins.win) — que era
   o elo mais frágil da versão anterior.
   ============================================================ */

const FRANKFURTER = 'https://api.frankfurter.dev/v2';
const AWESOMEAPI = 'https://economia.awesomeapi.com.br';
const GOLDAPI = 'https://api.gold-api.com';
const METALPRICEAPI = 'https://api.metalpriceapi.com/v1';
const TRADINGECONOMICS = 'https://api.tradingeconomics.com';
const BCB_SGS = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs';
const COINGECKO = 'https://api.coingecko.com/api/v3';
const BINANCE = 'https://api.binance.com/api/v3';

// Configure isso no painel do Vercel (Project Settings -> Environment Variables).
// O fallback abaixo só existe para não quebrar o site no primeiro deploy — troque
// pela env var assim que possível, para poder trocar/revogar a chave sem reeditar código.
const METALPRICE_API_KEY = process.env.METALPRICE_API_KEY || '47a1826d834018ce941a1b7d37d2fffd';
const TRADINGECONOMICS_API_KEY = process.env.TRADINGECONOMICS_API_KEY || '';

// Histórico diário completo (sem downsample) coberto pelo maior período que a UI oferece (12M).
// O client é quem recorta esse array para 1M/3M/6M/12M — então trocar de período na tela não
// gera nenhuma chamada de rede nova.
const HISTORY_DAYS = 365;

// ---------- Agenda de atualização ----------
// Em vez de um cache de duração fixa (5 min), a resposta normal (/api/market-data) fica em
// cache até o próximo horário de corte (8h ou 16h, horário de Brasília) — ou seja, as fontes
// externas só são consultadas de novo exatamente nesses 2 horários por dia, não a cada N minutos.
// Isso existe porque a MetalpriceAPI (plano pago) tem limite de 1000 requests/mês e cada
// atualização completa consome ~5 dessas requests — com 2 atualizações automáticas por dia
// (~300-310/mês) sobra folga para o botão de atualização manual (ver abaixo).
const SCHEDULE_HOURS_BRT = [8, 16]; // horário de Brasília (UTC-3, sem horário de verão)
const SCHEDULE_STALE_SECONDS = 1800; // +30 min servindo versão antiga em segundo plano, por segurança

// Botão "Atualizar Dados": bypassa a agenda (chamado com ?force=1) e busca dado fresco na hora,
// mas a PRÓPRIA resposta fica em cache por 6h — como todos os usuários compartilham o mesmo link
// (e portanto a mesma URL/chave de cache), isso funciona como cooldown automático sem precisar de
// nenhum banco de dados: dentro das 6h, qualquer clique (de qualquer pessoa) recebe a mesma
// resposta cacheada em vez de gastar requests novas nas fontes externas.
const FORCE_CACHE_SECONDS = 6 * 60 * 60; // 6h

function nextScheduleBoundary(now) {
  // Converte "agora" para hora de Brasília usando o offset fixo (America/Sao_Paulo não tem mais
  // horário de verão desde 2019), sem depender de Intl/timezone do runtime.
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const candidates = SCHEDULE_HOURS_BRT.map(h => {
    const d = new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate(), h, 0, 0));
    return d;
  });
  // Também considera o primeiro horário do dia seguinte, caso já tenha passado o último de hoje.
  const tomorrowFirst = new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate() + 1, SCHEDULE_HOURS_BRT[0], 0, 0));
  candidates.push(tomorrowFirst);
  const nextBrt = candidates.filter(d => d.getTime() > brt.getTime()).sort((a, b) => a - b)[0];
  // Converte de volta para o instante real em UTC (soma os 3h que subtraímos acima).
  return new Date(nextBrt.getTime() + 3 * 60 * 60 * 1000);
}

const ASSET_META = {
  USDBRL: { kind: 'fx' },
   EURBRL: { kind: 'fx' },
  IGPM: { kind: 'macro', sgsCode: 28655 },
   IPCA: { kind: 'macro', sgsCode: 13522 },
   SELIC: { kind: 'macro', sgsCode: 432 },
  BTC: { kind: 'crypto', cgId: 'bitcoin', binanceSymbol: 'BTCUSDT' },
   ETH: { kind: 'crypto', cgId: 'ethereum', binanceSymbol: 'ETHUSDT' },
  XAU: { kind: 'metal' },
   XAG: { kind: 'metal' },
   XPT: { kind: 'metal' },
   XPD: { kind: 'metal' },
   HG: { kind: 'metal' },
  NI: { kind: 'metal' },
   XCO: { kind: 'metal' },
   XMO: { kind: 'metal' },
  HRC: { kind: 'metal', teSymbol: 'hrc-steel', sourceUrl: 'https://tradingeconomics.com/commodity/hrc-steel' },
  ENXOFRE: { kind: 'chemical', teSymbol: 'sulfur', sourceUrl: 'https://tradingeconomics.com/commodity/sulfur' },
};
const TIER1_METAL_SYMBOLS = ['XAU', 'XAG', 'XPT', 'XPD', 'HG'];
const TIER2_SYMBOLS = ['NI', 'XCO', 'XMO'];
const TE_SYMBOLS = ['HRC', 'ENXOFRE'];

const FETCH_TIMEOUT_MS = 12000;

async function fetchJSON(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...(opts || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Resposta não-JSON (HTTP ${res.status}) em ${url.split('?')[0]}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url.split('?')[0]}`);
  return data;
}
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IndiceReal/1.0)' } });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);
  return res.text();
}
function settleOne(fn) {
  return fn().then(value => ({ ok: true, value })).catch(err => ({ ok: false, value: null, error: err }));
}
function errText(res) {
  if (!res || res.ok) return null;
  const msg = res.error && res.error.message ? res.error.message : String(res.error || 'erro desconhecido');
  return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
}
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };
function isoToBcbDate(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }

// ---------- Câmbio ----------
function normalizeFrankfurterRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && raw.rates && typeof raw.rates === 'object') {
    const keys = Object.keys(raw.rates);
    if (!keys.length) return [];
    const first = raw.rates[keys[0]];
    if (typeof first === 'number') return keys.map(q => ({ date: raw.date, quote: q, rate: raw.rates[q] }));
    if (first && typeof first === 'object') {
      const rows = [];
      Object.keys(raw.rates).forEach(date => {
        const day = raw.rates[date] || {};
        Object.keys(day).forEach(q => rows.push({ date, quote: q, rate: day[q] }));
      });
      return rows;
    }
  }
  return [];
}
async function fetchFrankfurterSeries(base, quote, from, to) {
  const paramSets = [`from=${from}&to=${to}&base=${base}&quotes=${quote}`, `from=${from}&to=${to}&base=${base}&symbols=${quote}`];
  let lastErr = null;
  for (const params of paramSets) {
    try {
      const raw = await fetchJSON(`${FRANKFURTER}/rates?${params}`);
      const rows = normalizeFrankfurterRows(raw).filter(r => r.quote === quote);
      if (rows.length) return rows.map(r => ({ date: r.date, value: r.rate })).sort((a, b) => a.date.localeCompare(b.date));
      lastErr = new Error(`sem linhas de ${quote} no payload`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`Frankfurter: ${base}/${quote} indisponível`);
}
async function fetchAwesomeApiCurrent() {
  const data = await fetchJSON(`${AWESOMEAPI}/json/last/USD-BRL,EUR-BRL`);
  const usdBrl = data && data.USDBRL && data.USDBRL.bid ? parseFloat(data.USDBRL.bid) : null;
  const eurBrl = data && data.EURBRL && data.EURBRL.bid ? parseFloat(data.EURBRL.bid) : null;
  const ts = (data && data.USDBRL && data.USDBRL.create_date) || (data && data.EURBRL && data.EURBRL.create_date) || null;
  return { usdBrl: Number.isFinite(usdBrl) ? usdBrl : null, eurBrl: Number.isFinite(eurBrl) ? eurBrl : null, asOfDate: ts ? ts.slice(0, 10) : null };
}
async function fetchAwesomeApiDaily(pair, days) {
  const data = await fetchJSON(`${AWESOMEAPI}/json/daily/${pair}/${Math.min(days, 365)}`);
  if (!Array.isArray(data)) throw new Error('AwesomeAPI: resposta inesperada');
  return data.map(row => ({ date: row.create_date ? row.create_date.slice(0, 10) : null, value: parseFloat(row.bid) }))
    .filter(r => r.date && Number.isFinite(r.value)).sort((a, b) => a.date.localeCompare(b.date));
}
async function fetchFxCurrentBoth() {
  const [usdRes, eurRes] = await Promise.all([
    settleOne(() => fetchJSON(`${FRANKFURTER}/rate/USD/BRL`)),
    settleOne(() => fetchJSON(`${FRANKFURTER}/rate/EUR/BRL`)),
  ]);
  const usdBrl = usdRes.ok && usdRes.value && typeof usdRes.value.rate === 'number' ? usdRes.value.rate : null;
  const eurBrl = eurRes.ok && eurRes.value && typeof eurRes.value.rate === 'number' ? eurRes.value.rate : null;
  const asOfDate = (usdRes.ok && usdRes.value && usdRes.value.date) || (eurRes.ok && eurRes.value && eurRes.value.date) || null;
  if (usdBrl !== null || eurBrl !== null) return { usdBrl, eurBrl, asOfDate, source: 'Frankfurter API' };
  const fb = await settleOne(() => fetchAwesomeApiCurrent());
  if (fb.ok && (fb.value.usdBrl !== null || fb.value.eurBrl !== null)) return { ...fb.value, source: 'AwesomeAPI (fallback)' };
  throw new Error(`Frankfurter e AwesomeAPI indisponíveis (${errText(usdRes) || errText(eurRes) || 'sem detalhes'})`);
}
async function fetchFxHistoryBoth(days) {
  const from = daysAgoISO(days), to = todayISO();
  const [usdRes, eurRes] = await Promise.all([
    settleOne(() => fetchFrankfurterSeries('USD', 'BRL', from, to)),
    settleOne(() => fetchFrankfurterSeries('EUR', 'BRL', from, to)),
  ]);
  let usdBrlSeries = usdRes.ok ? usdRes.value : [];
  let eurBrlSeries = eurRes.ok ? eurRes.value : [];
  if (!usdBrlSeries.length) { const fb = await settleOne(() => fetchAwesomeApiDaily('USD-BRL', days)); if (fb.ok) usdBrlSeries = fb.value; }
  if (!eurBrlSeries.length) { const fb = await settleOne(() => fetchAwesomeApiDaily('EUR-BRL', days)); if (fb.ok) eurBrlSeries = fb.value; }
  return { usdBrlSeries, eurBrlSeries };
}

// ---------- Metais ----------
async function fetchMetalCurrent(symbol) {
  const data = await fetchJSON(`${GOLDAPI}/price/${symbol}/USD`);
  if (data == null || data.price == null) throw new Error('Gold-API: campo "price" ausente');
  return { price: data.price, asOf: data.updatedAt ? new Date(data.updatedAt) : null };
}
async function fetchMetalpriceLatest(symbols) {
  const url = `${METALPRICEAPI}/latest?api_key=${encodeURIComponent(METALPRICE_API_KEY)}&base=USD&currencies=${symbols.join(',')}`;
  const data = await fetchJSON(url);
  if (!data || data.success === false) {
    const err = data && data.error ? data.error : null;
    throw new Error(`MetalpriceAPI: ${err ? (err.info || err.message || JSON.stringify(err)) : 'resposta inesperada'}`);
  }
  if (!data.rates) throw new Error('MetalpriceAPI: resposta sem campo "rates"');
  return { rates: data.rates, asOf: data.timestamp ? new Date(data.timestamp * 1000) : null };
}
function extractMetalpriceRate(rates, sym) {
  const v = rates ? rates[sym] : null;
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return v.rate ?? v.current ?? v.price ?? v.value ?? null;
  return null;
}

// ---------- Trading Economics (HRC Steel, Enxofre) ----------
async function fetchTradingEconomicsCommodity(teSymbol) {
  const url = `${TRADINGECONOMICS}/commodity/${encodeURIComponent(teSymbol)}?c=${encodeURIComponent(TRADINGECONOMICS_API_KEY)}&format=json`;
  const data = await fetchJSON(url);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Trading Economics: resposta vazia');
  const price = row.Last ?? row.Close ?? row.Value ?? row.value ?? null;
  if (price == null || Number.isNaN(Number(price))) throw new Error(`Trading Economics: campo de preço ausente (${row.Message || row.message || JSON.stringify(row).slice(0, 150)})`);
  const dateStr = row.LastUpdate || row.CloseDate || row.Date || null;
  return { price: Number(price), asOf: dateStr ? new Date(dateStr) : null };
}
// Rodando no servidor não há CORS: lemos a página pública direto, sem proxy de terceiro.
function extractTeDescriptionFromHtml(html) {
  const m = /<meta[^>]+(?:property|name)="(?:og:description|twitter:description|description)"[^>]+content="([^"]*)"/i.exec(html)
    || /<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="(?:og:description|twitter:description|description)"/i.exec(html);
  if (!m) throw new Error('Não foi possível localizar a meta description no HTML (layout pode ter mudado)');
  return m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}
function parseTeDescription(desc) {
  const full = /to\s+([\d,]+\.?\d*)\s*([A-Za-z]{2,6}\/[A-Za-z%]+)?\s+on\s+([^,]+),\s*(down|up)\s+([\d.]+)%/i.exec(desc);
  if (full) return { price: parseFloat(full[1].replace(/,/g, '')), changePercent: full[4].toLowerCase() === 'down' ? -parseFloat(full[5]) : parseFloat(full[5]) };
  const simple = /to\s+([\d,]+\.?\d*)/i.exec(desc);
  if (simple) return { price: parseFloat(simple[1].replace(/,/g, '')), changePercent: null };
  throw new Error(`Não foi possível extrair um preço do texto (trecho: "${desc.slice(0, 120)}")`);
}
async function fetchTradingEconomicsScrape(pageUrl) {
  const html = await fetchText(pageUrl);
  const parsed = parseTeDescription(extractTeDescriptionFromHtml(html));
  if (!Number.isFinite(parsed.price)) throw new Error('Preço extraído não é um número válido');
  return parsed;
}

// ---------- BCB/SGS ----------
async function fetchBcbSgsSeries(code, days) {
  const dataInicial = isoToBcbDate(daysAgoISO(days)), dataFinal = isoToBcbDate(todayISO());
  const data = await fetchJSON(`${BCB_SGS}.${code}/dados?formato=json&dataInicial=${dataInicial}&dataFinal=${dataFinal}`);
  if (!Array.isArray(data)) throw new Error(`BCB/SGS: resposta inesperada para a série ${code}`);
  return data.map(row => {
    const [d, m, y] = (row.data || '').split('/');
    return { date: y && m && d ? `${y}-${m}-${d}` : null, value: parseFloat((row.valor || '').replace(',', '.')) };
  }).filter(r => r.date && Number.isFinite(r.value)).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Cripto ----------
async function fetchCryptoCurrentBatch(ids) {
  const data = await fetchJSON(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${ids.join(',')}&price_change_percentage=24h`);
  const map = {};
  (Array.isArray(data) ? data : []).forEach(c => { map[c.id] = c; });
  return map;
}
async function fetchCryptoHistory(id, days) {
  const data = await fetchJSON(`${COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
  const prices = (data && data.prices) || [];
  // Sem downsample: guardamos o histórico diário completo. É o client quem recorta por período,
  // então trocar 1M/3M/6M/12M na tela não gera nenhuma chamada de rede nova.
  return prices.map(([ts, price]) => ({ date: new Date(ts).toISOString().slice(0, 10), value: price }));
}
async function fetchBinanceCurrent(symbol) {
  const [tickerRes, statsRes] = await Promise.all([
    fetchJSON(`${BINANCE}/ticker/price?symbol=${symbol}`),
    settleOne(() => fetchJSON(`${BINANCE}/ticker/24hr?symbol=${symbol}`)),
  ]);
  const price = tickerRes && tickerRes.price ? parseFloat(tickerRes.price) : null;
  if (!Number.isFinite(price)) throw new Error('Binance: campo "price" ausente');
  const changePercent = statsRes.ok && statsRes.value && statsRes.value.priceChangePercent != null ? parseFloat(statsRes.value.priceChangePercent) : null;
  return { price, changePercent: Number.isFinite(changePercent) ? changePercent : null };
}

// ---------- Orquestração ----------
async function buildMarketData() {
  const data = {};
  const days = HISTORY_DAYS;

  const [fxCurrentRes, fxHistoryRes] = await Promise.all([settleOne(fetchFxCurrentBoth), settleOne(() => fetchFxHistoryBoth(days))]);
  const fxCurrent = fxCurrentRes.ok ? fxCurrentRes.value : { usdBrl: null, eurBrl: null, asOfDate: null };
  const fxHistory = fxHistoryRes.ok ? fxHistoryRes.value : { usdBrlSeries: [], eurBrlSeries: [] };
  const fxErrorMessage = !fxCurrentRes.ok ? errText(fxCurrentRes) : (!fxHistoryRes.ok ? errText(fxHistoryRes) : null);
  const usdBrlRate = fxCurrent.usdBrl;
  const fxAsOf = fxCurrent.asOfDate ? new Date(fxCurrent.asOfDate + 'T12:00:00').toISOString() : null;

  const fxDefs = { USDBRL: { current: fxCurrent.usdBrl, history: fxHistory.usdBrlSeries }, EURBRL: { current: fxCurrent.eurBrl, history: fxHistory.eurBrlSeries } };
  for (const key of Object.keys(fxDefs)) {
    const def = fxDefs[key];
    const isError = def.current === null && def.history.length === 0;
    const changePercent = def.history.length >= 2
      ? ((def.history.at(-1).value - def.history.at(-2).value) / def.history.at(-2).value) * 100 : null;
    data[key] = {
      priceUSD: null, priceBRL: def.current, changePercent, changeLabel: 'dia',
      asOf: fxAsOf, asOfDateOnly: true, history: def.history, error: isError,
      errorMessage: isError ? fxErrorMessage : null, needsKey: false,
      sourceLabel: fxCurrentRes.ok ? fxCurrent.source : null,
    };
  }

  const tasks = [];

  // Cripto
  const cryptoKeys = Object.keys(ASSET_META).filter(k => ASSET_META[k].kind === 'crypto');
  tasks.push((async () => {
    const currentBatch = await settleOne(() => fetchCryptoCurrentBatch(cryptoKeys.map(k => ASSET_META[k].cgId)));
    for (const key of cryptoKeys) {
      const meta = ASSET_META[key];
      const hist = await settleOne(() => fetchCryptoHistory(meta.cgId, days));
      const coin = currentBatch.ok ? currentBatch.value[meta.cgId] : null;
      if (coin) {
        data[key] = {
          priceUSD: coin.current_price, priceBRL: usdBrlRate ? coin.current_price * usdBrlRate : null,
          changePercent: coin.price_change_percentage_24h, changeLabel: '24h',
          asOf: coin.last_updated ? new Date(coin.last_updated).toISOString() : null, asOfDateOnly: false,
          history: hist.ok ? hist.value : [], error: false, errorMessage: null, needsKey: false, sourceLabel: 'CoinGecko',
        };
        continue;
      }
      const fb = await settleOne(() => fetchBinanceCurrent(meta.binanceSymbol));
      data[key] = {
        priceUSD: fb.ok ? fb.value.price : null, priceBRL: fb.ok && usdBrlRate ? fb.value.price * usdBrlRate : null,
        changePercent: fb.ok ? fb.value.changePercent : null, changeLabel: '24h',
        asOf: fb.ok ? new Date().toISOString() : null, asOfDateOnly: false,
        history: hist.ok ? hist.value : [], error: !fb.ok,
        errorMessage: !fb.ok ? (errText(fb) || errText(currentBatch)) : null, needsKey: false,
        sourceLabel: fb.ok ? 'Binance (fallback)' : null,
      };
    }
  })());

  // Metais tier 1 (Ouro/Prata/Platina/Paládio/Cobre)
  for (const key of TIER1_METAL_SYMBOLS) {
    tasks.push((async () => {
      if (METALPRICE_API_KEY) {
        const mpRes = await settleOne(() => fetchMetalpriceLatest([key]));
        const rate = mpRes.ok ? extractMetalpriceRate(mpRes.value.rates, key) : null;
        const priceUSD = rate ? 1 / rate : null;
        if (priceUSD !== null) {
          data[key] = { priceUSD, priceBRL: usdBrlRate ? priceUSD * usdBrlRate : null, changePercent: null, changeLabel: null, asOf: mpRes.value.asOf ? mpRes.value.asOf.toISOString() : null, asOfDateOnly: false, history: [], error: false, errorMessage: null, needsKey: false, sourceLabel: 'MetalpriceAPI' };
          return;
        }
        const gRes = await settleOne(() => fetchMetalCurrent(key));
        if (gRes.ok) {
          data[key] = { priceUSD: gRes.value.price, priceBRL: usdBrlRate ? gRes.value.price * usdBrlRate : null, changePercent: null, changeLabel: null, asOf: gRes.value.asOf ? gRes.value.asOf.toISOString() : null, asOfDateOnly: false, history: [], error: false, errorMessage: null, needsKey: false, sourceLabel: 'Gold-API (fallback)' };
          return;
        }
        data[key] = { priceUSD: null, priceBRL: null, changePercent: null, changeLabel: null, asOf: null, asOfDateOnly: false, history: [], error: true, errorMessage: `MetalpriceAPI: ${errText(mpRes)} · Gold-API: ${errText(gRes)}`, needsKey: false, sourceLabel: null };
        return;
      }
      const res = await settleOne(() => fetchMetalCurrent(key));
      data[key] = { priceUSD: res.ok ? res.value.price : null, priceBRL: res.ok && usdBrlRate ? res.value.price * usdBrlRate : null, changePercent: null, changeLabel: null, asOf: res.ok && res.value.asOf ? res.value.asOf.toISOString() : null, asOfDateOnly: false, history: [], error: !res.ok, errorMessage: !res.ok ? errText(res) : null, needsKey: false, sourceLabel: res.ok ? 'Gold-API' : null };
    })());
  }

  // Metais tier 2 (Níquel/Cobalto/Molibdênio — exigem plano pago)
  tasks.push((async () => {
    if (!METALPRICE_API_KEY) {
      TIER2_SYMBOLS.forEach(sym => { data[sym] = { priceUSD: null, priceBRL: null, changePercent: null, changeLabel: null, asOf: null, asOfDateOnly: false, history: [], error: false, errorMessage: null, needsKey: true }; });
      return;
    }
    const res = await settleOne(() => fetchMetalpriceLatest(TIER2_SYMBOLS));
    const rates = res.ok ? res.value.rates : null;
    const asOf = res.ok && res.value.asOf ? res.value.asOf.toISOString() : null;
    TIER2_SYMBOLS.forEach(sym => {
      const rate = res.ok ? extractMetalpriceRate(rates, sym) : null;
      const priceUSD = rate ? 1 / rate : null;
      const isError = !res.ok || rate == null;
      data[sym] = { priceUSD, priceBRL: priceUSD !== null && usdBrlRate ? priceUSD * usdBrlRate : null, changePercent: null, changeLabel: null, asOf: isError ? null : asOf, asOfDateOnly: false, history: [], error: isError, errorMessage: !res.ok ? errText(res) : (rate == null ? `Símbolo ${sym} não retornado pela MetalpriceAPI (plano atual pode não incluí-lo)` : null), needsKey: false };
    });
  })());

  // HRC Steel / Enxofre (Trading Economics)
  tasks.push((async () => {
    for (const key of TE_SYMBOLS) {
      const meta = ASSET_META[key];
      if (TRADINGECONOMICS_API_KEY) {
        const apiRes = await settleOne(() => fetchTradingEconomicsCommodity(meta.teSymbol));
        if (apiRes.ok) { data[key] = { priceUSD: apiRes.value.price, priceBRL: usdBrlRate ? apiRes.value.price * usdBrlRate : null, changePercent: null, changeLabel: null, asOf: apiRes.value.asOf ? apiRes.value.asOf.toISOString() : null, asOfDateOnly: false, history: [], error: false, errorMessage: null, needsKey: false, sourceLabel: 'Trading Economics (API)' }; continue; }
        const scrapeRes = await settleOne(() => fetchTradingEconomicsScrape(meta.sourceUrl));
        if (scrapeRes.ok) { data[key] = { priceUSD: scrapeRes.value.price, priceBRL: usdBrlRate ? scrapeRes.value.price * usdBrlRate : null, changePercent: scrapeRes.value.changePercent, changeLabel: scrapeRes.value.changePercent != null ? 'dia' : null, asOf: null, asOfDateOnly: false, history: [], error: false, errorMessage: null, needsKey: false, sourceLabel: 'Trading Economics (extraído da página pública — instável)' }; continue; }
        data[key] = { priceUSD: null, priceBRL: null, changePercent: null, changeLabel: null, asOf: null, asOfDateOnly: false, history: [], error: true, errorMessage: `API: ${errText(apiRes)} · Extração da página pública: ${errText(scrapeRes)}`, needsKey: false, sourceLabel: null };
        continue;
      }
      const scrapeRes = await settleOne(() => fetchTradingEconomicsScrape(meta.sourceUrl));
      if (scrapeRes.ok) { data[key] = { priceUSD: scrapeRes.value.price, priceBRL: usdBrlRate ? scrapeRes.value.price * usdBrlRate : null, changePercent: scrapeRes.value.changePercent, changeLabel: scrapeRes.value.changePercent != null ? 'dia' : null, asOf: null, asOfDateOnly: false, history: [], error: false, errorMessage: null, needsKey: false, sourceLabel: 'Trading Economics (extraído da página pública — instável)' }; continue; }
      data[key] = { priceUSD: null, priceBRL: null, changePercent: null, changeLabel: null, asOf: null, asOfDateOnly: false, history: [], error: true, errorMessage: `Extração da página pública falhou (${errText(scrapeRes)}). Uma chave paga da Trading Economics (env var TRADINGECONOMICS_API_KEY) tende a ser mais confiável.`, needsKey: false, sourceLabel: null };
    }
  })());

  // IGP-M / IPCA / Selic (BCB)
  tasks.push((async () => {
    for (const key of Object.keys(ASSET_META).filter(k => ASSET_META[k].kind === 'macro')) {
      const meta = ASSET_META[key];
      const res = await settleOne(() => fetchBcbSgsSeries(meta.sgsCode, days));
      const series = res.ok ? res.value : [];
      const last = series.at(-1), prev = series.at(-2);
      const changePercent = last && prev ? ((last.value - prev.value) / prev.value) * 100 : null;
      data[key] = { priceUSD: null, priceBRL: last ? last.value : null, changePercent, changeLabel: 'mês anterior', asOf: last ? new Date(last.date + 'T12:00:00').toISOString() : null, asOfDateOnly: true, history: series, error: !res.ok || !last, errorMessage: !res.ok ? errText(res) : (!last ? 'BCB/SGS: série sem pontos retornados' : null), needsKey: false };
    }
  })());

  await Promise.all(tasks);
  const now = new Date();
  const nextScheduledAt = nextScheduleBoundary(now).toISOString();
  return { usdBrlRate, data, generatedAt: now.toISOString(), nextScheduledAt };
}

module.exports = async (req, res) => {
  const forced = req.query && (req.query.force === '1' || req.query.force === 'true');
  try {
    const payload = await buildMarketData();
    if (forced) {
      // Resposta do botão manual: cacheada por 6h, funcionando como cooldown compartilhado
      // entre todos os usuários (ver comentário de FORCE_CACHE_SECONDS acima).
      res.setHeader('Cache-Control', `public, s-maxage=${FORCE_CACHE_SECONDS}, stale-while-revalidate=60`);
    } else {
      const secondsUntilNext = Math.max(60, Math.round((new Date(payload.nextScheduledAt).getTime() - Date.now()) / 1000));
      res.setHeader('Cache-Control', `public, s-maxage=${secondsUntilNext}, stale-while-revalidate=${SCHEDULE_STALE_SECONDS}`);
    }
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Falha ao montar dados de mercado' });
  }
};
