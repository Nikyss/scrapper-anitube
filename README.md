# AniTube Chromium Helper

Automação em Chromium para mapear episódios do AniTube, detectar a qualidade desejada, gerar manifestos e, opcionalmente, preparar abas do FetchV com nomes verificados (`01`, `02`, `03`...).

## O que mudou na versão 1.1

- O número do episódio é lido dos rótulos do site. O ID interno de `/video/194140`, por exemplo, fica separado e nunca vira o nome do episódio.
- O FetchV é bloqueado quando há número desconhecido, duplicado, fonte repetida ou mídia incompatível. O programa não usa mais a posição da lista para “adivinhar” um nome.
- A mídia capturada precisa corresponder ao ID do vídeo do episódio. Vídeos publicitários, URLs de anúncios e MP4 pequenos não verificados são ignorados.
- O storage de cada aba do FetchV é limpo antes da captura. A aba do downloader confirma um identificador único antes de qualquer renomeação.
- Cada página de captura também observa sua própria resposta de mídia, sem depender apenas do storage compartilhado do FetchV. Episódios que falham no lote paralelo são repetidos isoladamente.
- O mapeamento usa até quatro páginas em paralelo e a captura FetchV usa até três abas em paralelo. A fila global e a renomeação do FetchV continuam seriais para não cruzar episódios.
- Esperas genéricas por `networkidle` foram substituídas por sinais específicos da página e do storage do FetchV.
- O uBlock Origin Lite instalado no Chrome é copiado para o perfil automatizado e carregado junto com o FetchV. Há também um bloqueio de rede complementar para domínios publicitários conhecidos.

## Requisitos

