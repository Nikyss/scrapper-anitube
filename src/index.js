import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  compareEpisodes,
  episodeFilename,
  fetchVItemFingerprint,
  isFetchVVideoItem,
  isLikelyAdUrl,
  listingPageNumbers,
  mapWithConcurrency,
  mediaUrlContainsVideoId,
  parseEpisodeNumber,
  selectFetchVItem,
  validateFetchVRows,
  videoIdFromUrl
} from './core.js';

const DEFAULT_URL = 'https://www.anitube.vip/animes-dublado/komi-san-wa-comyushou-desu-dublado';
const OUT_DIR = path.resolve('output');
const PROFILE_DIR = path.resolve('chromium-profile');
const STAGED_FETCHV_EXTENSION_DIR = path.resolve('.fetchv-extension');
const STAGED_DARK_READER_EXTENSION_DIR = path.resolve('.dark-reader-extension');
const STAGED_UBLOCK_ORIGIN_LITE_EXTENSION_DIR = path.resolve('.ublock-origin-lite-extension');
const DEFAULT_DOWNLOAD_DIR = path.join(process.env.USERPROFILE || process.cwd(), 'Downloads');
const FETCHV_DOWNLOAD_DIR = path.resolve(process.env.FETCHV_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR);
const FETCHV_SITE = 'https://fetchv.net';
const FETCHV_EXTENSION_ID = 'nfmmmhanepmpifddlkkmihkalkoekpfd';
const DARK_READER_EXTENSION_ID = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';
const UBLOCK_ORIGIN_LITE_EXTENSION_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const FETCHV_LANG = process.env.FETCHV_LANG || 'pt';
const FETCHV_CAPTURE_TIMEOUT_MS = positiveInteger(process.env.FETCHV_CAPTURE_TIMEOUT_MS, 15000, 5000, 120000);
const FETCHV_CAPTURE_SETTLE_MS = positiveInteger(process.env.FETCHV_CAPTURE_SETTLE_MS, 2500, 500, 10000);
const FETCHV_MIN_VIDEO_BYTES = positiveInteger(
  process.env.FETCHV_MIN_VIDEO_BYTES,
  20 * 1024 * 1024,
  0,
  2_000_000_000
);
const FETCHV_CAPTURE_CONCURRENCY = positiveInteger(process.env.FETCHV_CAPTURE_CONCURRENCY, 3, 1, 6);
const FETCHV_ISOLATED_RETRY_LIMIT = positiveInteger(process.env.FETCHV_ISOLATED_RETRY_LIMIT, 3, 0, 20);
const ANITUBE_MAPPING_CONCURRENCY = positiveInteger(process.env.ANITUBE_MAPPING_CONCURRENCY, 4, 1, 8);
const ANITUBE_MAX_LISTING_PAGES = positiveInteger(process.env.ANITUBE_MAX_LISTING_PAGES, 200, 1, 1000);
const RAW_NAVIGATION_ATTEMPTS = Number(process.env.ANITUBE_NAVIGATION_ATTEMPTS || 2);
const NAVIGATION_ATTEMPTS = Number.isFinite(RAW_NAVIGATION_ATTEMPTS)
  ? Math.max(1, RAW_NAVIGATION_ATTEMPTS)
  : 2;
const PUBLIC_DNS_SERVERS = (process.env.ANITUBE_PUBLIC_DNS_SERVERS || '1.1.1.1,8.8.8.8')
  .split(',')
  .map((server) => server.trim())
  .filter(Boolean);

const rl = createInterface({ input, output });

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return String(value || '');
  }
}

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

function alternateHostUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname === 'www.anitube.vip') {
    url.hostname = 'anitube.vip';
    return url.toString().replace(/\/$/, '');
  }
  if (url.hostname === 'anitube.vip') {
    url.hostname = 'www.anitube.vip';
    return url.toString().replace(/\/$/, '');
  }
  return null;
}

function summarizeNavigationError(error) {
  const message = error?.message || String(error);
  const networkError = message.match(/net::([A-Z0-9_]+)/);
  if (networkError) return `net::${networkError[1]}`;
  return message.split(/\r?\n/)[0];
}

function isAnitubeHost(hostname) {
  return hostname === 'anitube.vip' || hostname === 'www.anitube.vip';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function resolvePublicIPv4(hostname) {
  if (process.env.ANITUBE_HOST_IP) return process.env.ANITUBE_HOST_IP.trim();
  if (!PUBLIC_DNS_SERVERS.length) return '';

  const resolver = new Resolver();
  resolver.setServers(PUBLIC_DNS_SERVERS);
  const addresses = await resolver.resolve4(hostname).catch(() => []);
  return addresses.find((address) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address)) || '';
}

async function buildAnitubeHostResolverRules(rawUrl) {
  if (process.env.ANITUBE_DISABLE_DNS_FALLBACK === '1') return '';

  const url = new URL(rawUrl);
  if (!isAnitubeHost(url.hostname)) return '';

  const alternate = alternateHostUrl(rawUrl);
  const hostnames = unique([
    url.hostname,
    alternate ? new URL(alternate).hostname : ''
  ]);

  const rules = [];
  for (const hostname of hostnames) {
    const address = await resolvePublicIPv4(hostname);
    if (address) rules.push(`MAP ${hostname} ${address}`);
  }

  if (!rules.length) return '';
  return `${rules.join(',')},EXCLUDE localhost`;
}

async function gotoWithFallback(page, url, options, attemptLimit = NAVIGATION_ATTEMPTS) {
  const errors = [];
  for (const candidate of [url, alternateHostUrl(url)].filter(Boolean)) {
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      try {
        return await page.goto(candidate, options);
      } catch (error) {
        const summary = summarizeNavigationError(error);
        errors.push(`${candidate}${attemptLimit > 1 ? ` tentativa ${attempt}` : ''}: ${summary}`);
        if (attempt < attemptLimit || alternateHostUrl(candidate)) {
          await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
          await delay(1000);
        }
      }
    }
  }

  throw new Error(errors.join(' | '));
}

