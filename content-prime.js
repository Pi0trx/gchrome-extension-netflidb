(() => {
  "use strict";

  const HOVER_SETTLE_MS = 180;
  let scanScheduled = false;
  let observerAttached = false;

  const IGNORED_TITLES = new Set([
    "prime video",
    "amazon",
    "watch now",
    "trailer",
    "play",
    "resume",
    "more details",
    "details",
    "included with prime",
    "freevee"
  ]);

  function isPrimeVideoPage() {
    const host = window.location.hostname.toLowerCase();
    if (host.includes("primevideo.com")) return true;

    const path = window.location.pathname;
    if (/\/(gp\/video|Prime-Video|Amazon-Video|minitv)\b/i.test(path)) {
      return true;
    }

    return Boolean(
      document.querySelector(
        '#dv-web-player, .dv-dp-node, .av-dp-container, #aiv-cl-main-middle, [data-testid="pv-nav"], [data-automation-id="imdb-rating-badge"], [data-testid="dp-atf"]'
      )
    );
  }

  function isActivelyWatching() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      return true;
    }
    if (document.querySelector(".dv-player-fullscreen, .xrayQuickView")) {
      return true;
    }
    // Check if the full-screen SDK player overlay is visible (excluding small hover/hero trailer players)
    const sdkOverlays = document.querySelectorAll(".atvwebplayersdk-overlays-container");
    for (const overlay of sdkOverlays) {
      if (
        overlay.closest(
          '[data-testid*="hover"], [data-testid="card-overlay"], .tst-hover-container, .ua-hover-card'
        )
      ) {
        continue;
      }
      const rect = overlay.getBoundingClientRect();
      if (rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.7) {
        return true;
      }
    }
    return false;
  }

  /**
   * Aggressive Regex cleaner for Amazon Prime Video titles.
   * Strips square-bracket tags ([4K UHD], [Ultra HD], [OV]), parenthetical editions/dubs
   * ((Extended Edition), (Subbed), (Dubbed), (Director's Cut), (Lektor), (2023)), and season suffixes.
   */
  function cleanPrimeTitle(rawTitle) {
    if (!rawTitle || typeof rawTitle !== "string") return "";

    let cleaned = rawTitle
      .replace(/\u00a0/g, " ")
      .trim();

    // Preserve rare leading numeric parentheticals like "(500) Days of Summer"
    let leadingNumericPrefix = "";
    const leadingMatch = cleaned.match(/^(\(\d+\)\s+)(.+)$/);
    if (leadingMatch) {
      leadingNumericPrefix = leadingMatch[1];
      cleaned = leadingMatch[2];
    }

    cleaned = cleaned
      // Strip all square-bracket blocks: [4K UHD], [Ultra HD], [HDR], [OV/OmU], [dt./OV], etc.
      .replace(/\[[^\]]*\]/g, " ")
      // Strip all parenthetical blocks: (Extended Edition), (Subbed), (Dubbed), (Unrated), (Lektor), (2022), etc.
      .replace(/\([^)]*\)/g, " ")
      // Strip trailing season / part / series / technical edition markers after separators
      .replace(
        /\s*(?:[:\-–—|]\s*)(?:complete\s+)?(?:season|series|sezon|part|volume|book)\s+\d+.*$/i,
        ""
      )
      .replace(
        /\s*(?:[:\-–—|]\s*)(?:4k\s*uhd|ultra\s*hd|uhd|hdr10\+?|hdr|hd|extended\s+edition|director'?s\s+cut|unrated(?:\s+edition)?|theatrical(?:\s+edition)?|special\s+edition|bonus\s+x-ray\s+edition|subbed|dubbed|english\s+subtitled|original\s+version|lektor|dubbing|napisy)\s*$/i,
        ""
      )
      .replace(/\s*[|\-–—]\s*(?:prime\s+video|amazon\.?\w*).*$/i, "")
      .replace(/\s+/g, " ")
      .replace(/[\s:\-–—|]+$/, "")
      .trim();

    const finalTitle = `${leadingNumericPrefix}${cleaned}`.trim();
    if (!finalTitle || finalTitle.length > 180) return "";
    if (IGNORED_TITLES.has(finalTitle.toLowerCase())) return "";
    return finalTitle;
  }

  function hideNativePrimeImdbBadges(scope) {
    if (!scope) return;

    const explicitBadges = scope.querySelectorAll(
      '[data-automation-id="imdb-rating-badge"], [data-testid="imdb-rating-badge"], [data-testid="imdb-rating"], [aria-label^="IMDb"]'
    );
    for (const node of explicitBadges) {
      node.classList.add("nf-imdb-native-hidden");
    }

    // Also hide plain-text leaf spans like "IMDb 7.4" that lack data-automation-id
    const candidates = scope.querySelectorAll("span, div");
    for (const el of candidates) {
      if (el.classList.contains("nf-imdb-badge") || el.closest(".nf-imdb-badge")) continue;
      if (el.children.length === 0) {
        const txt = el.textContent?.trim() || "";
        if (/^IMDb(?:\s+\d+(?:[.,]\d+)?|\s*:)?$/i.test(txt)) {
          const wrapper =
            el.parentElement &&
            el.parentElement.children.length <= 2 &&
            /^IMDb\s*\d+(?:[.,]\d+)?$/i.test(el.parentElement.textContent?.replace(/\s+/g, " ").trim() || "")
              ? el.parentElement
              : el;
          wrapper.classList.add("nf-imdb-native-hidden");
        }
      }
    }
  }

  function extractYearFromRoot(root) {
    if (!root) return "";
    const yearEl = root.querySelector(
      '[data-automation-id="release-year-badge"], [data-automation-id="release-year"], [data-testid*="release-year"]'
    );
    if (yearEl) {
      const m = yearEl.textContent?.trim().match(/\b(19|20)\d{2}\b/);
      if (m) return m[0];
    }

    const spans = root.querySelectorAll("span");
    for (const sp of spans) {
      const txt = sp.textContent?.trim() || "";
      if (/^(19|20)\d{2}$/.test(txt)) {
        return txt;
      }
    }
    return "";
  }

  function extractMediaTypeFromRoot(root, rawTitle = "") {
    if (!root) return "";
    if (/season|series|sezon/i.test(rawTitle)) {
      return "series";
    }
    if (
      root.querySelector(
        '[data-automation-id="season-selector"], [data-testid*="season-selector"], [data-testid*="episodes"]'
      )
    ) {
      return "series";
    }
    const metaText = root.textContent || "";
    if (/\b(\d+\s*seasons?|\d+\s*sezon|\d+\s*episodes?|series)\b/i.test(metaText)) {
      return "series";
    }
    const runtimeEl = root.querySelector(
      '[data-automation-id="runtime-badge"], [data-testid*="runtime"]'
    );
    if (runtimeEl && /\b(\d+\s*h|\d+\s*m(in)?)\b/i.test(runtimeEl.textContent || "")) {
      return "movie";
    }
    return "";
  }

  function processDetailPage() {
    const hero = document.querySelector(
      '[data-testid="dp-atf"], #dv-action-box-wrapper, .dv-dp-node, .av-dp-container'
    );
    if (!hero) return;

    hideNativePrimeImdbBadges(hero);

    // Locate the main metadata row (.dv-node-dp-badges or parent flex row of year/runtime/imdb badges)
    const anchorAtom = hero.querySelector(
      '[data-automation-id="imdb-rating-badge"], [data-automation-id="release-year-badge"], [data-automation-id="runtime-badge"]'
    );
    const metadataRow =
      hero.querySelector('.dv-node-dp-badges, [data-automation-id="meta-info"] > div, [data-testid="dp-metadata"]') ||
      anchorAtom?.parentElement;

    if (!metadataRow) return;

    const rawTitle =
      hero.querySelector('[data-automation-id="title"]')?.textContent ||
      hero.querySelector('h1[data-testid*="title"], h1')?.textContent ||
      hero.querySelector('img[data-testid*="title-art"][alt], .dv-dp-node-title img[alt]')?.getAttribute("alt") ||
      "";

    const cleanTitle = cleanPrimeTitle(rawTitle);
    if (!cleanTitle) return;

    const year = extractYearFromRoot(metadataRow) || extractYearFromRoot(hero);
    const mediaType = extractMediaTypeFromRoot(hero, rawTitle);

    window.injectImdbBadge(cleanTitle, year, mediaType, metadataRow, {
      isDetailModal: true,
      shouldAbort: isActivelyWatching
    });
  }

  function findReleaseYearElement(card) {
    const explicit = card.querySelector(
      '[data-automation-id="release-year"], [data-automation-id="release-year-badge"], [data-testid*="release-year"]'
    );
    if (explicit) return explicit;

    const spans = card.querySelectorAll("span, div");
    for (const el of spans) {
      if (el.children.length === 0 && /^(19|20)\d{2}$/.test(el.textContent?.trim() || "")) {
        return el;
      }
    }
    return null;
  }

  function extractHoverCardRawTitle(card) {
    const titleEl = card.querySelector(
      '[data-automation-id="title"], [data-testid*="hover-title"], [data-testid="card-title"], h2, h3'
    );
    if (titleEl?.textContent?.trim()) return titleEl.textContent.trim();

    const linkLabel = card.querySelector("a[aria-label]")?.getAttribute("aria-label");
    if (linkLabel?.trim()) return linkLabel.trim();

    const imgAlt = card.querySelector("img[alt]")?.getAttribute("alt");
    if (imgAlt?.trim()) return imgAlt.trim();

    return "";
  }

  function processHoverCard(card) {
    hideNativePrimeImdbBadges(card);

    const yearEl = findReleaseYearElement(card);
    const targetRow =
      yearEl?.parentElement ||
      card.querySelector(
        '[data-automation-id="sub-card-metadata"], [data-testid*="metadata"], .ua-meta-info'
      );
    if (!targetRow) return;

    const rawTitle = extractHoverCardRawTitle(card);
    const cleanTitle = cleanPrimeTitle(rawTitle);
    if (!cleanTitle) return;

    const year = yearEl?.textContent?.trim() || extractYearFromRoot(targetRow);
    const mediaType = extractMediaTypeFromRoot(card, rawTitle);
    const signature = `${cleanTitle}|${mediaType}|mini`;

    const existing = targetRow.querySelector(":scope > .nf-imdb-badge");
    if (existing && existing.dataset.imdbSignature === signature) return;
    if (targetRow.dataset.primeImdbPending === signature) return;

    targetRow.dataset.primeImdbPending = signature;
    setTimeout(() => {
      if (targetRow.dataset.primeImdbPending === signature) {
        delete targetRow.dataset.primeImdbPending;
      }
      if (isActivelyWatching() || !card.isConnected || !targetRow.isConnected) return;

      hideNativePrimeImdbBadges(card);
      window.injectImdbBadge(cleanTitle, year, mediaType, targetRow, {
        isDetailModal: false,
        afterElement: yearEl && yearEl.parentElement === targetRow ? yearEl : null,
        shouldAbort: isActivelyWatching
      });
    }, HOVER_SETTLE_MS);
  }

  function scanPrimeDom() {
    scanScheduled = false;

    if (!isPrimeVideoPage()) return;

    if (isActivelyWatching()) {
      window.clearImdbBadges?.();
      return;
    }

    processDetailPage();

    const hoverCards = Array.from(
      document.querySelectorAll(
        '[data-testid="card-overlay"], [data-testid*="hover-card"], [data-automation-id*="hover"], .tst-hover-container, .ua-hover-card'
      )
    );
    const uniqueCards = hoverCards.filter(
      (c) => !hoverCards.some((other) => other !== c && other.contains(c))
    );
    for (const card of uniqueCards) {
      processHoverCard(card);
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(scanPrimeDom);
  }

  function attachObserverIfPrime() {
    if (observerAttached || !document.body) return;
    if (!isPrimeVideoPage()) return;

    observerAttached = true;
    document.documentElement.classList.add("nf-imdb-prime-active", "nf-platform-prime");

    const observer = new MutationObserver(() => {
      scheduleScan();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    document.addEventListener("fullscreenchange", scheduleScan, { passive: true });
    scheduleScan();
  }

  if (document.body) {
    attachObserverIfPrime();
  } else {
    document.addEventListener("DOMContentLoaded", attachObserverIfPrime);
  }

  // Handle SPA transitions from an Amazon home/storefront route into Prime Video
  window.addEventListener("popstate", () => {
    attachObserverIfPrime();
    if (observerAttached) scheduleScan();
  });
})();

