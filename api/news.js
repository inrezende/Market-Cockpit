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
   mesma resposta, sem nova chamada. Cache de 6h de propósito, casando com o
   ritmo de atualização do /api/market-data: notícia não muda a cada poucos
   minutos, e cada hit a menos na GDELT é um hit a menos batendo no rate
   limit dela (que é global, compartilhado com qualquer outro projeto do
   mundo usando a mesma API — não é algo que a gente controle só ajustando
   nosso próprio ritmo de chamadas).
   ============================================================ */

const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
// 6h para casar com o cooldown de FORCE_CACHE_SECONDS do /api/market-data: as duas fontes de
// dado do dashboard (cotações e notícias) ficam "frescas" no mesmo ritmo aos olhos do usuário.
const CACHE_SECONDS = 6 * 60 * 60;
const STALE_SECONDS = 1800; // mesma janela de segurança usada em /api/market-data (SCHEDULE_STALE_SECONDS)
const FETCH_TIMEOUT_MS = 8000; // por tentativa — deixa espaço pro retry dentro do limite da function
const RATE_LIMIT_RETRY_DELAY_MS = 5500; // GDELT pede "1 a cada 5s"; espera um pouco mais que isso

const NEWS_QUERY = {
  USDBRL: 'dollar real Brazil exchange rate', EURBRL: 'euro real Brazil exchange rate',
  IGPM: 'IGP-M Brazil inflation index', IPCA: 'IPCA Brazil inflation', SELIC: 'Selic interest rate Brazil',
  XAU: 'gold price', XAG: 'silver price', XPT: 'platinum price', XPD: 'palladium price', HG: 'copper price',
  NI: 'nickel price', XCO: 'cobalt price', XMO: 'molybdenum price',
  HRC: 'hot rolled coil steel price', INOX: 'stainless steel price', ENXOFRE: 'sulfur price',
  H2SO4: 'sulfuric acid price', NAOH: 'caustic soda price', BTC: 'bitcoin price', ETH: 'ethereum price',
};

// Marca se o texto bateu com o aviso de rate-limit que a própria GDELT devolve (não-JSON,
// "please limit requests to one every 5 seconds"). A GDELT sinaliza rate limit dos dois jeitos:
// às vezes com HTTP 429 de verdade, às vezes com HTTP 200 e esse texto solto no corpo.
function isGdeltRateLimitText(text) {
  return /limit requests/i.test(text);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try { res = await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

function isRateLimited(attempt) {
  return attempt.status === 429 || isGdeltRateLimitText(attempt.text);
}

async function fetchJSON(url) {
  let attempt = await fetchOnce(url);

  // Uma colisão isolada com o rate limit da GDELT (por ex. outro projeto qualquer no mundo
  // batendo nela no mesmo instante) não significa que não dá pra buscar a notícia — só que
  // precisa esperar a janela de 5s passar. Por isso tenta de novo antes de desistir.
  if (isRateLimited(attempt)) {
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    attempt = await fetchOnce(url);
  }

  if (isRateLimited(attempt)) {
    const err = new Error('GDELT pediu para aguardar (rate limit) — sem notícias desta vez, mesmo após nova tentativa');
    err.softFail = true;
    throw err;
  }

  let data;
  try { data = JSON.parse(attempt.text); }
  catch {
    throw new Error(`GDELT: resposta não-JSON (HTTP ${attempt.status}): "${attempt.text.trim().slice(0, 150)}"`);
  }
  if (!attempt.ok) throw new Error(`GDELT: HTTP ${attempt.status}`);
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
    if (e.softFail) {
      // Cache curto (1 min): se alguém tentar de novo logo em seguida, não martela a GDELT
      // de novo enquanto o rate limit dela ainda estiver valendo.
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');
      res.status(200).json({ items: [], message: e.message });
      return;
    }
    res.status(500).json({ error: e.message || 'Falha ao buscar notícias' });
  }
};
