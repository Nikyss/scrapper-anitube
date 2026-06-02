# AniTube Chromium Helper

Automacao em Chromium para mapear episodios de uma pagina de anime, detectar qualidades disponiveis no `abas_players`, gerar um manifesto com os links da qualidade escolhida e, opcionalmente, preparar abas do FetchV ja renomeadas.

## O que ele faz

- Varre a pagina de um anime no AniTube e coleta os episodios encontrados.
- Detecta as qualidades disponiveis no primeiro episodio, como `SD`, `HD` ou `FULLHD`.
- Gera `output/episodes.json` e `output/episodes.csv` com os episodios, links e nomes sugeridos.
- Opcionalmente abre cada episodio/link no Chromium, deixa a extensao FetchV capturar o video e prepara uma aba do FetchV ja renomeada para `01`, `02`, `03` etc.

O modo FetchV nao clica no botao final de download. Ele apenas deixa as abas preparadas e renomeadas para conferencia manual.

## Requisitos

- Node.js instalado.
- Google Chrome instalado com a extensao FetchV.
- A extensao FetchV instalada no Chrome:
  `https://chromewebstore.google.com/detail/fetchv-video-downloader-f/nfmmmhanepmpifddlkkmihkalkoekpfd?hl=pt-BR`

## Uso

```powershell
npm install
npx playwright install chromium
npm start
```

O programa vai pedir:

1. URL do anime.
2. Numero da qualidade encontrada no primeiro episodio, como `SD`, `HD` ou `FULLHD`.
3. Se deve preparar abas do FetchV e renomear sem baixar.
4. Caso nao use FetchV, se deve abrir os links no Chromium.

Os resultados ficam em `output/episodes.json` e `output/episodes.csv`.

Tambem da para iniciar pelo arquivo:

```powershell
.\Iniciar Scrapper.bat
```

Esse `.bat` instala as dependencias na primeira execucao e verifica o Chromium do Playwright.

## FetchV

Quando a opcao do FetchV for escolhida, o Chromium abre a URL capturada de cada episodio, espera a extensao capturar o video, abre a pagina do FetchV (`videodownloader` ou `m3u8downloader`) e renomeia o arquivo para `01`, `02`, `03` e assim por diante. O script nao clica no botao final de download.

Nao precisa instalar a FetchV manualmente no Chromium do Playwright. O script encontra a extensao instalada no seu Chrome, copia para `.fetchv-extension` sem a pasta `_metadata` da Web Store e carrega essa copia limpa no Chromium automatizado.

O Chromium do Playwright e usado no modo FetchV porque o Chrome Stable pode bloquear extensoes carregadas como `unpacked` em alguns ambientes.

## Variaveis uteis

- `FETCHV_PREPARE=1`: prepara as abas do FetchV sem perguntar.
- `FETCHV_EXTENSION_PATH=C:\caminho\da\extensao`: informa manualmente a pasta da extensao.
- `FETCHV_EXTENSION_ID=nfmmmhanepmpifddlkkmihkalkoekpfd`: informa manualmente o ID, se necessario.
- `FETCHV_KEEP_SOURCE_TABS=1`: mantem abertas tambem as abas temporarias usadas para capturar os videos.
- `FETCHV_CAPTURE_TIMEOUT_MS=45000`: altera o tempo de espera pela captura de cada episodio.
- `FETCHV_DOWNLOAD_DIR=C:\Users\seu-usuario\Downloads`: altera onde os downloads finais do FetchV serao salvos.
- `ANITUBE_URL=https://...`: informa a URL do anime sem perguntar.
- `QUALITY_CHOICE=2`: escolhe a qualidade sem perguntar.
- `CLEAN_OUTPUT=s`: limpa a pasta `output` antes de comecar.

Exemplo:

```powershell
$env:FETCHV_PREPARE="1"
$env:QUALITY_CHOICE="2"
npm start
```

## Solucao de problemas

Se a FetchV nao for encontrada automaticamente, confira se ela esta instalada no Chrome. Tambem e possivel informar a pasta manualmente com `FETCHV_EXTENSION_PATH`.

Se aparecer erro de Chromium ausente, rode:

```powershell
npx playwright install chromium
```

Se algum episodio nao for capturado pela FetchV, aumente `FETCHV_CAPTURE_TIMEOUT_MS` ou rode novamente mantendo as abas fonte abertas com `FETCHV_KEEP_SOURCE_TABS=1` para conferir a pagina que a extensao tentou capturar.

Se o historico do Chromium mostrar nomes aleatorios de `blob:https://fetchv.net`, o script tambem escuta esses downloads e salva uma copia renomeada em `FETCHV_DOWNLOAD_DIR` ou na pasta `Downloads` do Windows.