- Node.js 18 ou mais recente.
- Google Chrome.
- [FetchV Video Downloader](https://chromewebstore.google.com/detail/fetchv-video-downloader-f/nfmmmhanepmpifddlkkmihkalkoekpfd?hl=pt-BR) instalado no perfil `Default` do Chrome.
- [uBlock Origin Lite oficial](https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh?hl=pt-BR), oferecido por Raymond Hill (gorhill), instalado no mesmo perfil.
- Opcional: [Dark Reader](https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh?hl=pt-BR).

Não é necessário instalar essas extensões manualmente no Chromium do Playwright. O programa encontra as versões do Chrome, copia cada uma para uma pasta local sem os metadados da Web Store e carrega as cópias no perfil isolado da automação.

## Uso

```powershell
npm install
npx playwright install chromium
npm start
```

Também é possível usar:

```powershell
.\Iniciar Scrapper.bat
```

O programa pergunta:

1. Se deve limpar os resultados antigos de `output`.
2. URL do anime.
3. Qualidade desejada (`SD`, `HD`, `FULLHD` etc.).
4. Se deve preparar as abas do FetchV.
5. Caso não use FetchV, se deve apenas abrir os links selecionados.

Os resultados são gravados em `output/episodes.json` e `output/episodes.csv`. O manifesto inclui `episode`, `videoId`, URL da página, fonte escolhida e filename.

## Como a proteção contra episódios trocados funciona

O AniTube usa URLs como `/video/194140`; `194140` é o ID interno da mídia, não o número do episódio. O programa mantém as duas identidades separadas:

- rótulo `EP 01` → episódio `1` → filename `01`;
- URL `/video/194140` → `videoId` `194140`;
- mídia esperada → URL que contém `194140` (ou a fonte direta exata).

Antes do FetchV começar, todos os números e nomes precisam ser conhecidos e únicos. Durante a captura, a mídia precisa passar pelas verificações de identidade. Se algo for ambíguo, esse episódio não ganha uma aba renomeada.

## Desempenho e séries longas

Por padrão:

- páginas de listagem conhecidas são buscadas sem sondar até 200 páginas vazias;
- fontes dos episódios são mapeadas com concorrência `4`;
- capturas do FetchV usam concorrência `3`;
- cada tentativa de captura espera até `15` segundos e estabiliza os candidatos por `2,5` segundos;
- a abertura/renomeação do downloader é serial porque o FetchV possui uma única chave global `queue`.
- somente conflitos de aba/storage recebem nova tentativa isolada, limitada a três episódios, uma navegação de `15` segundos e uma espera de mídia de até `10` segundos, evitando tornar séries longas inteiramente sequenciais.

Os resultados de pools concorrentes são preservados na ordem correta dos episódios.

## Bloqueio de anúncios

O uBlock Origin Lite é carregado como defesa inicial. A automação também bloqueia requisições para redes publicitárias conhecidas e dá `play()` em no máximo um vídeo visível e compatível, em vez de iniciar todos os players e anúncios da página.

Um MP4 pequeno só é aceito quando sua URL comprova a identidade do episódio. HLS ou MP4 que não contenham o ID esperado são rejeitados por padrão. Isso pode ser relaxado com uma variável de ambiente, mas reduz a segurança contra episódios trocados.

## Variáveis úteis

- `FETCHV_PREPARE=1`: prepara as abas do FetchV sem perguntar.
- `FETCHV_EXTENSION_PATH=C:\caminho\da\extensao`: informa manualmente a pasta do FetchV.
- `FETCHV_EXTENSION_ID=nfmmmhanepmpifddlkkmihkalkoekpfd`: informa manualmente o ID do FetchV.
- `UBLOCK_ORIGIN_LITE_EXTENSION_PATH=C:\caminho\da\extensao`: informa manualmente a pasta do uBlock Origin Lite.
- `UBLOCK_ORIGIN_LITE_EXTENSION_ID=ddkjiahejlhfcafbddmgiahcphecmpfh`: sobrescreve o ID usado na detecção.
- `DARK_READER_EXTENSION_PATH=C:\caminho\da\extensao`: informa manualmente a pasta do Dark Reader.
- `ANITUBE_MAPPING_CONCURRENCY=4`: quantidade de páginas usadas para mapear fontes (1 a 8).
- `FETCHV_CAPTURE_CONCURRENCY=3`: quantidade de capturas simultâneas (1 a 6).
- `FETCHV_CAPTURE_TIMEOUT_MS=15000`: tempo máximo de cada tentativa.
- `FETCHV_CAPTURE_SETTLE_MS=2500`: janela para aguardar candidatos melhores antes de selecionar.
- `FETCHV_ISOLATED_RETRY_LIMIT=3`: máximo de conflitos repetidos isoladamente após o lote paralelo (`0` desliga).
- `FETCHV_MIN_VIDEO_BYTES=20971520`: tamanho mínimo padrão para mídia não-HLS sem identidade forte (20 MiB).
- `FETCHV_ALLOW_UNVERIFIED_MEDIA=1`: aceita mídia sem o ID esperado; use somente para diagnóstico.
- `FETCHV_KEEP_SOURCE_TABS=1`: mantém abertas as abas temporárias de captura.
- `FETCHV_DEBUG=1`: mostra respostas e falhas de rede ligadas ao ID esperado.
- `FETCHV_DOWNLOAD_DIR=C:\Users\seu-usuario\Downloads`: pasta usada caso um download seja iniciado manualmente.
- `FETCHV_LANG=pt`: idioma da página do downloader FetchV.
- `ANITUBE_BLOCK_ADS=0`: desliga apenas o bloqueio de rede complementar; não desativa o uBlock carregado.
- `ANITUBE_HOST_IP=104.21.94.138`: força um IP para o AniTube.
- `ANITUBE_PUBLIC_DNS_SERVERS=1.1.1.1,8.8.8.8`: altera os DNS usados no fallback.
- `ANITUBE_DISABLE_DNS_FALLBACK=1`: desliga o fallback automático de DNS.
- `ANITUBE_NAVIGATION_ATTEMPTS=2`: quantidade de tentativas por URL.
- `ANITUBE_MAX_LISTING_PAGES=200`: limite de segurança para a paginação anunciada pelo anime.
- `ANITUBE_URL=https://...`: informa a URL sem perguntar.
- `QUALITY_CHOICE=2`: escolhe a qualidade sem perguntar.
- `OPEN_LINKS=s`: abre as fontes selecionadas quando o preparo do FetchV estiver desligado.
- `CLEAN_OUTPUT=s`: limpa a pasta `output` antes de começar.

Exemplo:

```powershell
$env:FETCHV_PREPARE = "1"
$env:QUALITY_CHOICE = "2"
$env:FETCHV_CAPTURE_CONCURRENCY = "3"
npm start
```

## Verificação

```powershell
npm run check
npm test
```

Os testes cobrem formatos de número, separação entre episódio e ID interno, conflitos/duplicatas, anúncios pequenos, mídia de outro episódio e preservação da ordem sob concorrência, incluindo um lote simulado de 48 episódios.

## Solução de problemas

- **Extensão não encontrada:** confirme que ela está instalada no perfil `Default` do Chrome ou informe o caminho com a variável correspondente.
- **`ERR_NAME_NOT_RESOLVED`:** o programa tenta `www.anitube.vip` e `anitube.vip` e usa DNS público como fallback. Ajuste as variáveis de DNS se necessário.
- **Mídia ignorada:** confira o log. O comportamento padrão é falhar de modo seguro quando a URL capturada não contém o ID do episódio. Não ative `FETCHV_ALLOW_UNVERIFIED_MEDIA` em uma execução grande sem conferir manualmente.
- **Chromium ausente:** execute `npx playwright install chromium`.
- **Poucos recursos no computador:** reduza `ANITUBE_MAPPING_CONCURRENCY` e `FETCHV_CAPTURE_CONCURRENCY`.

## Limitações e segurança

O programa prepara as abas, mas não clica no botão final de download. Revise cada aba antes de iniciar qualquer arquivo. Caminhos customizados de extensão carregam código local com as permissões da extensão; use apenas extensões oficiais e um perfil isolado. Respeite os direitos autorais, os termos do site e as leis aplicáveis ao conteúdo acessado.