async function pathExists(target) {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function isYes(value) {
  return ['1', 's', 'sim', 'y', 'yes', 'true'].includes(String(value || '').trim().toLowerCase());
}

function isChromeExtensionId(value) {
  return /^[a-p]{32}$/.test(String(value || '').trim());
}

function extensionIdFromKey(key) {
  if (!key) return null;

  try {
    const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    const alphabet = 'abcdefghijklmnop';
    return [...hash].map((char) => alphabet[Number.parseInt(char, 16)]).join('');
  } catch {
    return null;
  }
}

function inferExtensionId(extensionPath, manifest, envId = '') {
  if (isChromeExtensionId(envId)) return envId.trim();

  const candidates = [
    path.basename(extensionPath),
    path.basename(path.dirname(extensionPath))
  ];
  const dirId = candidates.find(isChromeExtensionId);
  if (dirId) return dirId;

  return extensionIdFromKey(manifest?.key);
}

async function readExtensionManifest(extensionPath) {
  return readFile(path.join(extensionPath, 'manifest.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
}

function extensionInfo(extensionPath, manifest, envId = '') {
  return {
    id: inferExtensionId(extensionPath, manifest, envId),
    manifest,
    path: extensionPath,
    sourcePath: extensionPath
  };
}

async function stageExtension(info, targetPath) {
  if (!info) return null;

  const sourcePath = path.resolve(info.path);
  if (sourcePath === targetPath) return info;

  await rm(targetPath, { recursive: true, force: true });
  await mkdir(targetPath, { recursive: true });
  await cp(sourcePath, targetPath, {
    recursive: true,
    filter: (source) => path.basename(source) !== '_metadata'
  });

  const manifest = await readExtensionManifest(targetPath);
  return {
    ...info,
    id: inferExtensionId(targetPath, manifest, info.id) || info.id,
    manifest,
    path: targetPath,
    sourcePath
  };
}

async function stageFetchVExtension(info) {
  return stageExtension(info, STAGED_FETCHV_EXTENSION_DIR);
}

async function stageDarkReaderExtension(info) {
  return stageExtension(info, STAGED_DARK_READER_EXTENSION_DIR);
}

async function stageUBlockOriginLiteExtension(info) {
  return stageExtension(info, STAGED_UBLOCK_ORIGIN_LITE_EXTENSION_DIR);
}

function chromeExtensionsRoot() {
  return path.join(
    process.env.LOCALAPPDATA || '',
    'Google',
    'Chrome',
    'User Data',
    'Default',
    'Extensions'
  );
}

async function findChromeExtensionById(extensionId, envPath = '') {
  if (envPath && await pathExists(envPath)) {
    const manifest = await readExtensionManifest(envPath);
    return extensionInfo(envPath, manifest, extensionId);
  }

  const extensionDir = path.join(chromeExtensionsRoot(), extensionId);
  if (!await pathExists(extensionDir)) return null;

  const versions = await readdir(extensionDir).catch(() => []);
  const candidates = [];
  for (const version of versions) {
    const versionDir = path.join(extensionDir, version);
    const manifest = await readExtensionManifest(versionDir);
    if (manifest) {
      candidates.push(extensionInfo(versionDir, manifest, extensionId));
    }
  }

  return candidates.sort((a, b) => String(b.manifest?.version || '').localeCompare(String(a.manifest?.version || ''), undefined, { numeric: true }))[0] || null;
}

async function findFetchVExtension() {
  if (process.env.FETCHV_EXTENSION_PATH && await pathExists(process.env.FETCHV_EXTENSION_PATH)) {
    const manifest = await readExtensionManifest(process.env.FETCHV_EXTENSION_PATH);
    return extensionInfo(process.env.FETCHV_EXTENSION_PATH, manifest, process.env.FETCHV_EXTENSION_ID || FETCHV_EXTENSION_ID);
  }

  const extensionsRoot = chromeExtensionsRoot();

  if (!await pathExists(extensionsRoot)) return null;

  for (const extensionId of await readdir(extensionsRoot)) {
    const extensionDir = path.join(extensionsRoot, extensionId);
    for (const version of await readdir(extensionDir).catch(() => [])) {
      const versionDir = path.join(extensionDir, version);
      const manifest = await readExtensionManifest(versionDir);
      if (manifest?.short_name === 'FetchV' || manifest?.homepage_url === 'https://fetchv.net/') {
        return extensionInfo(versionDir, manifest, process.env.FETCHV_EXTENSION_ID || FETCHV_EXTENSION_ID);
      }
    }
  }

  return null;
}

async function findDarkReaderExtension() {
  return findChromeExtensionById(
    process.env.DARK_READER_EXTENSION_ID || DARK_READER_EXTENSION_ID,
    process.env.DARK_READER_EXTENSION_PATH || ''
  );
}

async function findUBlockOriginLiteExtension() {
  return findChromeExtensionById(
    process.env.UBLOCK_ORIGIN_LITE_EXTENSION_ID || UBLOCK_ORIGIN_LITE_EXTENSION_ID,
    process.env.UBLOCK_ORIGIN_LITE_EXTENSION_PATH || ''
  );
}

function pageUrl(baseUrl, pageNumber) {
  if (pageNumber <= 0) return baseUrl;
  return `${baseUrl}/page/${pageNumber}`;
}

async function readEpisodeListingPage(page, url, label, listingBaseUrl = url) {
  console.log(`Lendo pagina ${label}: ${url}`);
  const response = await gotoWithFallback(page, url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    .catch((error) => {
      throw new Error(`Nao consegui abrir ${url}. Detalhe do navegador: ${error.message}`);
    });
  if (!response || response.status() >= 400) {
    throw new Error(`Nao consegui abrir ${url} (HTTP ${response?.status?.() || 'sem resposta'})`);
  }

  await page.waitForSelector('.animepag_episodios_container, .animepag_episodios_item', {
    state: 'attached',
    timeout: 8000
  }).catch(() => {});

  const result = await page.evaluate(() => {
    const directAnchors = [...document.querySelectorAll('.animepag_episodios_item > a[href*="/video/"]')];
    const anchors = directAnchors.length
      ? directAnchors
      : [...document.querySelectorAll('.animepag_episodios_item a[href*="/video/"]')];
    const found = anchors.map((anchor) => {
      const item = anchor.closest('.animepag_episodios_item');
      const img = anchor.querySelector('img');
      const titleCandidates = [
        anchor.getAttribute('title'),
        item?.querySelector('.animepag_episodios_item_nome')?.textContent,
        img?.getAttribute('alt'),
        img?.getAttribute('title'),
        anchor.textContent
      ].filter(Boolean).map((value) => value.replace(/\s+/g, ' ').trim());
      const labels = [
        anchor.getAttribute('data-episode'),
        item?.getAttribute('data-episode'),
        ...titleCandidates
      ].filter(Boolean).map((value) => value.replace(/\s+/g, ' ').trim());
      return {
        href: new URL(anchor.getAttribute('href'), location.href).toString(),
        labels,
        title: titleCandidates[0] || ''
      };
    });

    const pageHrefs = [...document.querySelectorAll('a[href*="/page/"]')]
      .map((anchor) => new URL(anchor.getAttribute('href'), location.href).toString());
    return { found, pageHrefs };
  });

  return {
    found: result.found,
    pageNumbers: listingPageNumbers(result.pageHrefs, listingBaseUrl, ANITUBE_MAX_LISTING_PAGES)
  };
}

async function collectEpisodes(page, baseUrl) {
  const firstPage = await readEpisodeListingPage(page, baseUrl, 'base');
  const maximumPage = Math.max(1, ...firstPage.pageNumbers);
  const remainingPages = Array.from({ length: Math.max(0, maximumPage - 1) }, (_, index) => index + 2);
  const extraPages = await mapWithConcurrency(
    remainingPages,
    Math.min(ANITUBE_MAPPING_CONCURRENCY, 4),
    async (pageNumber) => {
      const listingPage = await page.context().newPage();
      try {
        return await readEpisodeListingPage(listingPage, pageUrl(baseUrl, pageNumber), pageNumber, baseUrl);
      } finally {
        await listingPage.close().catch(() => {});
      }
    }
  );

  const episodes = new Map();
  const episodeNumbers = new Map();
  const videoIds = new Map();
  const allFound = [firstPage, ...extraPages].flatMap((result) => result.found);
  for (const item of allFound) {
    const canonicalKey = new URL(item.href).pathname.replace(/\/$/, '');
    if (episodes.has(canonicalKey)) continue;

    let number;
    try {
      number = parseEpisodeNumber(...item.labels);
    } catch (error) {
      throw new Error(`${item.href}: ${error.message}`);
    }
    const videoId = videoIdFromUrl(item.href);
    if (Number.isFinite(number) && episodeNumbers.has(number)) {
      throw new Error(`Episodio ${number} aparece em duas URLs: ${episodeNumbers.get(number)} e ${item.href}`);
    }
    if (videoId && videoIds.has(videoId)) {
      throw new Error(`ID de video ${videoId} aparece em duas URLs: ${videoIds.get(videoId)} e ${item.href}`);
    }

    const episode = {
      url: item.href,
      title: item.title || item.href,
      number,
      videoId,
      discoveryIndex: episodes.size
    };
    episodes.set(canonicalKey, episode);
    if (Number.isFinite(number)) episodeNumbers.set(number, item.href);
    if (videoId) videoIds.set(videoId, item.href);
  }

  return [...episodes.values()].sort(compareEpisodes);
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

async function detectQualityOptions(page, episode) {
  console.log(`Detectando qualidades no primeiro episodio: ${episode.url}`);
  await gotoWithFallback(page, episode.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.abas_players, [class*="abas_player"], .video_container, video', {
    state: 'attached',
    timeout: 8000
  }).catch(() => {});
  await validateEpisodePageIdentity(page, episode);
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

  await page.waitForTimeout(200);
}

async function extractSelectedQualitySource(page, quality) {
  return page.evaluate((selectedQuality) => {
    const firstExternalLink = (root) => {
      const anchor = [...root.querySelectorAll('a[href]')]
        .find((item) => {
          const url = new URL(item.getAttribute('href'), location.href);
          const adSignal = /doubleclick|googlesyndication|googleadservices|admob|preroll|vast|vpaid/i;
          return ['http:', 'https:'].includes(url.protocol)
            && !/\/download\//i.test(url.pathname)
            && !adSignal.test(url.toString());
        });
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
  await gotoWithFallback(page, episode.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.video_container, .vp_vc, video, meta[itemprop="contentURL"]', {
    state: 'attached',
    timeout: 8000
  }).catch(() => {});
  await validateEpisodePageIdentity(page, episode);
  await activateQuality(page, quality);
  const selected = await extractSelectedQualitySource(page, quality);
  if (selected?.sourceType === 'direct-video' && episode.videoId
    && !mediaUrlContainsVideoId(selected.sourceUrl, episode.videoId)) {
    throw new Error(`Fonte direta nao pertence ao ID ${episode.videoId}: ${selected.sourceUrl}`);
  }
  return selected;
}

async function validateEpisodePageIdentity(page, episode) {
  const identity = await page.evaluate(() => ({
    url: location.href,
    labels: [
      document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      document.querySelector('meta[itemprop="name"]')?.getAttribute('content'),
      document.querySelector('[itemprop="name"]')?.textContent,
      document.querySelector('h1')?.textContent,
      document.title
    ].filter(Boolean)
  }));
  const pageNumber = parseEpisodeNumber(...identity.labels);
  const pageVideoId = videoIdFromUrl(identity.url);

  if (!Number.isFinite(pageNumber)) {
    throw new Error(`A pagina nao confirma o numero do episodio ${episode.url}`);
  }
  if (pageNumber !== episode.number) {
    throw new Error(`A pagina ${identity.url} diz episodio ${pageNumber}, mas a lista dizia ${episode.number}`);
  }
  if (episode.videoId && pageVideoId !== episode.videoId) {
    throw new Error(`A pagina abriu o ID ${pageVideoId || 'desconhecido'}, esperado ${episode.videoId}`);
  }
}

async function getFetchVBridgeWorker(context, extensionId) {
  const extensionUrl = `chrome-extension://${extensionId}/`;
  let worker = context.serviceWorkers()
    .find((item) => item.url().startsWith(extensionUrl));

  if (!worker) {
    worker = await context.waitForEvent('serviceworker', {
      predicate: (item) => item.url().startsWith(extensionUrl),
      timeout: 10000
    }).catch(() => null);
  }

  if (!worker || !worker.url().startsWith(extensionUrl)) {
    throw new Error('FetchV foi carregada, mas o service worker da extensao nao ficou disponivel.');
  }

  const ready = await worker.evaluate(() => Boolean(
    globalThis.chrome?.storage?.local
    && globalThis.chrome?.tabs
  )).catch(() => false);

  if (!ready) {
    throw new Error('FetchV carregou, mas nao liberou acesso ao storage/tabs da extensao.');
  }

  return worker;
}

async function getChromeTabForPage(bridgeWorker, targetPage, marker) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await targetPage.evaluate((titleMarker) => {
      window.name = titleMarker;
      document.title = `${titleMarker} ${document.title || ''}`;
    }, marker).catch(() => {});

    await targetPage.waitForTimeout(125);

    const byMarker = await bridgeWorker.evaluate(async (titleMarker) => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const matches = [];

      for (const tab of tabs) {
        if (!tab.id) continue;
        try {
          const result = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: () => window.name
          });
          if (result?.[0]?.result === titleMarker) {
            matches.push({
              id: tab.id,
              index: tab.index,
              title: tab.title,
              url: tab.url
            });
          }
        } catch {
          // Paginas internas do Chrome nao aceitam injecao; elas nao sao a aba alvo.
        }
      }

      return matches;
    }, marker);

    if (byMarker.length === 1 && byMarker[0]?.id) return byMarker[0];
    if (byMarker.length > 1) {
      throw new Error(`Marcador de aba duplicado (${marker}); captura cancelada.`);
    }
  }

  const currentUrl = targetPage.url();
  const byUrl = await bridgeWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs
      .filter((tab) => tab.url === url)
      .map((tab) => ({
        id: tab.id,
        index: tab.index,
        title: tab.title,
        url: tab.url
      }))
      .sort((a, b) => b.index - a.index);
  }, currentUrl);

  if (byUrl.length === 1 && byUrl[0]?.id) return byUrl[0];
  if (byUrl.length > 1) {
    throw new Error(`Mais de uma aba corresponde a ${currentUrl}; captura cancelada para nao misturar episodios.`);
  }
  throw new Error(`Nao consegui localizar a aba do Chrome para ${currentUrl}`);
}

