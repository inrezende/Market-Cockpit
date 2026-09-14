[LEIA-ME-DEPLOY.md](https://github.com/user-attachments/files/32201625/LEIA-ME-DEPLOY.md)
# Deploy no Vercel

Estrutura:
```
index.html          <- página (sem mudança de UI/visual)
api/market-data.js   <- roda no servidor, agrega todas as cotações, cache de 5 min
api/news.js           <- roda no servidor, notícias por ativo, cache de 10 min
```

## Passos

1. Suba estes 3 arquivos/pastas no mesmo repositório/projeto Vercel que já hospeda o site
   (pode substituir o `index.html` atual direto).
2. No painel do Vercel: **Project Settings → Environment Variables**, adicione:
   - `METALPRICE_API_KEY` = sua chave da MetalpriceAPI (opcional — se não configurar, usa o
     mesmo valor que já estava embutido no arquivo antigo, só que agora só existe no servidor)
   - `TRADINGECONOMICS_API_KEY` = sua chave da Trading Economics, se/quando comprar (opcional)
3. Redeploy.

## O que muda na prática

- O navegador do usuário não faz mais NENHUMA chamada direta a Frankfurter, Gold-API,
  MetalpriceAPI, Trading Economics, BCB, CoinGecko, Binance ou GDELT — só chama
  `/api/market-data` e `/api/news`, que são do seu próprio domínio Vercel.
- O Vercel cacheia essas respostas por 5 min (`market-data`) e 10 min (`news`). Enquanto o
  cache estiver válido, todo mundo que abrir o link recebe a mesma resposta pronta — as APIs
  externas só são chamadas de novo quando o cache expira, não a cada acesso.
- Trocar o período do gráfico (1M/3M/6M/12M) não gera nenhuma chamada de rede nova: o servidor
  já manda o histórico completo de 12 meses, e o recorte é feito no navegador.
- As chaves de API saíram do HTML público — agora só existem como variável de ambiente no
  servidor, nunca aparecem no código-fonte que qualquer pessoa com o link consegue ver.
- O modal de Configurações perdeu os campos de chave (não fazem mais sentido do lado do
  cliente); as preferências de favoritos, período padrão e auto-atualização continuam iguais.

## Ajustando o intervalo de cache

Em `api/market-data.js`, no topo do arquivo:
```js
const CACHE_SECONDS = 300;  // tempo que o Vercel serve a resposta cacheada
const STALE_SECONDS = 600;  // + tempo extra servindo versão antiga enquanto atualiza em 2º plano
```
Se quiser dados mais "ao vivo", baixe `CACHE_SECONDS` (ex.: 60) — lembre que isso aumenta a
frequência de chamadas às APIs externas proporcionalmente.
