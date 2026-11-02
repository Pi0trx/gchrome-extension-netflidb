(() => {
  "use strict";

  const HOVER_SETTLE_MS = 280;
  /** @type {WeakMap<Element, number>} */
  const hoverTimers = new WeakMap();
  let scanScheduled = false;

  document.documentElement.classList.add("nf-platform-skyshowtime");

  const NON_TITLE_TOKENS = new Set([
    "skyshowtime",
    "watch",
    "watch now",
    "play",
    "trailer",
    "resume",
    "my list",
    "episodes",
    "more like this",
    "hd",
    "uhd",
    "4k",
    "5.1",
    "dolby",
    "ad",
    "cc",
    "all",
    "7+",
    "12+",
    "16+",
    "18+"
  ]);

  function isActivelyWatching() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      return true;
    }
    if (/\/(watch\/playback|playback|player)\b/i.test(window.location.pathname)) {
      return true;
    }
    if (
      document.querySelector(
        '[data-testid="video-player"], .video-player-container, .gsp-player'
      )
    ) {
      return true;
    }
    return false;
  }

  function cleanSkyTitle(raw) {
    if (!raw || typeof raw !== "string") return "";
    const cleaned = raw
      .replace(/\u00a0/g, " ")
      .replace(/^watch\s+/i, "")
      .replace(/\s+online\s*$/i, "")
      .replace(/\s*[|\-–—]\s*skyshowtime.*$/i, "")
      .replace(/\s*[:\-–—]\s*season\s+\d+.*$/i, "")
      .replace(/\s+logo$/i, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned || cleaned.length > 180) return "";
    if (NON_TITLE_TOKENS.has(cleaned.toLowerCase())) return "";
    if (/^(?:\d+\+|pg(?:-13)?|hd|4k|uhd|5\.1)$/i.test(cleaned)) return "";
    return cleaned;
  }

  function isDetailRoute() {
    return /\/(watch\/asset|movies\/|series\/|tv\/|shows\/)/i.test(window.location.pathname);
  }

  function isInsideRailOrControls(el) {
    return Boolean(
      el.closest(
        'button, [role="button"], [role="tablist"], [data-testid*="rail"], [data-testid*="tile"], [data-testid*="carousel"]'
      )
    );
  }

  function findSkyHeroBanner() {
    const explicit = document.querySelector(
      '[data-testid*="hero"], [data-testid*="stage"], [data-testid*="billboard"], section[class*="Hero"], div[class*="HeroBanner"]'
    );
    if (explicit) return explicit;

    if (isDetailRoute()) {
      return document.querySelector("main section:first-of-type, main");
    }
    return null;
  }

  function findTechnicalBadgesRow(hero) {
    if (!hero) return null;

    const explicitSelectors = [
      '[data-testid="metadata-badges"]',
      '[data-testid*="technical-badges"]',
      '[data-testid*="badge-list"]',
      '[data-testid="hero-metadata"]',
      '[data-testid*="synopsis-metadata"]',
      '[data-testid*="entity-metadata"]'
    ];

    for (const sel of explicitSelectors) {
      const el = hero.querySelector(sel);
      if (el && !isInsideRailOrControls(el)) {
        return el;
      }
    }

    // Structural match: locate the flex row inside the Hero Banner holding technical/age badges (HD, 5.1, 16+, year/runtime)
    const containers = hero.querySelectorAll("ul, div");
    for (const el of containers) {
      if (isInsideRailOrControls(el)) continue;
      if (el.querySelector("h1, button, p p")) continue;

      const style = window.getComputedStyle(el);
      if (!style.display.includes("flex") && el.tagName !== "UL") continue;

      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 100) continue;

      const hasTechOrAgeBadge =
        Boolean(el.querySelector('[data-testid*="badge"], [data-testid*="rating"], img[alt]')) ||
        /\b(HD|UHD|4K|5\.1|AD|\d+\+|ALL)\b/.test(text);
      const hasMetaAtom =
        hasTechOrAgeBadge &&
        (el.children.length >= 2 || /\b((19|20)\d{2}|\d+\s*h|\d+\s*m|\d+\s*seasons?)\b/i.test(text));

      if (hasMetaAtom) {
        return el;
      }
    }

    return null;
  }

  function extractHeroTitle(hero) {
    const logoSelectors = [
      '[data-testid*="title-art"] img[alt]',
      '[data-testid*="hero-logo"] img[alt]',
      '[data-testid*="logo"] img[alt]',
      "h1 img[alt]"
    ];
    for (const sel of logoSelectors) {
      const cleaned = cleanSkyTitle(hero.querySelector(sel)?.getAttribute("alt") || "");
      if (cleaned) return cleaned;
    }

    const heading = hero.querySelector(
      'h1, [data-testid*="hero-title"], [data-testid="title"], [class*="HeroTitle"]'
    );
    const headingTitle = cleanSkyTitle(heading?.textContent || "");
    if (headingTitle) return headingTitle;

    const heroImgs = hero.querySelectorAll("picture img[alt], img[alt]");
    for (const img of heroImgs) {
      if (isInsideRailOrControls(img)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.width < 60 && rect.height < 40) continue;
      const altTitle = cleanSkyTitle(img.getAttribute("alt") || "");
      if (altTitle) return altTitle;
    }

    if (isDetailRoute()) {
      const ogTitle = cleanSkyTitle(
        document.querySelector('meta[property="og:title"]')?.getAttribute("content") || ""
      );
      if (ogTitle) return ogTitle;

      const docTitle = cleanSkyTitle(document.title || "");
      if (docTitle) return docTitle;
    }

    return "";
  }

  function extractHeroYearAndType(hero, techRow) {
    const combinedText = `${techRow?.textContent || ""} ${hero?.textContent?.slice(0, 300) || ""}`;
    const yearMatch = (techRow?.textContent || "").match(/\b(19|20)\d{2}\b/) || combinedText.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[0] : "";

    let mediaType = "";
    const path = window.location.pathname.toLowerCase();
    if (/\/(movies|asset\/movies)\b/.test(path)) {
      mediaType = "movie";
    } else if (/\/(tv|series|shows|asset\/tv)\b/.test(path)) {
      mediaType = "series";
    } else if (/\b(\d+\s*seasons?|\d+\s*episodes?)\b/i.test(combinedText)) {
      mediaType = "series";
    } else if (/\b(\d+\s*h(?:\s*\d+\s*m)?|\d+\s*m(?:in)?)\b/i.test(techRow?.textContent || "")) {
      mediaType = "movie";
    }

    return { year, mediaType };
  }

  function processHeroBanner() {
    const hero = findSkyHeroBanner();
    if (!hero) return;

    const techBadgesRow = findTechnicalBadgesRow(hero);
    if (!techBadgesRow) return;

    const title = extractHeroTitle(hero);
    if (!title) return;

    const { year, mediaType } = extractHeroYearAndType(hero, techBadgesRow);
    techBadgesRow.classList.add("nf-imdb-sky-tech-row");

    window.injectImdbBadge(title, year, mediaType, techBadgesRow, {
      isDetailModal: isDetailRoute(),
      shouldAbort: isActivelyWatching
    });
  }

  function extractPosterTileInfo(tile) {
    const href = tile.getAttribute("href") || tile.querySelector("a[href]")?.getAttribute("href") || "";
    let mediaType = "";
    if (/\/movies\b/i.test(href)) mediaType = "movie";
    else if (/\/(tv|series|shows)\b/i.test(href)) mediaType = "series";

    const img = tile.querySelector("picture img[alt], img[alt]");
    const fromImg = cleanSkyTitle(img?.getAttribute("alt") || "");
    if (fromImg) return { title: fromImg, mediaType };

    const aria =
      tile.getAttribute("aria-label") ||
      tile.querySelector("[aria-label]")?.getAttribute("aria-label") ||
      "";
    const fromAria = cleanSkyTitle(aria);
    if (fromAria) return { title: fromAria, mediaType };

    const text = cleanSkyTitle(tile.textContent || "");
    return { title: text, mediaType };
  }

  function handlePosterHover(event) {
    if (isActivelyWatching()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const tile = target.closest(
      'a[href*="/watch/asset/"], a[href*="/movies/"], a[href*="/series/"], [data-testid*="tile"] a'
    );
    if (!tile) return;

    // Ignore links inside the main Hero Banner
    if (tile.closest('[data-testid*="hero"], [data-testid*="stage"], [data-testid*="billboard"]')) {
      return;
    }

    const img = tile.querySelector("img");
    if (!img) return;
    if (hoverTimers.has(tile)) return;
    if (tile.querySelector(".nf-imdb-poster-pill")) return;

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

  function scanSkyDom() {
    scanScheduled = false;

    if (isActivelyWatching()) {
      window.clearImdbBadges?.();
      return;
    }

    processHeroBanner();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(scanSkyDom);
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

