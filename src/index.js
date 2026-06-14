import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DEFAULT_URL = 'https://www.anitube.vip/animes-dublado/komi-san-wa-comyushou-desu-dublado';
const OUT_DIR = path.resolve('output');
const PROFILE_DIR = path.resolve('chromium-profile');
const STAGED_FETCHV_EXTENSION_DIR = path.resolve('.fetchv-extension');
const STAGED_DARK_READER_EXTENSION_DIR = path.resolve('.dark-reader-extension');
const DEFAULT_DOWNLOAD_DIR = path.join(process.env.USERPROFILE || process.cwd(), 'Downloads');
const FETCHV_DOWNLOAD_DIR = path.resolve(process.env.FETCHV_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR);
const FETCHV_SITE = 'https://fetchv.net';
const FETCHV_EXTENSION_ID = 'nfmmmhanepmpifddlkkmihkalkoekpfd';
const DARK_READER_EXTENSION_ID = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';
const FETCHV_LANG = process.env.FETCHV_LANG || 'pt';
const FETCHV_CAPTURE_TIMEOUT_MS = Number(process.env.FETCHV_CAPTURE_TIMEOUT_MS || 45000);

const rl = createInterface({ input, output });

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

async function gotoWithFallback(page, url, options) {
  const errors = [];
  for (const candidate of [url, alternateHostUrl(url)].filter(Boolean)) {
    try {
      return await page.goto(candidate, options);
    } catch (error) {
      errors.push(`${candidate}: ${summarizeNavigationError(error)}`);
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

function pageUrl(baseUrl, pageNumber) {
  if (pageNumber <= 0) return baseUrl;
  return `${baseUrl}/page/${pageNumber}`;
}

function pageNumberForIndex(pageIndex) {
  if (pageIndex <= 0) return 0;
  return pageIndex + 1;
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

  for (let pageIndex = 0; pageIndex <= 200; pageIndex += 1) {
    const pageNumber = pageNumberForIndex(pageIndex);
    const url = pageUrl(baseUrl, pageNumber);
    if (seenPages.has(url)) break;
    seenPages.add(url);

    console.log(`Lendo pagina ${pageNumber === 0 ? 'base' : pageNumber}: ${url}`);
    const response = await gotoWithFallback(page, url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((error) => {
      if (pageNumber === 0) {
        throw new Error(`Nao consegui abrir ${url}. Detalhe do navegador: ${error.message}`);
      }
      return null;
    });
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
        return rel.includes('next') || /(^|\s)(proximo|pr[oó]ximo|next)(\s|$)|[»›]/i.test(text);
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
  await gotoWithFallback(page, episodeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
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
  await gotoWithFallback(page, episode.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await activateQuality(page, quality);
  return extractSelectedQualitySource(page, quality);
}

async function detectLoadedExtensionId(context) {
  let worker = context.serviceWorkers()
    .find((item) => item.url().startsWith('chrome-extension://'));

  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
  }

  const match = worker?.url().match(/^chrome-extension:\/\/([^/]+)/);
  return match?.[1] || null;
}

async function getFetchVBridgeWorker(context, extensionId) {
  const extensionUrl = `chrome-extension://${extensionId}/`;
  let worker = context.serviceWorkers()
    .find((item) => item.url().startsWith(extensionUrl));

  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
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
  await targetPage.evaluate((titleMarker) => {
    document.title = `${titleMarker} ${document.title || ''}`;
  }, marker).catch(() => {});

  await targetPage.waitForTimeout(250);

  const byTitle = await bridgeWorker.evaluate(async (titleMarker) => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs
      .filter((tab) => tab.title?.startsWith(titleMarker))
      .map((tab) => ({
        id: tab.id,
        index: tab.index,
        title: tab.title,
        url: tab.url
      }));
  }, marker);

  if (byTitle[0]?.id) return byTitle[0];

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

  if (byUrl[0]?.id) return byUrl[0];
  throw new Error(`Nao consegui localizar a aba do Chrome para ${currentUrl}`);
}

async function nudgeMediaPlayback(page) {
  await page.waitForTimeout(1000);

  for (const frame of page.frames()) {
    await frame.evaluate(async () => {
      const videos = [...document.querySelectorAll('video')];
      await Promise.all(videos.map(async (video) => {
        try {
          video.muted = true;
          video.playsInline = true;
          await video.play();
        } catch {
          // Algumas paginas bloqueiam play programatico; a captura ainda pode vir pelo carregamento normal.
        }
      }));
    }).catch(() => {});
  }

  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

function isFetchVVideoItem(item) {
  const contentType = String(item?.contentType || '').toLowerCase();
  const type = String(item?.type || '').toLowerCase();
  const format = String(item?.format || '').toLowerCase();
  const videoFormats = new Set(['hls', 'm3u8', 'm3u', 'mp4', 'webm', 'avi', 'ogg', 'ogv', 'flv', 'mkv', '3gp', 'mov', 'wmv']);
  return contentType.startsWith('video/') || videoFormats.has(type) || videoFormats.has(format);
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function scoreFetchVItem(item, row) {
  const type = String(item.type || item.format || '').toLowerCase();
  const itemHost = hostnameOf(item.url);
  const sourceHost = hostnameOf(row.sourceUrl);
  const nameAndUrl = `${item.name || ''} ${item.url || ''}`.toLowerCase();
  let score = 0;

  if (type === 'mp4') score += 1000;
  if (type === 'hls' || type === 'm3u8') score += 800;
  if (type === 'webm' || type === 'mkv' || type === 'mov') score += 500;
  if (row.sourceUrl && item.url === row.sourceUrl) score += 300;
  if (sourceHost && itemHost === sourceHost) score += 100;
  if (/\b(segment|chunk)\b|\.m4s\b/i.test(nameAndUrl)) score -= 200;

  score += Math.min(Number(item.size) || 0, 2_000_000_000) / 1_000_000;
  return score;
}

function selectFetchVItem(items, row) {
  return [...items]
    .filter(isFetchVVideoItem)
    .sort((a, b) => scoreFetchVItem(b, row) - scoreFetchVItem(a, row))[0] || null;
}

async function readFetchVStorageItems(bridgeWorker, tabId) {
  const storageKey = `storage${tabId}`;
  const storage = await bridgeWorker.evaluate(async (key) => {
    const result = await chrome.storage.local.get([key]);
    return result[key] || {};
  }, storageKey);

  return Object.values(storage || {});
}

async function waitForFetchVItems(bridgeWorker, tabId, row, timeoutMs = FETCHV_CAPTURE_TIMEOUT_MS) {
  const started = Date.now();
  let lastItems = [];

  while (Date.now() - started < timeoutMs) {
    const items = await readFetchVStorageItems(bridgeWorker, tabId);
    lastItems = items.filter(isFetchVVideoItem);
    if (selectFetchVItem(lastItems, row)) return lastItems;
    await delay(1000);
  }

  return lastItems;
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
  if (path.extname(safeName)) return safeName;
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

async function writeFetchVQueue(bridgeWorker, item, row, initiator) {
  const queue = {
    ...item,
    initiator,
    title: String(row.title || row.episodeUrl || initiator || '').trim()
  };

  await bridgeWorker.evaluate(async (nextQueue) => {
    await chrome.storage.local.set({ queue: nextQueue });
  }, queue);
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
    const input = document.querySelector('[selector="filename-input"]');
    return label?.textContent?.trim() === expected || input?.value === expected;
  }, filename, { timeout: 10000 }).catch(() => {});

  return filenameLabel.textContent().then((value) => value?.trim() || '').catch(() => '');
}

async function openFetchVDownloaderTab(context, bridgeWorker, item, row, filename, initiator) {
  await writeFetchVQueue(bridgeWorker, item, row, initiator);

  const downloaderPage = await context.newPage();
  registerFetchVDownloadSaver(downloaderPage, item, filename);
  await downloaderPage.goto(fetchVDownloaderUrl(item), {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });
  await downloaderPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const finalName = await renameFetchVDownloaderFile(downloaderPage, filename);
  return { page: downloaderPage, finalName };
}

async function prepareFetchVDownloaderTabs(context, rows, selectedQuality, extensionId) {
  const openedTabs = [];
  const keepSourceTabs = isYes(process.env.FETCHV_KEEP_SOURCE_TABS);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const filename = row.filename || String(index + 1).padStart(2, '0');
    const captureUrl = row.sourceUrl || row.episodeUrl;

    if (!captureUrl) {
      console.log(`FetchV: pulando episodio ${filename}, sem URL capturada.`);
      continue;
    }

    console.log(`FetchV ${index + 1}/${rows.length}: abrindo ${captureUrl} e renomeando como ${filename}`);
    const capturePage = await context.newPage();

    try {
      await gotoWithFallback(capturePage, captureUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await capturePage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      const bridgeWorker = await getFetchVBridgeWorker(context, extensionId);
      const marker = `[fetchv-${Date.now()}-${index}]`;
      const tab = await getChromeTabForPage(bridgeWorker, capturePage, marker);

      await nudgeMediaPlayback(capturePage);
      let items = await waitForFetchVItems(bridgeWorker, tab.id, row);
      let selected = selectFetchVItem(items, row);

      if (!selected && row.sourceType === 'direct-video' && row.episodeUrl) {
        console.log(`FetchV: tentando capturar o episodio ${filename} pela pagina original.`);
        await gotoWithFallback(capturePage, row.episodeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await capturePage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await activateQuality(capturePage, selectedQuality);
        await nudgeMediaPlayback(capturePage);
        items = await waitForFetchVItems(bridgeWorker, tab.id, row);
        selected = selectFetchVItem(items, row);
      }

      if (!selected) {
        console.log(`FetchV: nenhum video capturado para ${filename}.`);
        continue;
      }

      console.log(`FetchV: capturado ${selected.name || selected.url} (${String(selected.type || selected.format).toUpperCase()}/${bytesLabel(selected.size)}).`);
      const { page: downloaderPage, finalName } = await openFetchVDownloaderTab(
        context,
        bridgeWorker,
        selected,
        row,
        filename,
        capturePage.url()
      );

      openedTabs.push({
        filename,
        name: finalName || filename,
        url: downloaderPage.url()
      });
      console.log(`FetchV: aba pronta para ${filename}${finalName ? ` (${finalName})` : ''}.`);
    } catch (error) {
      console.log(`FetchV: falha no episodio ${filename}: ${error.message}`);
    } finally {
      if (!keepSourceTabs) {
        await capturePage.close().catch(() => {});
      }
    }
  }

  return openedTabs;
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
  const foundFetchVExtension = await findFetchVExtension();
  const fetchVExtension = await stageFetchVExtension(foundFetchVExtension);
  const foundDarkReaderExtension = await findDarkReaderExtension();
  const darkReaderExtension = await stageDarkReaderExtension(foundDarkReaderExtension);
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

  const extensionsToLoad = [fetchVExtension, darkReaderExtension].filter(Boolean);
  const extensionPaths = extensionsToLoad.map((extension) => extension.path).join(',');
  const launchOptions = {
    acceptDownloads: true,
    headless: false,
    viewport: { width: 1366, height: 768 },
    channel: 'chrome'
  };

  if (extensionsToLoad.length) {
    delete launchOptions.channel;
    launchOptions.ignoreDefaultArgs = ['--disable-extensions'];
    launchOptions.args = [
      `--disable-extensions-except=${extensionPaths}`,
      `--load-extension=${extensionPaths}`
    ];
    console.log(`Usando Chromium do Playwright para carregar ${extensionsToLoad.length} extensao(oes).`);
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    ...launchOptions,
    args: launchOptions.args || []
  });

  const page = context.pages()[0] || await context.newPage();
  const fetchVExtensionId = fetchVExtension?.id;
  if (fetchVExtension && !fetchVExtensionId) {
    console.log('Nao consegui descobrir o ID da FetchV; a preparacao automatica das abas pode ficar indisponivel.');
  }

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

    const shouldPrepareFetchV = isYes(process.env.FETCHV_PREPARE || await ask('\nPreparar abas do FetchV e renomear sem baixar? [s/N] ', 'n'));
    if (shouldPrepareFetchV) {
      if (!fetchVExtension) {
        throw new Error('FetchV nao encontrada. Instale a extensao no Chrome ou informe FETCHV_EXTENSION_PATH.');
      }
      if (!fetchVExtensionId) {
        throw new Error('Nao consegui descobrir o ID da FetchV. Informe FETCHV_EXTENSION_ID se estiver usando uma pasta customizada.');
      }

      const openedTabs = await prepareFetchVDownloaderTabs(context, rows, selectedQuality, fetchVExtensionId);
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
    await context.close();
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\nErro: ${error.message}`);
  rl.close();
  process.exitCode = 1;
});
