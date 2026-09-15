# Cockpit de Inteligência de Mercado para Compras

Portal analítico de câmbio, metais, químicos e cripto voltado para decisões de compras — página única (dark mode), sem chat/copilot, com dados reais de mercado (nunca mock). Quando uma fonte falha, o card mostra o motivo técnico, não um número inventado.

## Arquitetura

O site é 100% estático no client (`index.html`) e consome dois endpoints serverless próprios, hospedados no mesmo domínio (Vercel):

```
index.html  ──▶  /api/market-data   (cotações + histórico de todos os ativos)
            ──▶  /api/news?key=XXX  (notícias recentes de 1 ativo, sob demanda)
```

O client **nunca** chama as APIs externas diretamente — só esses dois endpoints. Isso existe porque, com o link compartilhado por vários usuários, uma arquitetura 100% client-side multiplicava as chamadas às fontes externas por N (um usuário = todas as chamadas de novo). Rodando no servidor, com cache de CDN, é sempre 1 chamada real por janela de cache, não importa quantas pessoas abram o site.

### `/api/market-data.js`

Agrega no servidor as cotações de todos os ativos, com fallback em cadeia por fonte:

| Ativo | Fonte principal | Fallback |
|---|---|---|
| USD/BRL, EUR/BRL | Frankfurter | AwesomeAPI |
| Ouro/Prata/Platina/Paládio/Cobre | MetalpriceAPI (se houver chave paga) | Gold-API |
| Níquel/Cobalto/Molibdênio | MetalpriceAPI (exige plano pago) | — (card "sem fonte" se não houver chave) |
| HRC Steel, Enxofre | Trading Economics (API, se houver chave) | Extração da página pública da Trading Economics |
| IGP-M, IPCA, Selic | Banco Central (SGS) | — (fonte oficial única) |
| BTC, ETH | CoinGecko | Binance |
| Aço Inox, Ácido Sulfúrico, Soda Cáustica | — sem API gratuita ou paga identificada; card fixo "sem fonte disponível" | |

O histórico devolvido cobre sempre os últimos 365 dias; trocar o período no gráfico (1M/3M/6M/12M) é um recorte feito no client, sem gerar chamada de rede nova.

**Cache/agenda:** em vez de cache de duração fixa, a resposta normal fica válida até o próximo horário de corte (8h ou 16h, horário de Brasília) — as fontes externas só são consultadas de novo nesses 2 horários por dia. Isso existe porque a MetalpriceAPI (plano pago) tem limite de 1000 requests/mês. O botão "Atualizar Dados" bypassa a agenda (`?force=1`) mas a própria resposta forçada fica em cache por 6h — funciona como cooldown compartilhado entre todos os usuários, sem precisar de banco de dados.

### `/api/news.js`

Busca as notícias recentes de **um** ativo por vez (GDELT), só quando alguém abre a gaveta de detalhe daquele ativo — nunca para os 20 de uma vez, porque a GDELT pede explicitamente no máximo 1 requisição a cada 5 segundos.

- **Rate limit da GDELT:** ela sinaliza de duas formas — HTTP 429 "de verdade" ou HTTP 200 com um aviso em texto solto no corpo. As duas são tratadas como a mesma coisa (soft-fail: `{ items: [] }` com HTTP 200, nunca 500).
- **Retry com backoff:** ao levar rate limit, espera ~5.5s e tenta de novo uma vez antes de desistir — cobre o caso comum de colisão passageira com outro tráfego qualquer batendo na mesma API pública.
- **Cache:** 6h por chave de ativo, casando com o ritmo de atualização do `/api/market-data` (cooldown de 6h do botão manual).

## UI

- Grade de ativos dividida em 3 seções: Mercado, Metais, Químicos.
- Clicar num ativo abre uma **gaveta lateral** (não seção inline) com card em destaque, alertas/insights, gráfico, tabela e notícias recentes — sem rolar a página.
- **Configurações** (preferências) ficam num modal separado, atrás de um ícone de engrenagem — não aparecem na tela principal.
- Favoritar ativos (fixa no topo da grade), período padrão do gráfico e intervalo de atualização automática são configuráveis e persistidos via `localStorage` do navegador de cada usuário.

## Variáveis de ambiente (Vercel → Project Settings → Environment Variables)

| Variável | Obrigatória? | Efeito se ausente |
|---|---|---|
| `METALPRICE_API_KEY` | Não (tem fallback fixo no código) | Sem ela, Níquel/Cobalto/Molibdênio ficam sem fonte; metais tier 1 caem no Gold-API |
| `TRADINGECONOMICS_API_KEY` | Não | HRC Steel/Enxofre usam só a extração da página pública (fonte marcada como instável) |

Nenhuma chave de API fica exposta no HTML público — todas vivem só no servidor.

## Deploy

Hospedado no Vercel. `vercel.json` define `maxDuration` estendido para as duas functions (`api/market-data.js`, `api/news.js`), necessário por causa do retry com espera do `/api/news` e das chamadas em cadeia (fonte principal → fallback) do `/api/market-data`.

## Limitações conhecidas

- Aço Inox, Ácido Sulfúrico e Soda Cáustica: nenhuma fonte (gratuita ou paga) identificada até o momento.
- HRC Steel/Enxofre sem chave paga da Trading Economics dependem de extração da página pública — fonte instável por natureza, sinalizada como tal na UI.
- Rede de algumas empresas pode bloquear DNS para `api.gold-api.com` (bloqueio de firewall corporativo, não bug do site).