async function injectVerifiedDirectVideo(page, row) {
  if (row.sourceType !== 'direct-video' || !row.sourceUrl) return;
  if (row.videoId && !mediaUrlContainsVideoId(row.sourceUrl, row.videoId)) {
    throw new Error(`A fonte direta nao confirma o ID ${row.videoId}: ${row.sourceUrl}`);
  }

  await page.evaluate((sourceUrl) => {
    let video = document.querySelector('video[data-fetchv-verified="true"]');
    if (!video) {
      video = document.createElement('video');
      video.dataset.fetchvVerified = 'true';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
      (document.body || document.documentElement).appendChild(video);
    }
    if (video.src !== sourceUrl) video.src = sourceUrl;
    video.load();
  }, row.sourceUrl);
}

async function nudgeMediaPlayback(page, row) {
  await page.waitForTimeout(250);
  const candidates = [];

  for (const frame of page.frames()) {
    const videos = await frame.evaluate(() => [...document.querySelectorAll('video')].map((video, index) => {
      const rect = video.getBoundingClientRect();
      const source = video.currentSrc || video.getAttribute('src')
        || video.querySelector('source[src]')?.getAttribute('src') || '';
      const style = getComputedStyle(video);
      return {
        index,
        source,
        area: Math.max(0, rect.width) * Math.max(0, rect.height),
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0
      };
    })).catch(() => []);

    for (const video of videos) {
      const exactSource = video.source && video.source === row.sourceUrl;
      const matchingVideoId = video.source && row.videoId
        && mediaUrlContainsVideoId(video.source, row.videoId);
      if ((!video.visible && !exactSource && !matchingVideoId) || isLikelyAdUrl(video.source)) continue;
      let score = video.area + Math.min(video.duration, 7200) * 100;
      if (exactSource) score += 1_000_000_000;
      if (matchingVideoId) score += 500_000_000;
      candidates.push({ frame, index: video.index, score, source: video.source, visible: video.visible });
    }
  }

  const selected = candidates.sort((a, b) => b.score - a.score)[0];
  if (isYes(process.env.FETCHV_DEBUG)) {
    console.log(`FetchV debug: ${candidates.length} player(s), escolhido ${selected?.source || 'nenhum'}${selected ? `, visivel=${selected.visible}` : ''}.`);
  }
  if (selected) {
    const playback = await selected.frame.evaluate(async (index) => {
      const video = document.querySelectorAll('video')[index];
      if (!video) return { played: false, error: 'video ausente' };
      try {
        video.muted = true;
        video.playsInline = true;
        await video.play();
        return { played: true, readyState: video.readyState, src: video.currentSrc || video.src };
      } catch (error) {
        return { played: false, error: error?.message || String(error), readyState: video.readyState };
      }
    }, selected.index).catch((error) => ({ played: false, error: error.message }));
    if (isYes(process.env.FETCHV_DEBUG)) {
      console.log(`FetchV debug: play=${playback.played}, readyState=${playback.readyState ?? '-'}${playback.error ? `, erro=${playback.error}` : ''}.`);
    }
  }
  await page.waitForTimeout(250);
}

