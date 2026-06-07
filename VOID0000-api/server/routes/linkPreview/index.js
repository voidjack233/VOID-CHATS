import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import net from 'net';
import express from 'express';

const router = express.Router();

const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_OEMBED_BYTES = 128 * 1024;
const MAX_REDIRECTS = 3;
const PREVIEW_TIMEOUT_MS = 5000;
const MAX_TEXT_LENGTH = 280;
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);
const KNOWN_FALLBACK_TITLES = new Map([
  ['forms.office.com', 'Microsoft Forms'],
  ['office.com', 'Microsoft Office'],
  ['microsoft.com', 'Microsoft'],
  ['youtu.be', 'YouTube'],
  ['youtube.com', 'YouTube'],
]);

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const text = decodeHtmlEntities(value)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1).trim()}…` : text;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => {
      const charCode = Number(code);
      return Number.isFinite(charCode) ? String.fromCodePoint(charCode) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const charCode = Number.parseInt(code, 16);
      return Number.isFinite(charCode) ? String.fromCodePoint(charCode) : '';
    });
}

function parseCandidateUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getNormalizedHostname(parsedUrl) {
  const hostname = parsedUrl.hostname.toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function getRequestPort(parsedUrl) {
  const port = parsedUrl.port
    ? Number(parsedUrl.port)
    : parsedUrl.protocol === 'https:'
      ? 443
      : 80;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('Blocked preview URL'), { status: 400 });
  }

  return port;
}

function isPrivateIPv4(address) {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224 ||
    a === 255
  );
}

function isPrivateIPv6(address) {
  const normalized = address.toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff')
  ) {
    return true;
  }

  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) {
      return isPrivateIPv4(mapped);
    }
  }

  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

async function assertPublicHttpUrl(parsedUrl) {
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw Object.assign(new Error('Blocked preview URL'), { status: 400 });
  }

  const hostname = getNormalizedHostname(parsedUrl);

  if (
    hostname === 'localhost' ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw Object.assign(new Error('Blocked preview host'), { status: 400 });
  }

  const directIpFamily = net.isIP(hostname);
  if (directIpFamily && isPrivateAddress(hostname)) {
    throw Object.assign(new Error('Blocked preview host'), { status: 400 });
  }

  const addresses = directIpFamily
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw Object.assign(new Error('Blocked preview host'), { status: 400 });
  }

  return {
    address: addresses[0].address,
    family: net.isIP(addresses[0].address) || undefined,
    hostname,
    port: getRequestPort(parsedUrl),
  };
}

function getHeaderValue(headers, name) {
  const value = headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : null;
}

function destroyResponseBody(response) {
  response?.body?.destroy?.();
}

async function fetchPinnedResponse(url, options = {}) {
  const target = await assertPublicHttpUrl(url);
  const client = url.protocol === 'https:' ? https : http;
  const requestHeaders = {
    ...(options.headers || {}),
    Host: url.host,
  };
  const requestOptions = {
    hostname: target.address,
    family: target.family,
    port: target.port,
    method: options.method || 'GET',
    path: `${url.pathname || '/'}${url.search || ''}`,
    headers: requestHeaders,
  };

  if (url.protocol === 'https:' && !net.isIP(target.hostname)) {
    // Connect to the validated IP, but keep the original hostname for SNI and
    // certificate verification. This closes the DNS rebinding window between
    // validation and the actual outbound request.
    requestOptions.servername = target.hostname;
  }

  return new Promise((resolve, reject) => {
    const req = client.request(requestOptions, (res) => {
      const status = res.statusCode || 0;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: {
          get: (name) => getHeaderValue(res.headers, name),
        },
        body: res,
      });
    });

    req.setTimeout(PREVIEW_TIMEOUT_MS, () => {
      const timeoutError = Object.assign(new Error('Preview request timed out'), { name: 'AbortError' });
      req.destroy(timeoutError);
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchHtmlWithRedirects(initialUrl) {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchPinnedResponse(currentUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2',
        'User-Agent': 'VOID0000-LinkPreview/1.0',
      },
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      destroyResponseBody(response);
      if (!location) {
        throw Object.assign(new Error('Preview redirect missing destination'), { status: 422 });
      }
      currentUrl = new URL(location, currentUrl);
      if (!['http:', 'https:'].includes(currentUrl.protocol)) {
        throw Object.assign(new Error('Preview redirect target is not allowed'), { status: 400 });
      }
      continue;
    }

    if (!response.ok) {
      destroyResponseBody(response);
      throw Object.assign(new Error('Preview target did not respond successfully'), { status: 422 });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      destroyResponseBody(response);
      throw Object.assign(new Error('Preview target is not an HTML page'), {
        status: 415,
        finalUrl: currentUrl.toString(),
        contentType,
      });
    }

    return {
      finalUrl: currentUrl,
      html: await readLimitedResponseText(response, contentType),
    };
  }

  throw Object.assign(new Error('Preview target redirected too many times'), { status: 422 });
}

async function readLimitedResponseBuffer(response, maxBytes, options = {}) {
  const stream = response.body || response;
  if (!stream) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.off('data', handleData);
      stream.off('end', finish);
      stream.off('error', handleError);
      resolve(Buffer.concat(chunks));
    };
    const stopReading = () => {
      finish();
      stream.destroy?.();
    };
    const handleError = (error) => {
      if (settled) return;
      settled = true;
      stream.off('data', handleData);
      stream.off('end', finish);
      stream.off('error', handleError);
      reject(error);
    };
    const handleData = (value) => {
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        stopReading();
        return;
      }

      const chunk = Buffer.from(value);
      const nextChunk = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(nextChunk);
      total += nextChunk.byteLength;

      const previewText = options.stopAtHead === false
        ? ''
        : Buffer.concat(chunks).toString('utf8');
      if (
        (options.stopAtHead !== false && /<\/head\s*>/i.test(previewText)) ||
        total >= maxBytes ||
        chunk.byteLength > remaining
      ) {
        stopReading();
      }
    };

    stream.on('data', handleData);
    stream.on('end', finish);
    stream.on('error', handleError);
  });
}

async function readLimitedResponseText(response, contentType) {
  const buffer = await readLimitedResponseBuffer(response, MAX_HTML_BYTES, { stopAtHead: true });
  const charset = contentType.match(/charset=([^;\s]+)/i)?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function fetchJsonWithLimit(url) {
  try {
    const response = await fetchPinnedResponse(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json,*/*;q=0.2',
        'User-Agent': 'VOID0000-LinkPreview/1.0',
      },
    });

    if (!response.ok) {
      destroyResponseBody(response);
      return null;
    }

    const buffer = await readLimitedResponseBuffer(response, MAX_OEMBED_BYTES, { stopAtHead: false });
    return JSON.parse(new TextDecoder('utf-8').decode(buffer));
  } catch {
    return null;
  }
}

async function fetchYoutubePreview(url) {
  const hostname = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(hostname)) {
    return null;
  }

  const oembedUrl = new URL('https://www.youtube.com/oembed');
  oembedUrl.searchParams.set('format', 'json');
  oembedUrl.searchParams.set('url', url.toString());

  const data = await fetchJsonWithLimit(oembedUrl);
  if (!data || typeof data !== 'object') {
    return null;
  }

  const thumbnail = await normalizePublicResourceUrl(data.thumbnail_url, url);
  const title = normalizeText(data.title);
  if (!title && !thumbnail) {
    return null;
  }

  return {
    url: url.toString(),
    title,
    description: null,
    image: thumbnail,
    site_name: 'YouTube',
    favicon: 'https://www.youtube.com/s/desktop/f506bd45/img/favicon_32x32.png',
  };
}

function parseAttributes(tag) {
  const attrs = {};
  const attrRegex = /([^\s"'=<>`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(attrRegex)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function getMetaContent(html, keys) {
  const normalizedKeys = keys.map((key) => key.toLowerCase());

  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (normalizedKeys.includes(key) && attrs.content) {
      return attrs.content;
    }
  }
  return null;
}

