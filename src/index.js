import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_URL = 'https://www.anitube.vip/animes-dublado/komi-san-wa-comyushou-desu-dublado';
const OUT_DIR = path.resolve('output');
const PROFILE_DIR = path.resolve('chromium-profile');

const rl = createInterface({ input, output });

async function ask(question, fallback = '') {
  try {
    return await rl.question(question);
  } catch (error) {
    if (error?.message?.includes('readline was closed')) return fallback;
    throw error;
  }
}

function normalizeUrl(raw) {
  const value = raw.trim();
  if (!value) return DEFAULT_URL;
  const url = new URL(value);
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function pathExists(target) {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

async function findFetchVExtension() {
  if (process.env.FETCHV_EXTENSION_PATH && await pathExists(process.env.FETCHV_EXTENSION_PATH)) {
    return process.env.FETCHV_EXTENSION_PATH;
  }

  const extensionsRoot = path.join(
    process.env.LOCALAPPDATA || '',
    'Google',
    'Chrome',
    'User Data',
    'Default',
    'Extensions'
  );

  if (!await pathExists(extensionsRoot)) return null;

  for (const extensionId of await readdir(extensionsRoot)) {
    const extensionDir = path.join(extensionsRoot, extensionId);
    for (const version of await readdir(extensionDir).catch(() => [])) {
      const versionDir = path.join(extensionDir, version);
      const manifestPath = path.join(versionDir, 'manifest.json');
      const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
      if (manifest?.short_name === 'FetchV' || manifest?.homepage_url === 'https://fetchv.net/') {
        return versionDir;
      }
    }
  }

  return null;
}

function pageUrl(baseUrl, pageNumber) {
  if (pageNumber <= 0) return baseUrl;
  return `${baseUrl}/page/${pageNumber}`;
}

function parseEpisodeNumber(text, href) {
  const haystack = `${text} ${href}`;
  const patterns = [
    /\bep(?:is[oó]dio)?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\bepis[oó]dio\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\/video\/([0-9]+)/i
  ];

  for (const pattern of patterns) {
    const match = haystack.match(pattern);
    if (match) return Number(match[1]);
  }

  return Number.MAX_SAFE_INTEGER;
}

function episodeFilename(episode, index) {
  const number = Number.isFinite(episode.number) && episode.number !== Number.MAX_SAFE_INTEGER
    ? String(episode.number).padStart(2, '0')
    : String(index + 1).padStart(2, '0');

  return number;
}

async function collectEpisodes(page, baseUrl) {
  const seenPages = new Set();
  const episodes = new Map();

  let emptyPages = 0;

  for (let pageNumber = 0; pageNumber <= 200; pageNumber += 1) {
    const url = pageUrl(baseUrl, pageNumber);
    if (seenPages.has(url)) break;
    seenPages.add(url);

    console.log(`Lendo pagina ${pageNumber === 0 ? 'base' : pageNumber}: ${url}`);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    if (!response || response.status() >= 400) {
      if (pageNumber === 0) throw new Error(`Nao consegui abrir ${url}`);
      break;
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const found = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/video/"]')];
      return anchors.map((anchor) => {
        const href = new URL(anchor.getAttribute('href'), location.href).toString();
        const img = anchor.querySelector('img');
        const title = [
          anchor.textContent,
          img?.getAttribute('alt'),
          img?.getAttribute('title')
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        return { href, title };
      });
    });

    const before = episodes.size;
    for (const item of found) {
      if (!episodes.has(item.href)) {
        episodes.set(item.href, {
          url: item.href,
          title: item.title || item.href,
          number: parseEpisodeNumber(item.title, item.href)
        });
      }
    }

    if (episodes.size === before && pageNumber > 0) {
      emptyPages += 1;
    } else {
      emptyPages = 0;
    }

    const hasNext = await page.evaluate(() => {
      const next = [...document.querySelectorAll('a[href]')].some((a) => {
        const text = a.textContent?.trim().toLowerCase() || '';
        const rel = a.getAttribute('rel') || '';
        return rel.includes('next') || ['proximo', 'próximo', 'next', '»', '›'].includes(text);
      });
      return next;
    });

    if (emptyPages >= 2) break;
    if (!hasNext && pageNumber > 1 && emptyPages > 0) break;
  }

  return [...episodes.values()].sort((a, b) => a.number - b.number || a.url.localeCompare(b.url));
}

function qualityName(rawText) {
  const text = String(rawText || '')
    .replace(/\s+/g, ' ')
    .replace(/^player\s+/i, '')
    .trim();

  return text || 'Padrao';
}

async function extractQualityOptions(page) {
  return page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.abas_players .abaItem[aba-tg], [class*="abas_player"] .abaItem[aba-tg]')];
    const qualities = tabs.map((tab) => ({
      rawLabel: tab.textContent?.replace(/\s+/g, ' ').trim() || '',
      target: tab.getAttribute('aba-tg') || '',
      current: tab.classList.contains('current')
    }));

    if (!qualities.length) {
      const hasDirectVideo = !!document.querySelector('.vp_vc.video_container video, .vp_vc.video_container source, video[src], video source[src]');
      const hasExternalLink = !!document.querySelector('.vp_vc.video_container a[href], .video_container a[href]');
      if (hasDirectVideo || hasExternalLink) {
        qualities.push({ rawLabel: 'Padrao', target: '', current: true });
      }
    }

    const unique = [];
    const seen = new Set();
    for (const quality of qualities) {
      const key = `${quality.rawLabel}|${quality.target}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push({ ...quality, index: unique.length + 1 });
      }
    }
    return unique;
  });
}

async function detectQualityOptions(page, episodeUrl) {
  console.log(`Detectando qualidades no primeiro episodio: ${episodeUrl}`);
  await page.goto(episodeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const options = await extractQualityOptions(page);
  return options.map((option) => ({
    ...option,
    label: qualityName(option.rawLabel)
  }));
}

async function activateQuality(page, quality) {
  if (!quality?.target) return;

  await page.evaluate((target) => {
    const selector = `.abas_players .abaItem[aba-tg="${CSS.escape(target)}"], [class*="abas_player"] .abaItem[aba-tg="${CSS.escape(target)}"]`;
    const tab = document.querySelector(selector);
    if (tab) {
      tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      tab.click();
    }

    const siblingTabs = [...document.querySelectorAll('.abas_players .abaItem[aba-tg], [class*="abas_player"] .abaItem[aba-tg]')];
    for (const item of siblingTabs) {
      item.classList.toggle('current', item.getAttribute('aba-tg') === target);
    }

    const containers = [...document.querySelectorAll('.vp_vc.video_container[id], .video_container[id]')];
    for (const container of containers) {
      if (!container.id) continue;
      container.style.display = container.id === target ? 'block' : 'none';
    }
  }, quality.target);

  await page.waitForTimeout(500);
}

async function extractSelectedQualitySource(page, quality) {
  return page.evaluate((selectedQuality) => {
    const firstExternalLink = (root) => {
      const anchor = [...root.querySelectorAll('a[href]')]
        .find((item) => !/\/download\//i.test(item.href));
      if (!anchor) return null;

      const img = anchor.querySelector('img');
      const label = [
        anchor.textContent,
        img?.getAttribute('alt'),
        img?.getAttribute('title')
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

      return {
        sourceType: 'external',
        sourceUrl: new URL(anchor.getAttribute('href'), location.href).toString(),
        sourceLabel: label || anchor.getAttribute('title') || anchor.href,
        containerId: root.id || ''
      };
    };

    const firstDirectVideo = (root) => {
      const video = root.querySelector('video[src], video source[src], meta[itemprop="contentURL"][content]');
      const src = video?.getAttribute('src') || video?.getAttribute('content') || video?.src || '';
      if (!src) return null;

      return {
        sourceType: 'direct-video',
        sourceUrl: new URL(src, location.href).toString(),
        sourceLabel: document.title,
        containerId: root.id || ''
      };
    };

    const target = selectedQuality?.target || '';
    const label = selectedQuality?.label || '';
    const wantsDirect = /\bSD\b/i.test(label);
    const wantsExternal = /\b(HD|FULL|FULLHD|FHD)\b/i.test(label);

    const targetContainer = target ? document.getElementById(target) : null;
    const directContainers = [...document.querySelectorAll('.vp_vc.video_container:not([id]), .video_container:not([id])')];
    const idContainers = [...document.querySelectorAll('.vp_vc.video_container[id], .video_container[id]')];

    if (wantsDirect) {
      for (const container of directContainers) {
        const direct = firstDirectVideo(container);
        if (direct) return direct;
      }
    }

    if (targetContainer) {
      const byTarget = wantsExternal
        ? firstExternalLink(targetContainer) || firstDirectVideo(targetContainer)
        : firstDirectVideo(targetContainer) || firstExternalLink(targetContainer);
      if (byTarget) return byTarget;
    }

    if (wantsExternal) {
      for (const container of idContainers) {
        const external = firstExternalLink(container);
        if (external) return external;
      }
    }

    for (const container of [...idContainers, ...directContainers]) {
      const source = firstExternalLink(container) || firstDirectVideo(container);
      if (source) return source;
    }

    return null;
  }, quality);
}

async function getSelectedQualitySource(page, episode, quality) {
  console.log(`Selecionando ${quality.label} no episodio ${episode.url}`);
  await page.goto(episode.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await activateQuality(page, quality);
  return extractSelectedQualitySource(page, quality);
}

function csvEscape(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function writeManifest(rows) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'episodes.json'), JSON.stringify(rows, null, 2), 'utf8');
  const csv = [
    ['episode', 'title', 'episode_url', 'quality', 'source_type', 'source_label', 'source_url', 'filename'].map(csvEscape).join(','),
    ...rows.map((row) => [
      row.episode,
      row.title,
      row.episodeUrl,
      row.quality,
      row.sourceType,
      row.sourceLabel,
      row.sourceUrl,
      row.filename
    ].map(csvEscape).join(','))
  ].join('\n');
  await writeFile(path.join(OUT_DIR, 'episodes.csv'), csv, 'utf8');
}

async function cleanPreviousOutput() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
}

async function main() {
  const shouldClean = (process.env.CLEAN_OUTPUT || await ask('Limpar resultados antigos de output antes de comecar? [s/N] ', 'n')).trim().toLowerCase();
  if (shouldClean === 's' || shouldClean === 'sim') {
    await cleanPreviousOutput();
    console.log(`Resultados antigos removidos de: ${OUT_DIR}`);
  }

  const animeUrl = normalizeUrl(process.env.ANITUBE_URL || await ask(`URL do anime [${DEFAULT_URL}]: `, DEFAULT_URL));
  const fetchVExtension = await findFetchVExtension();
  if (fetchVExtension) {
    console.log(`FetchV carregada de: ${fetchVExtension}`);
  } else {
    console.log('FetchV nao foi encontrada automaticamente. Use FETCHV_EXTENSION_PATH para informar a pasta da extensao.');
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1366, height: 768 },
    channel: 'chrome',
    args: fetchVExtension ? [
      `--disable-extensions-except=${fetchVExtension}`,
      `--load-extension=${fetchVExtension}`
    ] : []
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    const episodes = await collectEpisodes(page, animeUrl);
    if (!episodes.length) throw new Error('Nenhum episodio encontrado.');

    console.log(`\nEncontrei ${episodes.length} episodio(s).`);
    episodes.forEach((episode, index) => {
      console.log(`${String(index + 1).padStart(2, '0')}. ${episode.title} -> ${episode.url}`);
    });

    const qualities = await detectQualityOptions(page, episodes[0].url);
    if (!qualities.length) throw new Error('Nao encontrei qualidades no primeiro episodio.');

    console.log('\nQualidades detectadas:');
    qualities.forEach((quality, index) => {
      console.log(`${index + 1}. ${quality.label}${quality.target ? ` (${quality.target})` : ''}${quality.current ? ' [atual]' : ''}`);
    });

    const rawChoice = process.env.QUALITY_CHOICE || process.env.PLAYER_CHOICE || await ask('\nQual numero de qualidade voce quer usar em todos os episodios? ', '1');
    const choiceIndex = Number(rawChoice.trim()) - 1;
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= qualities.length) {
      throw new Error('Opcao invalida.');
    }
    const selectedQuality = qualities[choiceIndex];
    console.log(`\nQualidade escolhida: ${selectedQuality.label}`);

    const rows = [];
    for (let i = 0; i < episodes.length; i += 1) {
      const episode = episodes[i];
      console.log(`Mapeando episodio ${i + 1}/${episodes.length}: ${episode.url}`);
      const selected = await getSelectedQualitySource(page, episode, selectedQuality);
      rows.push({
        episode: Number.isFinite(episode.number) && episode.number !== Number.MAX_SAFE_INTEGER ? episode.number : i + 1,
        title: episode.title,
        episodeUrl: episode.url,
        quality: selectedQuality.label,
        sourceType: selected?.sourceType || '',
        sourceLabel: selected?.sourceLabel || '',
        sourceUrl: selected?.sourceUrl || '',
        filename: episodeFilename(episode, i)
      });
    }

    await writeManifest(rows);
    console.log(`\nManifestos salvos em:`);
    console.log(`- ${path.join(OUT_DIR, 'episodes.json')}`);
    console.log(`- ${path.join(OUT_DIR, 'episodes.csv')}`);

    const shouldOpen = (process.env.OPEN_LINKS || await ask('\nAbrir os links selecionados no Chromium agora? [s/N] ', 'n')).trim().toLowerCase();
    if (shouldOpen === 's' || shouldOpen === 'sim') {
      for (const row of rows) {
        if (!row.sourceUrl) continue;
        const tab = await context.newPage();
        await tab.goto(row.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((error) => {
          console.log(`Falha ao abrir ${row.sourceUrl}: ${error.message}`);
        });
      }
      console.log('Links abertos. O navegador ficara aberto para voce usar manualmente.');
      await ask('Pressione ENTER para fechar o Chromium...');
    }
  } finally {
    await context.close();
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\nErro: ${error.message}`);
  rl.close();
  process.exitCode = 1;
});