async function readFetchVStorageItems(bridgeWorker, tabId) {
  const storageKey = `storage${tabId}`;
  const storage = await bridgeWorker.evaluate(async (key) => {
    const result = await chrome.storage.local.get([key]);
    return result[key] || {};
  }, storageKey);

  return Object.values(storage || {});
}

async function clearFetchVStorageItems(bridgeWorker, tabId) {
  const storageKey = `storage${tabId}`;
  await bridgeWorker.evaluate(async (key) => {
    await chrome.storage.local.remove([key]);
  }, storageKey);
}

async function activateChromeTab(bridgeWorker, tabId) {
  await bridgeWorker.evaluate(async (id) => {
    await chrome.tabs.update(id, { active: true });
  }, tabId);
  await delay(100);
}

async function restartCapturePage(page, captureUrl, options = {}) {
  const navigationAttempts = options.navigationAttempts ?? NAVIGATION_ATTEMPTS;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 45000;
  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
  return gotoWithFallback(
    page,
    captureUrl,
    { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs },
    navigationAttempts
  );
}

function responseMediaSize(headers) {
  const contentRange = String(headers['content-range'] || '');
  const rangeTotal = Number(contentRange.match(/\/([0-9]+)\s*$/)?.[1]);
  if (Number.isFinite(rangeTotal) && rangeTotal > 0) return rangeTotal;

  const contentLength = Number(headers['content-length'] || 0);
  return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
}