function getTitle(html) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch?.[1] || null;
}

function getHostnameLabel(url) {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function getFallbackTitle(url) {
  const host = getHostnameLabel(url);
  const exactTitle = KNOWN_FALLBACK_TITLES.get(host);
  if (exactTitle) {
    return exactTitle;
  }

  const suffixTitle = Array.from(KNOWN_FALLBACK_TITLES.entries())
    .find(([knownHost]) => host.endsWith(`.${knownHost}`))?.[1];
  if (suffixTitle) {
    return suffixTitle;
  }

  return host;
}

function getFallbackDescription(url) {
  const path = decodeHtmlEntities(url.pathname || '').replace(/\/+/g, '/');
  if (path && path !== '/') {
    try {
      return normalizeText(decodeURIComponent(path)) || 'Open link';
    } catch {
      return normalizeText(path) || 'Open link';
    }
  }

  return 'Open link';
}

function createFallbackPreview(url, favicon = null) {
  const host = getHostnameLabel(url);
  return {
    url: url.toString(),
    title: getFallbackTitle(url),
    description: getFallbackDescription(url),
    image: null,
    site_name: host,
    favicon,
  };
}

function isLikelyImageUrl(url) {
  return /\.(?:apng|avif|gif|jpe?g|png|svg|webp)$/i.test(url.pathname);
}

function createScrapeFailureFallbackPreview(url, options = {}) {
  const fallback = createFallbackPreview(url);
  const contentType = typeof options.contentType === 'string' ? options.contentType : '';
  const isImageContent = /^image\//i.test(contentType);

  return {
    ...fallback,
    image: isImageContent || isLikelyImageUrl(url) ? url.toString() : fallback.image,
  };
}

function getIconHref(html) {
  return getLinkHrefByRel(html, ['icon', 'shortcut', 'apple-touch-icon']);
}

async function firstPublicResourceUrl(values, baseUrl) {
  for (const value of values.flat()) {
    const normalized = await normalizePublicResourceUrl(value, baseUrl);
    if (normalized) return normalized;
  }

  return null;
}

function getLinkHrefByRel(html, wantedRels) {
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag[0]);
    const rel = String(attrs.rel || '').toLowerCase();
    const relParts = rel.split(/\s+/);

    if (relParts.some((value) => wantedRels.includes(value))) {
      return attrs.href || null;
    }
  }

  return null;
}

