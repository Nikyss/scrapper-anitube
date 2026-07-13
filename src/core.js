const VIDEO_FORMATS = new Set([
  'hls', 'm3u8', 'm3u', 'mp4', 'webm', 'avi', 'ogg', 'ogv', 'flv', 'mkv', '3gp', 'mov', 'wmv'
]);

const AD_HOST_PATTERNS = [
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)googleadservices\.com$/i,
  /(^|\.)googletagservices\.com$/i,
  /(^|\.)imasdk\.googleapis\.com$/i,
  /(^|\.)adnxs\.com$/i,
  /(^|\.)adsrvr\.org$/i,
  /(^|\.)adsterra\.com$/i,
  /(^|\.)criteo\.(com|net)$/i,
  /(^|\.)exoclick\.(com|net)$/i,
  /(^|\.)popads\.net$/i,
  /(^|\.)popcash\.net$/i,
  /(^|\.)pubmatic\.com$/i,
  /(^|\.)rubiconproject\.com$/i,
  /(^|\.)taboola\.com$/i,
  /(^|\.)outbrain\.com$/i
];

const AD_URL_PATTERN = /(?:^|[/?&_.=-])(ad(?:s|server|service|tag|unit|vertising)?|admob|adsense|ima|preroll|vast|vpaid)(?:[/?&_.=-]|$)/i;

function normalizeEpisodeLabel(value) {
  let decoded = String(value || '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A URL parcialmente codificada ainda pode conter um rotulo util.
  }

  return decoded
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function episodeNumbersIn(value) {
  const text = normalizeEpisodeLabel(value);
  if (!text) return [];

  const matches = [];
  const pattern = /\b(?:ep(?:isodio|isode)?|cap(?:itulo)?)\s*(?:n(?:o|umero)\.?\s*)?[#.:/-]?\s*([0-9]+(?:[.,][0-9]+)?)/gi;
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[1].replace(',', '.'));
    if (Number.isFinite(number) && number >= 0) matches.push(number);
  }
  return matches;
}

export function parseEpisodeNumber(...labels) {
  const numbers = [...new Set(labels.flatMap(episodeNumbersIn))];
  if (numbers.length > 1) {
    throw new Error(`Numeros de episodio conflitantes: ${numbers.join(', ')}`);
  }
  return numbers[0] ?? null;
}

export function videoIdFromUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    return pathname.match(/(?:^|\/)video\/(\d+)(?:\/|$)/i)?.[1] || '';
  } catch {
    return String(value || '').match(/(?:^|\/)video\/(\d+)(?:[/?#]|$)/i)?.[1] || '';
  }
}

export function mediaUrlContainsVideoId(value, videoId) {
  if (!videoId) return false;
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    return new RegExp(`(?:^|[^0-9])${videoId}(?:[^0-9]|$)`).test(pathname);
  } catch {
    return false;
  }
}

export function episodeFilename(episode) {
  if (!Number.isFinite(episode?.number) || episode.number < 0) return '';
  const number = episode.number;
  if (Number.isInteger(number)) return String(number).padStart(2, '0');

  const [integer, decimal] = String(number).split('.');
  return `${integer.padStart(2, '0')}.${decimal}`;
}

export function compareEpisodes(a, b) {
  const aKnown = Number.isFinite(a?.number);
  const bKnown = Number.isFinite(b?.number);
  if (aKnown && bKnown && a.number !== b.number) return a.number - b.number;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return (a?.discoveryIndex ?? 0) - (b?.discoveryIndex ?? 0);
}

export function listingPageNumbers(hrefs, baseUrl, maximumPages = 200) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  const pages = new Set();

  for (const href of hrefs) {
    let candidate;
    try {
      candidate = new URL(href, base);
    } catch {
      continue;
    }
    if (candidate.origin !== base.origin) continue;

    const match = candidate.pathname.match(/\/page\/([0-9]+)\/?$/);
    if (!match) continue;
    const parentPath = candidate.pathname.replace(/\/page\/[0-9]+\/?$/, '').replace(/\/$/, '');
    if (parentPath !== basePath) continue;

    const page = Number(match[1]);
    if (!Number.isSafeInteger(page) || page < 1) continue;
    if (page > maximumPages) {
      throw new Error(`Paginacao acima do limite seguro: pagina ${page} (maximo ${maximumPages})`);
    }
    pages.add(page);
  }

  return [...pages].sort((a, b) => a - b);
}