function responseMediaFormat(url, contentType) {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('mpegurl')) return { format: 'm3u8', type: 'hls' };

  let extension = '';
  try {
    extension = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  } catch {
    extension = '';
  }

  if (['m3u8', 'm3u'].includes(extension)) return { format: extension, type: 'hls' };
  if (['3gp', 'avi', 'flv', 'mkv', 'mov', 'mp4', 'ogg', 'ogv', 'webm', 'wmv'].includes(extension)) {
    return { format: extension, type: extension };
  }
  if (normalizedType.startsWith('video/')) {
    const subtype = normalizedType.split('/')[1]?.split(';')[0]?.replace(/^x-/, '') || 'mp4';
    return { format: subtype, type: subtype };
  }
  return null;
}

function observePageMedia(page, observedItems) {
  const byUrl = new Map();
  const onResponse = async (response) => {
    try {
      if (response.status() < 200 || response.status() >= 300) return;
      const url = response.url();
      const responseHeaders = await response.allHeaders().catch(() => response.headers());
      const contentType = String(responseHeaders['content-type'] || '').split(';')[0].trim().toLowerCase();
      const mediaFormat = responseMediaFormat(url, contentType);
      if (!mediaFormat) return;

      const request = response.request();
      const requestHeaders = await request.allHeaders().catch(() => request.headers());
      let name = 'video';
      try {
        name = decodeURIComponent(path.basename(new URL(url).pathname)) || name;
      } catch {
        // Mantem o nome neutro se a URL nao puder ser interpretada.
      }

      const item = {
        url,
        method: request.method() === 'POST' ? 'POST' : 'GET',
        format: mediaFormat.format,
        type: mediaFormat.type,
        contentType: contentType || `video/${mediaFormat.format}`,
        name,
        size: responseMediaSize(responseHeaders),
        headers: requestHeaders,
        observedByPlaywright: true
      };
      byUrl.set(url, item);
      observedItems.splice(0, observedItems.length, ...byUrl.values());
    } catch {
      // Respostas encerradas durante um redirecionamento nao invalidam a captura.
    }
  };

  page.on('response', onResponse);
  return () => page.off('response', onResponse);
}

function mergeFetchVItems(...groups) {
  const merged = new Map();
  for (const item of groups.flat()) {
    if (!isFetchVVideoItem(item)) continue;
    const fingerprint = fetchVItemFingerprint(item);
    const previous = merged.get(fingerprint);
    if (!previous || (Number(item.size) || 0) > (Number(previous.size) || 0)) {
      merged.set(fingerprint, item);
    }
  }
  return [...merged.values()];
}

async function waitForFetchVItems(
  bridgeWorker,
  tabId,
  row,
  observedItems = [],
  timeoutMs = FETCHV_CAPTURE_TIMEOUT_MS
) {
  const started = Date.now();
  let lastItems = [];
  let settledFingerprint = '';
  let settleAfter = 0;
  const selectionOptions = {
    minimumBytes: FETCHV_MIN_VIDEO_BYTES,
    allowUnverified: isYes(process.env.FETCHV_ALLOW_UNVERIFIED_MEDIA)
  };

  while (Date.now() - started < timeoutMs) {
    const storageItems = await readFetchVStorageItems(bridgeWorker, tabId);
    lastItems = mergeFetchVItems(observedItems, storageItems);
    const selected = selectFetchVItem(lastItems, row, selectionOptions);
    if (selected) {
      const fingerprint = fetchVItemFingerprint(selected);
      if (fingerprint !== settledFingerprint) {
        settledFingerprint = fingerprint;
        settleAfter = Date.now() + FETCHV_CAPTURE_SETTLE_MS;
      } else if (Date.now() >= settleAfter) {
        return { items: lastItems, selected };
      }
    }
    await delay(500);
  }

  return { items: lastItems, selected: null };
}

async function captureFetchVItemsWithRefresh(page, bridgeWorker, tabId, row, options = {}) {
  const {
    allowRefresh = true,
    beforeCapture,
    captureTimeoutMs = FETCHV_CAPTURE_TIMEOUT_MS,
    contextLabel = row.filename || row.title || row.episodeUrl || 'episodio',
    reloadUrl,
    observedItems = []
  } = options;

  const runCapture = async () => {
    if (beforeCapture) await beforeCapture();
    await nudgeMediaPlayback(page, row);
    return waitForFetchVItems(bridgeWorker, tabId, row, observedItems, captureTimeoutMs);
  };

  let result = await runCapture();
  if (result.selected || !allowRefresh) return result;

  console.log(`FetchV: nada capturado em ${contextLabel}; atualizando a pagina e tentando de novo.`);
  await clearFetchVStorageItems(bridgeWorker, tabId);
  if (reloadUrl) {
    await restartCapturePage(page, reloadUrl);
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  result = await runCapture();
  return result;
}

function fetchVDownloaderUrl(item) {
  const route = String(item?.type || '').toLowerCase() === 'hls'
    ? 'm3u8downloader'
    : 'videodownloader';
  return `${FETCHV_SITE}/${FETCHV_LANG}/${route}`;
}

function bytesLabel(size) {
  const value = Number(size) || 0;
  if (!value) return 'tamanho desconhecido';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}K`;
  if (value < 1024 * 1024 * 1024) return `${Math.round(value / 1024 / 1024)}M`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)}G`;
}

function sanitizeFilename(value, fallback = 'video') {
  const sanitized = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return sanitized || fallback;
}

function downloadExtensionForItem(item, suggestedFilename = '') {
  const suggestedExtension = path.extname(suggestedFilename).replace('.', '').toLowerCase();
  if (suggestedExtension) return suggestedExtension;

  const format = String(item?.format || item?.type || '').toLowerCase();
  const contentType = String(item?.contentType || '').toLowerCase();
  const extensions = {
    '3gp': '3gp',
    avi: 'avi',
    flv: 'flv',
    hls: 'mp4',
    m3u: 'mp4',
    m3u8: 'mp4',
    mkv: 'mkv',
    mov: 'mov',
    mp4: 'mp4',
    ogg: 'ogg',
    ogv: 'ogv',
    webm: 'webm',
    wmv: 'wmv'
  };

  if (extensions[format]) return extensions[format];
  if (contentType.includes('webm')) return 'webm';
  if (contentType.includes('ogg')) return 'ogg';
  return 'mp4';
}

function fetchVDownloadFilename(filename, item, suggestedFilename = '') {
  const safeName = sanitizeFilename(filename || suggestedFilename || item?.name || 'video');
  if (/\.(?:3gp|avi|flv|mkv|mov|mp4|ogg|ogv|webm|wmv)$/i.test(safeName)) return safeName;
  return `${safeName}.${downloadExtensionForItem(item, suggestedFilename)}`;
}

