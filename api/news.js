/* ============================================================
   /api/news?key=XXX — notícias recentes de um ativo (GDELT).
   Separado do /api/market-data porque só é chamado quando alguém abre a
   gaveta de detalhe de um ativo específico (não em todo carregamento da
   página), e porque a GDELT já pede explicitamente no corpo da resposta
   "please limit requests to one every 5 seconds" — rodar isso para os 20
   ativos de uma vez, dentro de /api/market-data, estouraria esse limite e o
   tempo de execução da function.

   Cache de CDN por chave de ativo: a primeira pessoa que abre o card do
   Bitcoin, por exemplo, paga o custo de 1 chamada à GDELT; todas as outras
   pessoas que abrirem o card do Bitcoin dentro da janela de cache recebem a
   mesma resposta, sem nova chamada.
   ============================================================ */

const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const CACHE_SECONDS = 600; // 10 min
const STALE_SECONDS = 1200;
const FETCH_TIMEOUT_MS = 12000;

const NEWS_QUERY = {
  USDBRL: 'dollar real Brazil exchange rate', EURBRL: 'euro real Brazil exchange rate',
  IGPM: 'IGP-M Brazil inflation index', IPCA: 'IPCA Brazil inflation', SELIC: 'Selic interest rate Brazil',
  XAU: 'gold price', XAG: 'silver price', XPT: 'platinum price', XPD: 'palladium price', HG: 'copper price',
  NI: 'nickel price', XCO: 'cobalt price', XMO: 'molybdenum price',
  HRC: 'hot rolled coil steel price', INOX: 'stainless steel price', ENXOFRE: 'sulfur price',
  H2SO4: 'sulfuric acid price', NAOH: 'caustic soda price', BTC: 'bitcoin price', ETH: 'ethereum price',
};

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try { res = await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`GDELT: resposta não-JSON (HTTP ${res.status}): "${text.trim().slice(0, 150)}"`); }
  if (!res.ok) throw new Error(`GDELT: HTTP ${res.status}`);
  return data;
}

module.exports = async (req, res) => {
  const key = String(req.query.key || '').toUpperCase();
  const q = NEWS_QUERY[key];
  if (!q) { res.status(400).json({ error: 'Parâmetro "key" ausente ou inválido' }); return; }
  try {
    const url = `${GDELT}?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=5&format=json&sort=datedesc&timespan=10d`;
    const data = await fetchJSON(url);
    const items = ((data && data.articles) || []).map(a => ({ title: a.title, url: a.url, domain: a.domain, date: a.seendate }));
    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`);
    res.status(200).json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Falha ao buscar notícias' });
  }
};
