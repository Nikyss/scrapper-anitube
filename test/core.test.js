import assert from 'node:assert/strict';
import test from 'node:test';

import {
  episodeFilename,
  isFetchVCandidate,
  listingPageNumbers,
  mapWithConcurrency,
  mediaUrlContainsVideoId,
  parseEpisodeNumber,
  selectFetchVItem,
  validateFetchVRows,
  videoIdFromUrl
} from '../src/core.js';

test('identifica formatos comuns de numero do episodio', () => {
  assert.equal(parseEpisodeNumber('EP 01'), 1);
  assert.equal(parseEpisodeNumber('Episódio 2'), 2);
  assert.equal(parseEpisodeNumber('anime-episodio-12'), 12);
  assert.equal(parseEpisodeNumber('Episode #3'), 3);
  assert.equal(parseEpisodeNumber('ep. 04'), 4);
});

test('nao confunde o ID interno de /video com o episodio', () => {
  assert.equal(parseEpisodeNumber('Komi-san', 'https://www.anitube.vip/video/194140'), null);
  assert.equal(videoIdFromUrl('https://www.anitube.vip/video/194140'), '194140');
  assert.equal(mediaUrlContainsVideoId('https://cdn.example/iphonec/194140.mp4', '194140'), true);
  assert.equal(mediaUrlContainsVideoId('https://cdn.example/iphonec/194144.mp4', '194140'), false);
});

test('rejeita rotulos que discordam sobre o episodio', () => {
  assert.throws(
    () => parseEpisodeNumber('Ep 1', 'https://example.test/anime-episodio-2'),
    /conflitantes/
  );
});

test('nome do arquivo vem somente do numero verificado', () => {
  assert.equal(episodeFilename({ number: 1 }), '01');
  assert.equal(episodeFilename({ number: 12 }), '12');
  assert.equal(episodeFilename({ number: 1.5 }), '01.5');
  assert.equal(episodeFilename({ number: null }), '');
});

test('preflight bloqueia episodio desconhecido, duplicado ou fonte repetida', () => {
  assert.throws(() => validateFetchVRows([
    { episode: null, filename: '', episodeUrl: 'https://site/video/1', sourceUrl: '' }
  ]), /numero do episodio nao identificado/);

  assert.throws(() => validateFetchVRows([
    { episode: 1, filename: '01', episodeUrl: 'https://site/video/10', sourceUrl: 'https://cdn/10.mp4' },
    { episode: 1, filename: '01', episodeUrl: 'https://site/video/11', sourceUrl: 'https://cdn/10.mp4' }
  ]), /duplicado/);

  assert.throws(() => validateFetchVRows([
    { episode: 1, filename: '01', episodeUrl: 'https://site/video/10', videoId: '', sourceType: '', sourceUrl: '' }
  ]), /ID interno do video nao identificado/);
});

test('anuncio MP4 pequeno nao vence o episodio identificado', () => {
  const row = {
    videoId: '194140',
    sourceUrl: 'https://gate.example/watch/abc',
    sourceType: 'external'
  };
  const ad = {
    type: 'mp4',
    size: 9 * 1024 * 1024,
    url: 'https://googleads.g.doubleclick.net/preroll/ad.mp4'
  };
  const decoy = {
    type: 'hls',
    size: 0,
    url: 'https://cdn.example/other-anime/08/master.m3u8'
  };
  const episode = {
    type: 'mp4',
    size: 180 * 1024 * 1024,
    url: 'https://cdn.example/iphonec/194140.mp4'
  };
  const smallPromoWithEpisodeId = {
    type: 'mp4',
    size: 9 * 1024 * 1024,
    url: 'https://cdn.example/194140/promo.mp4'
  };

  assert.equal(isFetchVCandidate(ad, row), false);
  assert.equal(isFetchVCandidate(decoy, row), false);
  assert.equal(isFetchVCandidate(smallPromoWithEpisodeId, row), false);
  assert.equal(selectFetchVItem([ad, decoy, episode], row), episode);
});

test('HLS sem ID interno falha fechado por padrao', () => {
  assert.equal(isFetchVCandidate(
    { type: 'hls', format: 'm3u8', size: 0, url: 'https://cdn.example/master.m3u8' },
    { videoId: '', sourceType: 'external', sourceUrl: 'https://player.example/watch' }
  ), false);
});

test('fonte direta exige correspondencia com a identidade do episodio', () => {
  const row = {
    videoId: '194144',
    sourceUrl: 'https://cdn.example/iphonec/194144.mp4',
    sourceType: 'direct-video'
  };
  const wrong = {
    type: 'mp4',
    size: 200 * 1024 * 1024,
    url: 'https://cdn.example/iphonec/194140.mp4'
  };
  const correct = {
    type: 'mp4',
    size: 8 * 1024 * 1024,
    url: row.sourceUrl
  };

  assert.equal(isFetchVCandidate(wrong, row), false);
  assert.equal(isFetchVCandidate(correct, row), true);
});

test('pool concorrente preserva a ordem e respeita o limite', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, (7 - value) * 2));
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(result, [10, 20, 30, 40, 50, 60]);
  assert.equal(maximum, 3);
});

test('lote com 48 episodios mantem cada resultado na posicao correta', async () => {
  const episodes = Array.from({ length: 48 }, (_, index) => ({
    number: index + 1,
    videoId: String(200000 + index)
  }));

  const result = await mapWithConcurrency(episodes, 6, async (episode) => {
    await new Promise((resolve) => setTimeout(resolve, (episode.number % 7) + 1));
    return `${episodeFilename(episode)}:${episode.videoId}`;
  });

  assert.equal(result.length, 48);
  assert.equal(result[0], '01:200000');
  assert.equal(result[23], '24:200023');
  assert.equal(result[47], '48:200047');
});

test('paginacao ignora outros caminhos e bloqueia numeros abusivos', () => {
  const baseUrl = 'https://www.anitube.vip/anime/serie';
  assert.deepEqual(listingPageNumbers([
    '/anime/serie/page/2',
    'https://www.anitube.vip/anime/serie/page/48/',
    'https://www.anitube.vip/outra-serie/page/999',
    'https://example.test/anime/serie/page/500'
  ], baseUrl, 200), [2, 48]);

  assert.throws(() => listingPageNumbers([
    '/anime/serie/page/999999'
  ], baseUrl, 200), /limite seguro/);
});