async function uniqueDownloadPath(directory, filename) {
  const extension = path.extname(filename);
  const basename = path.basename(filename, extension);
  let candidate = path.join(directory, filename);
  let counter = 1;

  while (await fileExists(candidate)) {
    candidate = path.join(directory, `${basename} (${counter})${extension}`);
    counter += 1;
  }

  return candidate;
}

function registerFetchVDownloadSaver(page, item, filename) {
  page.on('download', async (download) => {
    try {
      await mkdir(FETCHV_DOWNLOAD_DIR, { recursive: true });
      const finalFilename = fetchVDownloadFilename(filename, item, download.suggestedFilename());
      const targetPath = await uniqueDownloadPath(FETCHV_DOWNLOAD_DIR, finalFilename);
      await download.saveAs(targetPath);
      console.log(`Download salvo em: ${targetPath}`);
    } catch (error) {
      console.log(`Falha ao salvar download renomeado: ${error.message}`);
    }
  });
}

async function writeFetchVQueue(bridgeWorker, item, row, initiator, captureId) {
  const queue = {
    ...item,
    captureId,
    initiator,
    title: String(row.title || row.episodeUrl || initiator || '').trim()
  };

  await bridgeWorker.evaluate(async (nextQueue) => {
    await chrome.storage.local.set({ queue: nextQueue });
  }, queue);
}

async function installFetchVQueueListener(page) {
  await page.addInitScript(() => {
    const state = { received: false, payload: null };
    Object.defineProperty(globalThis, '__fetchVQueueCapture', {
      configurable: true,
      value: state
    });
    const channel = new BroadcastChannel('fetchv-temporary-channel');
    channel.addEventListener('message', (event) => {
      state.received = true;
      state.payload = event.data;
    });
    addEventListener('beforeunload', () => channel.close(), { once: true });
  });
}

async function verifyFetchVQueueReceipt(page, captureId, item) {
  await page.waitForFunction(() => globalThis.__fetchVQueueCapture?.received === true, null, {
    timeout: 15000
  });
  const rawPayload = await page.evaluate(() => globalThis.__fetchVQueueCapture?.payload ?? null);
  let payload = rawPayload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  if (!payload || payload.captureId !== captureId) {
    throw new Error('A aba do FetchV recebeu outra tarefa; renomeacao cancelada por seguranca.');
  }
  if (String(payload.url || '') !== String(item.url || '')) {
    throw new Error('A aba do FetchV recebeu outra midia; renomeacao cancelada por seguranca.');
  }
}

async function renameFetchVDownloaderFile(page, filename) {
  const filenameLabel = page.locator('[selector="filename"]').first();
  const renameButton = page.locator('[selector="rename"]').first();
  const filenameInput = page.locator('[selector="filename-input"]').first();
  const confirmButton = page.locator('[selector="rename-confirm"]').first();

  await filenameLabel.waitFor({ state: 'visible', timeout: 60000 });
  await renameButton.click({ timeout: 10000 });
  await filenameInput.waitFor({ state: 'visible', timeout: 10000 });
  await filenameInput.fill(filename);
  await confirmButton.click({ timeout: 10000 });
  await page.waitForFunction((expected) => {
    const label = document.querySelector('[selector="filename"]');
    return label?.textContent?.trim() === expected;
  }, filename, { timeout: 10000 });

  const finalName = await filenameLabel.textContent().then((value) => value?.trim() || '');
  if (finalName !== filename) {
    throw new Error(`FetchV manteve o nome ${finalName || 'vazio'}; esperado ${filename}.`);
  }
  return finalName;
}

