# AniTube Chromium Helper

Automacao em Chromium para mapear episodios de uma pagina de anime, detectar qualidades disponiveis no `abas_players` e gerar um manifesto com os links da qualidade escolhida.

## Uso

```powershell
npm install
npm start
```

O programa vai pedir:

1. URL do anime.
2. Numero da qualidade encontrada no primeiro episodio, como `SD`, `HD` ou `FULLHD`.
3. Se deve abrir os links no Chromium.

Os resultados ficam em `output/episodes.json` e `output/episodes.csv`.