export function validateFetchVRows(rows) {
  const errors = [];
  const seenEpisodes = new Map();
  const seenFilenames = new Map();
  const seenSources = new Map();

  for (const row of rows) {
    const label = row?.episodeUrl || row?.title || 'linha sem URL';
    if (!Number.isFinite(row?.episode)) {
      errors.push(`${label}: numero do episodio nao identificado`);
    }
    if (!row?.filename) {
      errors.push(`${label}: nome do arquivo nao identificado`);
    }
    if (!row?.videoId) {
      errors.push(`${label}: ID interno do video nao identificado`);
    }
    if (!row?.sourceUrl) {
      errors.push(`${label}: fonte da qualidade escolhida nao identificada`);
    }
    if (!['direct-video', 'external'].includes(row?.sourceType)) {
      errors.push(`${label}: tipo de fonte invalido (${row?.sourceType || 'vazio'})`);
    }

    for (const [value, seen, kind] of [
      [row?.episode, seenEpisodes, 'episodio'],
      [row?.filename, seenFilenames, 'nome'],
      [row?.sourceUrl, seenSources, 'fonte']
    ]) {
      if (value === '' || value === null || value === undefined) continue;
      if (seen.has(value) && seen.get(value) !== row?.episodeUrl) {
        errors.push(`${label}: ${kind} duplicado com ${seen.get(value)} (${value})`);
      } else {
        seen.set(value, row?.episodeUrl);
      }
    }
  }

  if (errors.length) {
    throw new Error(`FetchV bloqueado para evitar nomes trocados:\n- ${errors.join('\n- ')}`);
  }
}

export function hostnameOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isLikelyAdUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (AD_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) return true;
    return AD_URL_PATTERN.test(`${url.pathname}${url.search}`);
  } catch {
    return AD_URL_PATTERN.test(String(value));
  }
}

export function isFetchVVideoItem(item) {
  const contentType = String(item?.contentType || '').toLowerCase();
  const type = String(item?.type || '').toLowerCase();
  const format = String(item?.format || '').toLowerCase();
  return contentType.startsWith('video/') || VIDEO_FORMATS.has(type) || VIDEO_FORMATS.has(format);
}

export function fetchVItemFingerprint(item) {
  return `${String(item?.type || item?.format || '').toLowerCase()}|${String(item?.url || '').trim()}`;
}

export function isLikelyAdItem(item) {
  return [item?.url, item?.initiator, item?.name, item?.title]
    .filter(Boolean)
    .some(isLikelyAdUrl);
}

export function fetchVIdentityStrength(item, row) {
  const itemUrl = String(item?.url || '');
  const sourceUrl = String(row?.sourceUrl || '');
  if (sourceUrl && itemUrl === sourceUrl) return 5;
  if (row?.videoId && mediaUrlContainsVideoId(itemUrl, row.videoId)) return 4;
  if (item?.initiator && sourceUrl && String(item.initiator) === sourceUrl) return 3;
  if (sourceUrl && hostnameOf(itemUrl) === hostnameOf(sourceUrl)) return 2;
  return 0;
}

export function isFetchVCandidate(item, row, options = {}) {
  if (!isFetchVVideoItem(item) || isLikelyAdItem(item)) return false;

  const {
    minimumBytes = 20 * 1024 * 1024,
    allowUnverified = false
  } = options;
  const type = String(item?.type || item?.format || '').toLowerCase();
  const isHls = type === 'hls' || type === 'm3u8' || type === 'm3u';
  const size = Number(item?.size) || 0;
  const identity = fetchVIdentityStrength(item, row);
  const exactDirectSource = row?.sourceType === 'direct-video'
    && String(item?.url || '') === String(row?.sourceUrl || '');

  if (!row?.videoId && !allowUnverified) return false;
  if (row?.videoId && identity < 4 && !allowUnverified) return false;
  if (!isHls && size < minimumBytes && !exactDirectSource) return false;
  return true;
}

export function scoreFetchVItem(item, row) {
  const type = String(item?.type || item?.format || '').toLowerCase();
  const identity = fetchVIdentityStrength(item, row);
  const nameAndUrl = `${item?.name || ''} ${item?.url || ''}`.toLowerCase();
  let score = identity * 10_000;

  if (type === 'hls' || type === 'm3u8' || type === 'm3u') score += 1_200;
  if (type === 'mp4') score += 1_000;
  if (type === 'webm' || type === 'mkv' || type === 'mov') score += 600;
  if (/\b(segment|chunk)\b|\.m4s\b/i.test(nameAndUrl)) score -= 500;
  score += Math.min(Number(item?.size) || 0, 2_000_000_000) / 1_000_000;
  return score;
}

export function selectFetchVItem(items, row, options = {}) {
  return [...items]
    .filter((item) => isFetchVCandidate(item, row, options))
    .sort((a, b) => scoreFetchVItem(b, row) - scoreFetchVItem(a, row))[0] || null;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