async function openFetchVDownloaderTab(context, bridgeWorker, item, row, filename, initiator, captureId) {
  const downloaderPage = await context.newPage();
  try {
    await installFetchVQueueListener(downloaderPage);
    registerFetchVDownloadSaver(downloaderPage, item, filename);
    await writeFetchVQueue(bridgeWorker, item, row, initiator, captureId);
    await downloaderPage.goto(fetchVDownloaderUrl(item), {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    await verifyFetchVQueueReceipt(downloaderPage, captureId, item);
    const finalName = await renameFetchVDownloaderFile(downloaderPage, filename);
    return { page: downloaderPage, finalName };
  } catch (error) {
    await downloaderPage.close().catch(() => {});
    throw error;
  }
}

async function prepareFetchVDownloaderTabs(context, rows, extensionId) {
  validateFetchVRows(rows);
  const openedTabs = [];
  const keepSourceTabs = isYes(process.env.FETCHV_KEEP_SOURCE_TABS);
  const bridgeWorker = await getFetchVBridgeWorker(context, extensionId);
  const failureReasons = new Array(rows.length);
  console.log(`FetchV: capturando ate ${FETCHV_CAPTURE_CONCURRENCY} episodio(s) em paralelo.`);

  const captureRow = async (row, index, options = {}) => {
    const isolated = options.isolated === true;
    failureReasons[index] = null;
    const filename = row.filename;
    const captureDirectSource = row.sourceType === 'direct-video';
    const captureUrl = captureDirectSource
      ? `${new URL(row.sourceUrl).origin}/.fetchv-capture/${randomUUID()}.html`
      : row.sourceUrl;
    const capturePage = await context.newPage();
    const observedItems = [];
    const stopObservingMedia = observePageMedia(capturePage, observedItems);
    if (captureDirectSource) {
      await capturePage.route(captureUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html><head><title>FetchV verified media</title></head><body></body></html>'
        });
      });
    }
    if (isYes(process.env.FETCHV_DEBUG)) {
      capturePage.on('response', (response) => {
        if (row.videoId && mediaUrlContainsVideoId(response.url(), row.videoId)) {
          console.log(`FetchV debug ${filename}: resposta ${response.status()} ${response.url()}`);
        }
      });
      capturePage.on('requestfailed', (request) => {
        if (row.videoId && mediaUrlContainsVideoId(request.url(), row.videoId)) {
          console.log(`FetchV debug ${filename}: requisicao falhou ${request.url()} (${request.failure()?.errorText || 'erro desconhecido'})`);
        }
      });
    }

    try {
      console.log(`FetchV ${index + 1}/${rows.length}: capturando ${shortUrl(captureUrl)} como ${filename}`);
      const navigationAttempts = isolated ? 1 : NAVIGATION_ATTEMPTS;
      const navigationTimeoutMs = isolated ? 15000 : 45000;
      await gotoWithFallback(
        capturePage,
        captureUrl,
        { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs },
        navigationAttempts
      );
      const marker = `[fetchv-${randomUUID()}]`;
      const tab = await getChromeTabForPage(bridgeWorker, capturePage, marker);
      await clearFetchVStorageItems(bridgeWorker, tab.id);
      await restartCapturePage(capturePage, captureUrl, { navigationAttempts, navigationTimeoutMs });

      const { items, selected } = await captureFetchVItemsWithRefresh(
        capturePage,
        bridgeWorker,
        tab.id,
        row,
        {
          allowRefresh: !isolated,
          captureTimeoutMs: isolated ? Math.min(FETCHV_CAPTURE_TIMEOUT_MS, 10000) : FETCHV_CAPTURE_TIMEOUT_MS,
          contextLabel: `${filename} (${shortUrl(captureUrl)})`,
          reloadUrl: captureUrl,
          observedItems,
          beforeCapture: async () => {
            await activateChromeTab(bridgeWorker, tab.id);
            if (captureDirectSource) {
              await injectVerifiedDirectVideo(capturePage, row);
            }
          }
        }
      );

      if (!selected) {
        const ignored = items.slice(0, 5)
          .map((item) => `${item.name || item.url} (${bytesLabel(item.size)})`)
          .join('; ');
        console.log(`FetchV: nenhuma midia verificada para ${filename}${ignored ? `; ignoradas: ${ignored}` : ''}.`);
        failureReasons[index] = {
          retryable: items.length > 0,
          reason: items.length > 0 ? 'midia conflitante no storage da aba' : 'nenhuma midia observada'
        };
        return null;
      }

      console.log(`FetchV: ${filename} capturado de ${shortUrl(selected.url)} (${String(selected.type || selected.format).toUpperCase()}/${bytesLabel(selected.size)}).`);
      return {
        captureId: randomUUID(),
        filename,
        index,
        initiator: capturePage.url(),
        item: selected,
        row
      };
    } catch (error) {
      console.log(`FetchV: falha no episodio ${filename}: ${error.message}`);
      failureReasons[index] = {
        retryable: /aba|storage|target.*closed|err_aborted|frame.*detached/i.test(error.message),
        reason: error.message
      };
      return null;
    } finally {
      stopObservingMedia();
      if (!keepSourceTabs) await capturePage.close().catch(() => {});
    }
  };

  const captures = await mapWithConcurrency(rows, FETCHV_CAPTURE_CONCURRENCY, captureRow);
  const retryableIndexes = captures
    .map((capture, index) => (capture ? -1 : index))
    .filter((index) => index >= 0 && failureReasons[index]?.retryable)
    .slice(0, FETCHV_ISOLATED_RETRY_LIMIT);

  if (retryableIndexes.length) {
    console.log(`FetchV: repetindo ${retryableIndexes.length} episodio(s) isoladamente para evitar conflito entre abas.`);
    for (const index of retryableIndexes) {
      captures[index] = await captureRow(rows[index], index, { isolated: true });
    }
  }

  const skippedRetries = captures.filter((capture) => !capture).length;
  if (skippedRetries) {
    console.log(`FetchV: ${skippedRetries} episodio(s) permaneceram sem midia verificada; nenhuma aba sera renomeada para eles.`);
  }

  const usedMedia = new Map();
  for (const capture of captures.filter(Boolean)) {
    const fingerprint = fetchVItemFingerprint(capture.item);
    if (usedMedia.has(fingerprint)) {
      console.log(`FetchV: ${capture.filename} bloqueado; a mesma midia ja foi usada por ${usedMedia.get(fingerprint)}.`);
      continue;
    }
    usedMedia.set(fingerprint, capture.filename);

    try {
      const { page: downloaderPage, finalName } = await openFetchVDownloaderTab(
        context,
        bridgeWorker,
        capture.item,
        capture.row,
        capture.filename,
        capture.initiator,
        capture.captureId
      );
      openedTabs.push({
        filename: capture.filename,
        name: finalName || capture.filename,
        url: downloaderPage.url()
      });
      console.log(`FetchV: aba pronta para ${capture.filename}${finalName ? ` (${finalName})` : ''}.`);
    } catch (error) {
      console.log(`FetchV: renomeacao de ${capture.filename} cancelada: ${error.message}`);
    }
  }

  return openedTabs;
}

