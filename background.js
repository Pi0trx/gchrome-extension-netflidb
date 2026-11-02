importScripts("config.js");

const OMDB_BASE_URL = "https://www.omdbapi.com/";
const CACHE_PREFIX = "omdb_cache:";
const EXHAUSTED_KEYS_STORAGE_KEY = "omdb_exhausted_keys";

// Auto-delete cached ratings after 3 days (in addition to clearing when the browser closes)
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
// Temporarily skip a key that hit its 1k daily limit for 1 hour before re-checking primary
const KEY_COOLDOWN_MS = 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

const API_KEYS = (Array.isArray(OMDB_API_KEYS) ? OMDB_API_KEYS : [])
  .map((k) => String(k).trim())
  .filter(Boolean);

/** @type {Map<string, Promise<object>>} */
const inflightRequests = new Map();
let lastPruneTime = 0;

// Clear any legacy persistent cache from chrome.storage.local on install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.clear().catch(() => {});
  pruneExpiredSessionCache().catch(() => {});
});

// Ensure session storage starts clean whenever the browser launches a new session
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session.clear().catch(() => {});
  chrome.storage.local.clear().catch(() => {});
});

function normalizeTitleKey(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cleanNetflixTitle(title) {
  return title
    .replace(
      /\s*[:\-–—]\s*(limited series|miniseries|season\s+\d+|part\s+\d+|volume\s+\d+|collection|book\s+\d+)$/i,
      ""
    )
    .replace(/\s*\((u\.?s\.?|u\.?k\.?|us|uk|au|ca|\d{4})\)\s*$/i, "")
    .trim();
}

function buildCacheKey(title, mediaType) {
  return `${CACHE_PREFIX}${normalizeTitleKey(title)}|${mediaType || "any"}`;
}

function parseFirstYear(yearStr) {
  if (!yearStr) return null;
  const match = String(yearStr).match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function parseImdbVotes(rawVotes) {
  if (rawVotes === undefined || rawVotes === null || rawVotes === "N/A") {
    return null;
  }
  const stripped = String(rawVotes).replace(/,/g, "").trim();
  if (!/^\d+$/.test(stripped)) return null;
  const parsed = parseInt(stripped, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function isYearCompatible(cachedYearStr, requestedYear) {
  if (!requestedYear) return true;
  const cachedYear = parseFirstYear(cachedYearStr);
  const reqYear = parseFirstYear(requestedYear);
  if (!cachedYear || !reqYear) return true;
  // Allow up to 2 years difference (festival premiere vs Netflix release); disambiguate true remakes
  return Math.abs(cachedYear - reqYear) <= 2;
}

async function getExhaustedKeysMap() {
  try {
    const data = await chrome.storage.session.get(EXHAUSTED_KEYS_STORAGE_KEY);
    return data?.[EXHAUSTED_KEYS_STORAGE_KEY] || {};
  } catch {
    return {};
  }
}

async function markKeyExhausted(apiKey) {
  try {
    const map = await getExhaustedKeysMap();
    map[apiKey] = Date.now() + KEY_COOLDOWN_MS;
    await chrome.storage.session.set({ [EXHAUSTED_KEYS_STORAGE_KEY]: map });
  } catch {
    // Ignore storage write errors
  }
}

async function clearKeyExhausted(apiKey) {
  try {
    const map = await getExhaustedKeysMap();
    if (apiKey in map) {
      delete map[apiKey];
      await chrome.storage.session.set({ [EXHAUSTED_KEYS_STORAGE_KEY]: map });
    }
  } catch {
    // Ignore storage write errors
  }
}

async function getOrderedCandidateKeys() {
  const exhaustedMap = await getExhaustedKeysMap();
  const now = Date.now();
  const active = [];
  const coolingDown = [];

  for (const key of API_KEYS) {
    if (exhaustedMap[key] && now < exhaustedMap[key]) {
      coolingDown.push(key);
    } else {
      active.push(key);
    }
  }

  // Try non-exhausted keys in priority order first; keep cooling-down keys as last resort if quota reset early
  return [...active, ...coolingDown];
}

async function queryOmdbSingleKey(apiKey, params) {
  const url = new URL(OMDB_BASE_URL);
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Invalid JSON from OMDb (HTTP ${response.status})`);
  }

  const errMsg = String(data?.Error || "");
  const isKeyOrLimitError =
    response.status === 401 ||
    response.status === 403 ||
    response.status === 429 ||
    /limit reached|invalid api key/i.test(errMsg);

  if (isKeyOrLimitError) {
    const err = new Error(errMsg || `OMDb key error (HTTP ${response.status})`);
    err.shouldFailover = true;
    throw err;
  }

  return data;
}

async function queryOmdbWithFailover(params) {
  if (API_KEYS.length === 0) {
    throw new Error("No OMDb API keys configured.");
  }

  const orderedKeys = await getOrderedCandidateKeys();
  let lastError = null;

  for (const apiKey of orderedKeys) {
    try {
      const data = await queryOmdbSingleKey(apiKey, params);
      await clearKeyExhausted(apiKey);
      return data;
    } catch (err) {
      lastError = err;
      if (err?.shouldFailover) {
        await markKeyExhausted(apiKey);
        continue;
      }
      // Network/timeout error is not key-specific; do not burn remaining keys on an offline connection
      throw err;
    }
  }

  throw lastError || new Error("All OMDb API keys exhausted.");
}

async function lookupOmdbRating({ title, mediaType, year }) {
  const rawTitle = title.trim();
  const cleanedTitle = cleanNetflixTitle(rawTitle);

  // 1. Primary lookup: exact title + mediaType (resolves 95%+ of titles in 1 single API request)
  const primaryData = await queryOmdbWithFailover({
    t: rawTitle,
    ...(mediaType === "movie" || mediaType === "series" ? { type: mediaType } : {})
  });

  if (primaryData?.Response === "True") {
    // If movie year is known (detail modal) and returned movie is a different-era remake (>2 yrs apart), refine by year
    if (mediaType === "movie" && year && !isYearCompatible(primaryData.Year, year)) {
      const yearData = await queryOmdbWithFailover({
        t: rawTitle,
        type: "movie",
        y: year
      });
      if (yearData?.Response === "True") {
        return yearData;
      }
    }
    return primaryData;
  }

  // 2. Fallback: cleaned title without type restriction (handles ': Limited Series', specials, miniseries)
  const fallbackTitle = cleanedTitle || rawTitle;
  if (mediaType || fallbackTitle.toLowerCase() !== rawTitle.toLowerCase()) {
    const untypedData = await queryOmdbWithFailover({ t: fallbackTitle });
    if (untypedData?.Response === "True") {
      return untypedData;
    }
  }

  // 3. Final fallback: search endpoint (?s=) for punctuation/subtitle differences
  const searchData = await queryOmdbWithFailover({
    s: fallbackTitle,
    ...(mediaType === "movie" || mediaType === "series" ? { type: mediaType } : {})
  });

  if (searchData?.Response === "True" && Array.isArray(searchData.Search) && searchData.Search.length > 0) {
    const normTarget = normalizeTitleKey(fallbackTitle);
    const reqYear = mediaType === "movie" ? parseFirstYear(year) : null;

    const bestHit =
      searchData.Search.find((item) => {
        const sameTitle = normalizeTitleKey(item.Title || "") === normTarget;
        const yearOk = !reqYear || isYearCompatible(item.Year, reqYear);
        return sameTitle && yearOk;
      }) ||
      searchData.Search.find((item) => !reqYear || isYearCompatible(item.Year, reqYear)) ||
      searchData.Search[0];

    if (bestHit?.imdbID) {
      const byId = await queryOmdbWithFailover({ i: bestHit.imdbID });
      if (byId?.Response === "True") {
        return byId;
      }
    }
  }

  return null;
}

async function pruneExpiredSessionCache() {
  lastPruneTime = Date.now();
  const all = await chrome.storage.session.get(null);
  const now = Date.now();
  const expiredKeys = Object.keys(all).filter(
    (k) => k.startsWith(CACHE_PREFIX) && (!all[k]?.expiresAt || now >= all[k].expiresAt)
  );
  if (expiredKeys.length > 0) {
    await chrome.storage.session.remove(expiredKeys);
  }
}

function maybePruneSessionCache() {
  if (Date.now() - lastPruneTime >= PRUNE_INTERVAL_MS) {
    pruneExpiredSessionCache().catch(() => {});
  }
}

async function getImdbRating({ title, mediaType = "", year = "" }) {
  if (!title || !title.trim()) {
    return { rating: "N/A", imdbVotes: null, awardsText: "" };
  }

  maybePruneSessionCache();

  const cacheKey = buildCacheKey(title, mediaType);
  const yearSpecificKey = mediaType === "movie" && year ? `${cacheKey}|${year}` : null;
  const keysToRead = yearSpecificKey ? [yearSpecificKey, cacheKey] : [cacheKey];

  const cachedItems = await chrome.storage.session.get(keysToRead);
  const now = Date.now();

  if (yearSpecificKey && cachedItems[yearSpecificKey]) {
    if (now < cachedItems[yearSpecificKey].expiresAt && "awardsText" in cachedItems[yearSpecificKey]) {
      return { ...cachedItems[yearSpecificKey], fromCache: true };
    }
    chrome.storage.session.remove(yearSpecificKey).catch(() => {});
  }

  const baseCached = cachedItems[cacheKey];
  if (baseCached) {
    if (now >= baseCached.expiresAt || !("awardsText" in baseCached)) {
      chrome.storage.session.remove(cacheKey).catch(() => {});
    } else if (mediaType !== "movie" || isYearCompatible(baseCached.matchedYear, year)) {
      return { ...baseCached, fromCache: true };
    }
  }

  const dedupeKey = yearSpecificKey || cacheKey;
  if (inflightRequests.has(dedupeKey)) {
    return inflightRequests.get(dedupeKey);
  }

  const promise = (async () => {
    try {
      const match = await lookupOmdbRating({ title, mediaType, year });
      const rating =
        match?.imdbRating && match.imdbRating !== "N/A"
          ? String(match.imdbRating).trim()
          : "N/A";
      const imdbVotes = parseImdbVotes(match?.imdbVotes);
      const awardsText =
        match?.Awards && match.Awards !== "N/A"
          ? String(match.Awards).trim()
          : "";

      const entry = {
        rating,
        imdbVotes,
        awardsText,
        imdbId: match?.imdbID || null,
        matchedTitle: match?.Title || title,
        matchedYear: match?.Year || year || null,
        expiresAt: Date.now() + CACHE_TTL_MS
      };

      const toStore = { [cacheKey]: entry };
      if (yearSpecificKey) {
        toStore[yearSpecificKey] = entry;
      }
      await chrome.storage.session.set(toStore);

      return entry;
    } catch (err) {
      // Do not cache transient network or exhausted-quota failures
      return {
        rating: "N/A",
        imdbVotes: null,
        awardsText: "",
        error: err?.message || "Lookup failed"
      };
    } finally {
      inflightRequests.delete(dedupeKey);
    }
  })();

  inflightRequests.set(dedupeKey, promise);
  return promise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_IMDB_RATING") {
    getImdbRating(message.payload || {})
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ rating: "N/A", imdbVotes: null, awardsText: "", error: err?.message })
      );
    return true;
  }

  return false;
});