function getVideoPoster(html) {
  for (const tag of html.matchAll(/<video\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag[0]);
    if (attrs.poster) {
      return attrs.poster;
    }
  }

  return null;
}

function collectJsonLdImageCandidates(value, output = []) {
  if (!value || output.length >= 10) return output;

  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
      output.push(value);
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdImageCandidates(item, output);
      if (output.length >= 10) break;
    }
    return output;
  }

  if (typeof value === 'object') {
    for (const key of ['thumbnailUrl', 'thumbnail', 'image', 'url', 'contentUrl']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        collectJsonLdImageCandidates(value[key], output);
        if (output.length >= 10) break;
      }
    }
  }

  return output;
}

function getJsonLdImageCandidates(html) {
  const candidates = [];

  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const jsonText = decodeHtmlEntities(match[1].trim());
      const data = JSON.parse(jsonText);
      collectJsonLdImageCandidates(data, candidates);
    } catch {
      // Ignore invalid structured data.
    }
  }

  return candidates;
}

async function normalizePublicResourceUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return null;

  try {
    const parsed = new URL(decodeHtmlEntities(value.trim()), baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    await assertPublicHttpUrl(parsed);
    return parsed.toString();
  } catch {
    return null;
  }
}

async function extractPreview(html, finalUrl) {
  const title = normalizeText(
    getMetaContent(html, ['og:title', 'twitter:title']) || getTitle(html),
  );
  const description = normalizeText(
    getMetaContent(html, ['og:description', 'description', 'twitter:description']),
  );
  const siteName = normalizeText(getMetaContent(html, ['og:site_name'])) || finalUrl.hostname.replace(/^www\./, '');
  const image = await firstPublicResourceUrl([
    getMetaContent(html, [
      'og:image',
      'og:image:url',
      'og:image:secure_url',
      'twitter:image',
      'twitter:image:src',
      'thumbnail',
      'thumbnailurl',
    ]),
    getMetaContent(html, [
      'image',
      'itemprop:image',
      'itemprop:thumbnailurl',
    ]),
    getLinkHrefByRel(html, ['image_src']),
    getVideoPoster(html),
    ...getJsonLdImageCandidates(html),
  ], finalUrl);
  const favicon = await normalizePublicResourceUrl(getIconHref(html), finalUrl);

  if (!title && !description && !image) {
    return createFallbackPreview(finalUrl, favicon);
  }

  return {
    url: finalUrl.toString(),
    title,
    description,
    image,
    site_name: siteName,
    favicon,
  };
}

router.get('/', async (req, res) => {
  const parsedUrl = parseCandidateUrl(req.query.url);
  if (!parsedUrl) {
    return res.status(400).json({
      success: false,
      error: 'A valid http or https URL is required.',
    });
  }

  try {
    const providerPreview = await fetchYoutubePreview(parsedUrl);
    if (providerPreview) {
      res.set('Cache-Control', 'private, max-age=300');
      return res.json({ success: true, preview: providerPreview });
    }

    const { finalUrl, html } = await fetchHtmlWithRedirects(parsedUrl);
    const preview = await extractPreview(html, finalUrl);
    res.set('Cache-Control', 'private, max-age=300');
    return res.json({ success: true, preview });
  } catch (error) {
    const status = Number(error?.status) || (error?.name === 'AbortError' ? 504 : 500);
    if (status !== 400) {
      try {
        const fallbackUrl = parseCandidateUrl(error?.finalUrl) || parsedUrl;
        await assertPublicHttpUrl(fallbackUrl);
        const fallbackPreview = createScrapeFailureFallbackPreview(fallbackUrl, {
          contentType: error?.contentType,
        });
        res.set('Cache-Control', 'private, max-age=300');
        return res.json({ success: true, preview: fallbackPreview });
      } catch {
        // Preserve security-sensitive failures as hard errors.
      }
    }

    return res.status(status).json({
      success: false,
      error: status >= 500 ? 'Unable to fetch link preview right now.' : error.message,
    });
  }
});

export default router;