function csvEscape(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

async function writeManifest(rows) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'episodes.json'), JSON.stringify(rows, null, 2), 'utf8');
  const csv = [
    ['episode', 'video_id', 'title', 'episode_url', 'quality', 'source_type', 'source_label', 'source_url', 'filename'].map(csvEscape).join(','),
    ...rows.map((row) => [
      row.episode,
      row.videoId,
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

async function installAdRequestBlocking(context) {
  if (process.env.ANITUBE_BLOCK_ADS === '0') return { blocked: 0 };
  const stats = { blocked: 0 };
  const adRoutePattern = /(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagservices\.com|imasdk\.googleapis\.com|adnxs\.com|adsrvr\.org|adsterra\.com|criteo\.(?:com|net)|exoclick\.(?:com|net)|popads\.net|popcash\.net|pubmatic\.com|rubiconproject\.com|taboola\.com|outbrain\.com)/i;
  await context.route(adRoutePattern, async (route) => {
    stats.blocked += 1;
    await route.abort('blockedbyclient').catch(() => {});
  });
  return stats;
}

async function main() {
  const shouldClean = (process.env.CLEAN_OUTPUT || await ask('Limpar resultados antigos de output antes de comecar? [s/N] ', 'n')).trim().toLowerCase();
  if (shouldClean === 's' || shouldClean === 'sim') {
    await cleanPreviousOutput();
    console.log(`Resultados antigos removidos de: ${OUT_DIR}`);
  }

  const animeUrl = normalizeUrl(process.env.ANITUBE_URL || await ask(`URL do anime [${DEFAULT_URL}]: `, DEFAULT_URL));
  const anitubeHostResolverRules = await buildAnitubeHostResolverRules(animeUrl);
  const foundFetchVExtension = await findFetchVExtension();
  const fetchVExtension = await stageFetchVExtension(foundFetchVExtension);
  const foundDarkReaderExtension = await findDarkReaderExtension();
  const darkReaderExtension = await stageDarkReaderExtension(foundDarkReaderExtension);
  const foundUBlockOriginLiteExtension = await findUBlockOriginLiteExtension();
  const uBlockOriginLiteExtension = await stageUBlockOriginLiteExtension(foundUBlockOriginLiteExtension);
  if (fetchVExtension) {
    console.log(`FetchV encontrada em: ${fetchVExtension.sourcePath}`);
    console.log(`FetchV preparada em: ${fetchVExtension.path}${fetchVExtension.id ? ` (${fetchVExtension.id})` : ''}`);
  } else {
    console.log('FetchV nao foi encontrada automaticamente. Use FETCHV_EXTENSION_PATH para informar a pasta da extensao.');
  }
  if (darkReaderExtension) {
    console.log(`Dark Reader encontrado em: ${darkReaderExtension.sourcePath}`);
    console.log(`Dark Reader preparado em: ${darkReaderExtension.path}${darkReaderExtension.id ? ` (${darkReaderExtension.id})` : ''}`);
  } else {
    console.log('Dark Reader nao foi encontrado automaticamente. Instale no Chrome ou use DARK_READER_EXTENSION_PATH.');
  }
  if (uBlockOriginLiteExtension) {
    console.log(`uBlock Origin Lite encontrado em: ${uBlockOriginLiteExtension.sourcePath}`);
    console.log(`uBlock Origin Lite preparado em: ${uBlockOriginLiteExtension.path} (${uBlockOriginLiteExtension.id})`);
  } else {
    console.log('uBlock Origin Lite nao foi encontrado. Instale a extensao oficial ou use UBLOCK_ORIGIN_LITE_EXTENSION_PATH.');
  }

  const extensionsToLoad = [fetchVExtension, uBlockOriginLiteExtension, darkReaderExtension].filter(Boolean);
  const extensionPaths = extensionsToLoad.map((extension) => extension.path).join(',');
  const chromiumArgs = [];
  const launchOptions = {
    acceptDownloads: true,
    headless: false,
    viewport: { width: 1366, height: 768 },
    channel: 'chrome'
  };

  if (extensionsToLoad.length) {
    delete launchOptions.channel;
    launchOptions.ignoreDefaultArgs = ['--disable-extensions'];
    chromiumArgs.push(
      `--disable-extensions-except=${extensionPaths}`,
      `--load-extension=${extensionPaths}`
    );
    console.log(`Usando Chromium do Playwright para carregar ${extensionsToLoad.length} extensao(oes).`);
  }
  if (anitubeHostResolverRules) {
    chromiumArgs.push(`--host-resolver-rules=${anitubeHostResolverRules}`);
    console.log(`Fallback DNS do AniTube ativo: ${anitubeHostResolverRules}`);
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    ...launchOptions,
    args: chromiumArgs
  });
  const adBlockStats = await installAdRequestBlocking(context);

  const page = context.pages()[0] || await context.newPage();
  const fetchVExtensionId = fetchVExtension?.id;
  if (fetchVExtension && !fetchVExtensionId) {
    console.log('Nao consegui descobrir o ID da FetchV; a preparacao automatica das abas pode ficar indisponivel.');
  }

  try {
    const episodes = await collectEpisodes(page, animeUrl);
    if (!episodes.length) throw new Error('Nenhum episodio encontrado.');
    const unresolvedEpisodes = episodes.filter((episode) => !Number.isFinite(episode.number));
    if (unresolvedEpisodes.length) {
      throw new Error(`Nao identifiquei o numero de ${unresolvedEpisodes.length} episodio(s); nenhum nome sera adivinhado. URLs: ${unresolvedEpisodes.map((episode) => episode.url).join(', ')}`);
    }

    console.log(`\nEncontrei ${episodes.length} episodio(s).`);
    episodes.forEach((episode, index) => {
      console.log(`${String(index + 1).padStart(2, '0')}. ${episode.title} -> ${episode.url}`);
    });

    const qualities = await detectQualityOptions(page, episodes[0]);
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

    console.log(`Mapeando fontes com ate ${ANITUBE_MAPPING_CONCURRENCY} paginas em paralelo.`);
    const rows = await mapWithConcurrency(episodes, ANITUBE_MAPPING_CONCURRENCY, async (episode, index) => {
      const mappingPage = await context.newPage();
      try {
        console.log(`Mapeando episodio ${index + 1}/${episodes.length}: ${episode.url}`);
        const selected = await getSelectedQualitySource(mappingPage, episode, selectedQuality);
        return {
          episode: episode.number,
          videoId: episode.videoId,
          title: episode.title,
          episodeUrl: episode.url,
          quality: selectedQuality.label,
          sourceType: selected?.sourceType || '',
          sourceLabel: selected?.sourceLabel || '',
          sourceUrl: selected?.sourceUrl || '',
          filename: episodeFilename(episode)
        };
      } finally {
        await mappingPage.close().catch(() => {});
      }
    });

    await writeManifest(rows);
    console.log(`\nManifestos salvos em:`);
    console.log(`- ${path.join(OUT_DIR, 'episodes.json')}`);
    console.log(`- ${path.join(OUT_DIR, 'episodes.csv')}`);

    const shouldPrepareFetchV = isYes(process.env.FETCHV_PREPARE || await ask('\nPreparar abas do FetchV e renomear sem baixar? [s/N] ', 'n'));
    if (shouldPrepareFetchV) {
      if (!fetchVExtension) {
        throw new Error('FetchV nao encontrada. Instale a extensao no Chrome ou informe FETCHV_EXTENSION_PATH.');
      }
      if (!fetchVExtensionId) {
        throw new Error('Nao consegui descobrir o ID da FetchV. Informe FETCHV_EXTENSION_ID se estiver usando uma pasta customizada.');
      }

      const openedTabs = await prepareFetchVDownloaderTabs(context, rows, fetchVExtensionId);
      console.log(`\nFetchV preparado: ${openedTabs.length}/${rows.length} aba(s) aberta(s) e renomeada(s).`);
      if (openedTabs.length) {
        console.log('Nenhum download final foi iniciado; as abas ficaram abertas para voce conferir.');
        await ask('Pressione ENTER para fechar o Chromium...');
      }
    } else {
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
    }
  } finally {
    console.log(`Requisicoes publicitarias bloqueadas pelo filtro complementar: ${adBlockStats.blocked}.`);
    await context.close();
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\nErro: ${error.message}`);
  rl.close();
  process.exitCode = 1;
});
