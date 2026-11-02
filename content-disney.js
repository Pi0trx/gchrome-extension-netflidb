(() => {
  "use strict";

  const HOVER_SETTLE_MS = 280;
  /** @type {WeakMap<Element, number>} */
  const hoverTimers = new WeakMap();
  let scanScheduled = false;

  document.documentElement.classList.add("nf-platform-disney");

  const NON_TITLE_TOKENS = new Set([
    "disney+",
    "disney plus",
    "play",
    "trailer",
    "watch",
    "watchlist",
    "details",
    "suggested",
    "extras",
    "episodes",
    "hd",
    "4k",
    "uhd",
    "4k ultra hd",
    "hdr10",
    "dolby vision",
    "dolby atmos",
    "imax enhanced",
    "cc",
    "ad",
    "0+",
    "6+",
    "9+",
    "12+",
    "14+",
    "16+",
    "18+"
  ]);

  function isActivelyWatching() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      return true;
    }
    if (/^\/(play|video)(\/|$)/i.test(window.location.pathname)) {
      return true;
    }
    if (
      document.querySelector(
        'disney-web-player, .btm-media-player, [data-testid="web-player"], .hudson-wrapper video'
      )
    ) {
      return true;
    }
    return false;
  }

  function cleanDisneyTitle(raw) {
    if (!raw || typeof raw !== "string") return "";
    const cleaned = raw
      .replace(/\u00a0/g, " ")
      // Strip Disney+ screen-reader tile suffixes & prefixes
      .replace(/^watch\s+/i, "")
      .replace(/\s+select\s+for\s+details.*$/i, "")
      .replace(/\s*[,.\-–—|]\s*(?:rated|age\s+rating|release[d]?|season\s+\d+|new\s+episode).*$/i, "")
      .replace(/\s*[|\-–—]\s*disney\+.*$/i, "")
      .replace(/\s+logo$/i, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned || cleaned.length > 180) return "";
    if (NON_TITLE_TOKENS.has(cleaned.toLowerCase())) return "";
    if (/^(?:tv-[a-z0-9]+|pg(?:-13)?|nc-17|\d+\+)$/i.test(cleaned)) return "";
    return cleaned;
  }

  function isDetailRoute() {
    return /\/(movies|series|browse\/entity-|entity)\b/i.test(window.location.pathname);
  }

  function findDetailHero() {
    return document.querySelector(
      '[data-testid="details-hero"], [data-testid="detail-metadata"], [data-testid="hero-container"], #details_index, article'
    ) || (isDetailRoute() ? document.querySelector("main") : null);
  }

  function isInsideInteractiveOrGrid(el) {
    return Boolean(
      el.closest(
        'button, [role="button"], [role="tablist"], [data-testid*="play"], [data-testid*="trailer"], [data-testid*="set-item"], [data-gv2containerkey]'
      )
    );
  }

  function findDisneyDetailMetadataRow(hero) {
    if (!hero) return null;

    const explicitSelectors = [
      '[data-testid="details-metadata-row"]',
      '[data-testid="detail-metadata"] .meta-data',
      '[data-testid="hero-metadata"]',
      ".details-hero .meta-data",
      ".meta-data"
    ];

    for (const sel of explicitSelectors) {
      const match = hero.querySelector(sel);
      if (match && !isInsideInteractiveOrGrid(match)) {
        return match;
      }
    }

    // Fallback: locate the thin compact metadata row underneath the logo containing year + duration/seasons/rating
    const candidates = hero.querySelectorAll("div, p, ul");
    for (const el of candidates) {
      if (isInsideInteractiveOrGrid(el)) continue;
      if (el.querySelector("button, h1, p p")) continue;

      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 110) continue;

      const hasYear = /\b(19|20)\d{2}\b/.test(text);
      const hasDurationOrSeasons =
        /\b(\d+\s*h(?:\s*\d+\s*m)?|\d+\s*m(?:in)?|\d+\s*seasons?|\d+\s*episodes?)\b/i.test(text);
      const hasRatingBadge = Boolean(
        el.querySelector("img") || /\b(\d+\+|PG-13|PG|TV-[A-Z0-9]+)\b/.test(text)
      );

      if (hasYear && (hasDurationOrSeasons || hasRatingBadge)) {
        // Prefer the deepest matching flex/inline row rather than an outer hero wrapper
        const childMatch = Array.from(el.children).find((child) => {
          const ct = (child.textContent || "").replace(/\s+/g, " ").trim();
          return (
            ct.length > 0 &&
            ct.length <= 110 &&
            /\b(19|20)\d{2}\b/.test(ct) &&
            (/\b(\d+\s*h|\d+\s*m|\d+\s*seasons?)\b/i.test(ct) || Boolean(child.querySelector("img")))
          );
        });
        return childMatch || el;
      }
    }

    return null;
  }

  function extractDisneyDetailTitle(hero) {
    // 1. Title treatment / logo image alt inside the hero
    const logoSelectors = [
      '[data-testid="details-title-treatment"] img[alt]',
      '[data-testid*="title-treatment"] img[alt]',
      '[data-testid*="detail-logo"] img[alt]',
      '[data-testid*="logo"] img[alt]'
    ];
    for (const sel of logoSelectors) {
      const cleaned = cleanDisneyTitle(hero.querySelector(sel)?.getAttribute("alt") || "");
      if (cleaned) return cleaned;
    }

    // 2. Text heading inside the hero
    const heading = hero.querySelector('h1, [data-testid="detail-metadata-title"], [data-testid*="title"] h1');
    const headingTitle = cleanDisneyTitle(heading?.textContent || "");
    if (headingTitle) return headingTitle;

    // 3. Large hero title logo image above metadata (ignoring small maturity/format icons)
    const heroImgs = hero.querySelectorAll("picture img[alt], img[alt]");
    for (const img of heroImgs) {
      if (img.closest('[data-testid*="set-item"], button, [role="button"]')) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.width < 60 && rect.height < 40) continue;
      const altTitle = cleanDisneyTitle(img.getAttribute("alt") || "");
      if (altTitle) return altTitle;
    }

    // 4. OpenGraph / document.title fallback on detail routes
    if (isDetailRoute()) {
      const ogTitle = cleanDisneyTitle(
        document.querySelector('meta[property="og:title"]')?.getAttribute("content") || ""
      );
      if (ogTitle) return ogTitle;

      const docTitle = cleanDisneyTitle(document.title || "");
      if (docTitle) return docTitle;
    }

    return "";
  }

  function extractDisneyYearAndType(hero, metadataRow) {
    const rowText = metadataRow?.textContent || "";
    const yearMatch = rowText.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[0] : "";

    let mediaType = "";
    const path = window.location.pathname.toLowerCase();
    if (path.includes("/movies/")) {
      mediaType = "movie";
    } else if (path.includes("/series/")) {
      mediaType = "series";
    } else if (/\b(\d+\s*seasons?|\d+\s*episodes?)\b/i.test(rowText)) {
      mediaType = "series";
    } else if (/\b(\d+\s*h(?:\s*\d+\s*m)?|\d+\s*m(?:in)?)\b/i.test(rowText)) {
      mediaType = "movie";
    } else if (document.querySelector('[data-testid*="episodes"], [aria-controls*="episodes"]')) {
      mediaType = "series";
    }

    return { year, mediaType };
  }

  function processDetailPage() {
    if (!isDetailRoute()) return;

    const hero = findDetailHero();
    if (!hero) return;

    const metadataRow = findDisneyDetailMetadataRow(hero);
    if (!metadataRow) return;

    const title = extractDisneyDetailTitle(hero);
    if (!title) return;

    const { year, mediaType } = extractDisneyYearAndType(hero, metadataRow);
    metadataRow.classList.add("nf-imdb-disney-meta-row");

    // Append our badge to the absolute end of the thin gray metadata row
    window.injectImdbBadge(title, year, mediaType, metadataRow, {
      isDetailModal: true,
      shouldAbort: isActivelyWatching
    });
  }

  function extractPosterTileInfo(tile) {
    const href = tile.getAttribute("href") || tile.querySelector("a[href]")?.getAttribute("href") || "";
    let mediaType = "";
    if (/\/movies\//i.test(href)) mediaType = "movie";
    else if (/\/series\//i.test(href)) mediaType = "series";

    const img = tile.querySelector("picture img[alt], img[alt]");
    const fromImg = cleanDisneyTitle(img?.getAttribute("alt") || "");
    if (fromImg) return { title: fromImg, mediaType };

    const aria =
      tile.getAttribute("aria-label") ||
      tile.querySelector("[aria-label]")?.getAttribute("aria-label") ||
      "";
    const fromAria = cleanDisneyTitle(aria);
    if (fromAria) return { title: fromAria, mediaType };

    const text = cleanDisneyTitle(tile.textContent || "");
    return { title: text, mediaType };
  }

  function handlePosterHover(event) {
    if (isActivelyWatching()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const tile = target.closest(
      'a[href*="/movies/"], a[href*="/series/"], a[href*="/browse/entity-"], [data-testid*="set-item"] a, [data-gv2containerkey] a'
    );
    if (!tile) return;

    // Skip CTA buttons or non-poster links
    const img = tile.querySelector("img");
    if (!img) return;
    if (hoverTimers.has(tile)) return;

    const existingPill = tile.querySelector(".nf-imdb-poster-pill");
    if (existingPill) return;

    const cancelTimer = () => {
      const timerId = hoverTimers.get(tile);
      if (timerId !== undefined) {
        clearTimeout(timerId);
        hoverTimers.delete(tile);
      }
    };

    tile.addEventListener("pointerleave", cancelTimer, { once: true, passive: true });

    const timerId = window.setTimeout(() => {
      hoverTimers.delete(tile);
      if (isActivelyWatching() || !tile.isConnected || !tile.matches(":hover")) {
        return;
      }

      const { title, mediaType } = extractPosterTileInfo(tile);
      if (!title) return;

      const posterContainer = img.closest("picture")?.parentElement || img.parentElement || tile;
      window.injectImdbPosterOverlay(title, "", mediaType, posterContainer, {
        shouldAbort: isActivelyWatching
      });
    }, HOVER_SETTLE_MS);

    hoverTimers.set(tile, timerId);
  }

  function scanDisneyDom() {
    scanScheduled = false;

    if (isActivelyWatching()) {
      window.clearImdbBadges?.();
      return;
    }

    processDetailPage();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(scanDisneyDom);
  }

  document.addEventListener("pointerover", handlePosterHover, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", scheduleScan, { passive: true });

  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    scheduleScan();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      scheduleScan();
    });
  }
})();

