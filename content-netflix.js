(() => {
  "use strict";

  const IGNORED_LABELS = new Set([
    "play",
    "more info",
    "episodes & info",
    "add to my list",
    "remove from my list",
    "rate",
    "i like this",
    "not for me",
    "love this!",
    "turn on audio",
    "turn off audio",
    "mute",
    "unmute",
    "close",
    "expand",
    "netflix",
    "modal",
    "dialog",
    "featured content"
  ]);

  /** @type {Map<string, string>} */
  const videoIdToTitle = new Map();
  const MAX_VIDEO_MAP_SIZE = 500;
  const HOVER_SETTLE_MS = 80;

  let recentHover = {
    title: "",
    videoId: "",
    time: 0
  };

  let scanScheduled = false;

  document.documentElement.classList.add("nf-platform-netflix");

  function isActivelyWatching() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      return true;
    }
    if (/^\/watch(\/|$)/.test(window.location.pathname)) {
      return true;
    }
    if (document.querySelector('.watch-video, .nfp-mode-fullscreen, [data-uia="watch-video"]')) {
      return true;
    }
    return false;
  }

  function isValidTitle(candidate) {
    if (!candidate || typeof candidate !== "string") return false;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > 180) return false;
    const lower = trimmed.toLowerCase();
    if (IGNORED_LABELS.has(lower)) return false;
    // Reject dynamic action labels like "Add <Title> to My List" or "Audio Description"
    if (/^(?:add|remove)\b.*\blist$/i.test(trimmed)) return false;
    if (/^(?:audio description|maturity rating)\b/i.test(trimmed)) return false;
    return true;
  }

  function rememberVideoTitle(videoId, title) {
    if (!videoId || !isValidTitle(title)) return;
    const cleanTitle = title.trim();
    if (videoIdToTitle.has(videoId)) {
      videoIdToTitle.delete(videoId);
    } else if (videoIdToTitle.size >= MAX_VIDEO_MAP_SIZE) {
      const oldestKey = videoIdToTitle.keys().next().value;
      videoIdToTitle.delete(oldestKey);
    }
    videoIdToTitle.set(videoId, cleanTitle);
  }

  function isSubCardElement(el) {
    return Boolean(
      el.closest(
        ".moreLikeThis--container, .sims--container, .titleCard--container, .trailersAndMore--container, .episodeSelector, .episodes-container"
      )
    );
  }

  function queryOutsideSubCards(root, selector) {
    const nodes = root.querySelectorAll(selector);
    for (const node of nodes) {
      if (!isSubCardElement(node)) {
        return node;
      }
    }
    return null;
  }

  function extractVideoIdFromElement(root, excludeSubCards = false) {
    if (!root) return "";

    const link = excludeSubCards
      ? queryOutsideSubCards(root, 'a[href*="/watch/"], a[href*="/title/"]')
      : root.querySelector('a[href*="/watch/"], a[href*="/title/"]');
    const selfHref = root.matches?.('a[href*="/watch/"], a[href*="/title/"]')
      ? root.getAttribute("href")
      : null;
    const href = selfHref || link?.getAttribute("href") || "";
    const hrefMatch = href.match(/\/(?:watch|title)\/(\d+)/);
    if (hrefMatch) return hrefMatch[1];

    const trackingNode = root.matches?.("[data-ui-tracking-context]")
      ? root
      : excludeSubCards
        ? queryOutsideSubCards(root, "[data-ui-tracking-context]")
        : root.querySelector("[data-ui-tracking-context]");
    const rawTracking = trackingNode?.getAttribute("data-ui-tracking-context");
    if (rawTracking) {
      try {
        const decoded = decodeURIComponent(rawTracking);
        const idMatch = decoded.match(/"video_id"\s*:\s*(\d+)/);
        if (idMatch) return idMatch[1];
      } catch {
        // Ignore malformed tracking attributes
      }
    }

    return "";
  }

  function extractTitleFromCard(card) {
    if (!card) return "";

    const ariaLink = card.querySelector(
      'a.slider-refocus[aria-label], a[href*="/watch/"][aria-label], a[href*="/title/"][aria-label], [data-uia="title-card"] a[aria-label]'
    );
    const ariaLabel = ariaLink?.getAttribute("aria-label");
    if (isValidTitle(ariaLabel)) return ariaLabel.trim();

    const selfAria = card.getAttribute("aria-label");
    if (isValidTitle(selfAria)) return selfAria.trim();

    const fallbackText = card.querySelector(".fallback-text, .titleCard-title")?.textContent;
    if (isValidTitle(fallbackText)) return fallbackText.trim();

    const imgAlt = card
      .querySelector(
        ".billboard-title img[alt], .titleCard-imageWrapper img[alt], img.boxart-image[alt], .boxart-container img[alt]"
      )
      ?.getAttribute("alt");
    if (isValidTitle(imgAlt)) return imgAlt.trim();

    return "";
  }

  // Only records card titles locally in memory to assist hover-modal title resolution — never calls OMDb here.
  function handleCardInteraction(event) {
    if (isActivelyWatching()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const card = target.closest(
      '.title-card-container, .title-card, .slider-item, [data-uia="title-card"], .billboard-row, .lolomoRow_title_card, .titleCard--container'
    );
    if (!card) return;

    const title = extractTitleFromCard(card);
    const videoId = extractVideoIdFromElement(card);

    if (videoId && title) {
      rememberVideoTitle(videoId, title);
    }
    if (title) {
      recentHover = {
        title,
        videoId,
        time: Date.now()
      };
    }
  }

  function isBillboardElement(el) {
    return el.classList.contains("billboard-row") || el.classList.contains("billboard");
  }

  function isDetailModalElement(modal) {
    return (
      modal.classList.contains("detail-modal") ||
      Boolean(modal.closest(".detail-modal")) ||
      modal.getAttribute("data-uia") === "preview-modal-container-detail-modal" ||
      Boolean(modal.querySelector(".previewModal--detailsMetadata"))
    );
  }

  function findMetadataRow(modal, isDetailModal) {
    const searchRoot = isDetailModal
      ? modal.querySelector(".previewModal--detailsMetadata-left, .previewModal--detailsMetadata") || modal
      : modal;

    const lineSelectors = [
      ".videoMetadata--second-line",
      ".videoMetadata--line",
      ".bob-overview .meta"
    ];

    for (const selector of lineSelectors) {
      const candidates = searchRoot.querySelectorAll(selector);
      for (const candidate of candidates) {
        if (!isSubCardElement(candidate)) {
          return candidate;
        }
      }
    }

    // Fallback to .videoMetadata--container only if it directly holds metadata items without line wrappers
    const containers = searchRoot.querySelectorAll(".videoMetadata--container");
    for (const container of containers) {
      if (isSubCardElement(container)) continue;
      const hasSubLines = container.querySelector(".videoMetadata--second-line, .videoMetadata--line");
      const hasMetaItems = container.querySelector(
        ".maturity-rating, .maturity-number, .duration, .year, .item-year"
      );
      if (!hasSubLines && hasMetaItems) {
        return container;
      }
    }

    return null;
  }

  function extractModalVideoId(modal, isDetailModal) {
    const domVideoId = extractVideoIdFromElement(modal, true);
    if (domVideoId) return domVideoId;

    if (isDetailModal) {
      try {
        const jbv = new URLSearchParams(window.location.search).get("jbv");
        if (jbv && /^\d+$/.test(jbv)) return jbv;
      } catch {
        // Ignore URL parse errors
      }
      const pathMatch = window.location.pathname.match(/\/title\/(\d+)/);
      if (pathMatch) return pathMatch[1];
    }

    return "";
  }

  function extractModalTitle(modal, isDetailModal) {
    // 1. "About <Title>" section header (authoritative plain text in expanded detail modal)
    const aboutStrong = modal.querySelector(
      ".about-wrapper .about-header strong, .about-header strong"
    );
    if (isValidTitle(aboutStrong?.textContent)) {
      return aboutStrong.textContent.trim();
    }

    // 2. Title treatment logo alt text (present in both mini-modal and detail-modal)
    const logoSelectors = [
      "img.previewModal--player-titleTreatment-logo[alt]",
      ".previewModal--player-titleTreatmentWrapper img[alt]",
      '[data-uia="previewModal-titleLogo"] img[alt]',
      'img[class*="titleTreatment"][alt]'
    ];
    for (const sel of logoSelectors) {
      const node = queryOutsideSubCards(modal, sel);
      const alt = node?.getAttribute("alt");
      if (isValidTitle(alt)) return alt.trim();
    }

    // 3. Preview boxart / storyArt image alt text (present in hover mini-modal before trailer plays)
    const artSelectors = [
      "img.previewModal--boxart[alt]",
      ".previewModal--boxart img[alt]",
      ".storyArt img[alt]",
      ".bob-overview img[alt]",
      ".bob-title"
    ];
    for (const sel of artSelectors) {
      const node = queryOutsideSubCards(modal, sel);
      const val = node?.tagName === "IMG" ? node.getAttribute("alt") : node?.textContent;
      if (isValidTitle(val)) return val.trim();
    }

    // 4. Match modal's videoId against previously hovered/clicked browse card
    const videoId = extractModalVideoId(modal, isDetailModal);
    if (videoId && videoIdToTitle.has(videoId)) {
      return videoIdToTitle.get(videoId);
    }

    // 5. Descriptive aria-label on expand/more-info controls inside the modal
    const labeledButtons = modal.querySelectorAll("[aria-label], [title]");
    for (const btn of labeledButtons) {
      if (isSubCardElement(btn)) continue;
      const raw = btn.getAttribute("aria-label") || btn.getAttribute("title") || "";
      const infoMatch = raw.match(/^(?:more info about|details for|expand)\s+(.+)$/i);
      if (infoMatch && isValidTitle(infoMatch[1])) {
        return infoMatch[1].trim();
      }
    }

    // 6. Direct /title/<id> page document.title fallback
    if (isDetailModal && /^\/title\/\d+/.test(window.location.pathname)) {
      const cleanedDocTitle = document.title
        .replace(/^Watch\s+/i, "")
        .replace(/\s*[|\-–—]\s*Netflix.*$/i, "")
        .trim();
      if (isValidTitle(cleanedDocTitle)) {
        return cleanedDocTitle;
      }
    }

    // 7. Recent hovered card fallback for hover mini-modal
    if (!isDetailModal && recentHover.title && Date.now() - recentHover.time < 3500) {
      return recentHover.title;
    }

    return "";
  }

  function parseMediaTypeFromDurationText(durationText) {
    if (!durationText) return "";
    if (/\b(seasons?|episodes?|series|parts?|volumes?|collection)\b/i.test(durationText)) {
      return "series";
    }
    if (/^\d+\s*h(\s*\d+\s*m(in)?)?$/i.test(durationText) || /^\d+\s*m(in)?$/i.test(durationText)) {
      return "movie";
    }
    return "";
  }

  function extractMediaType(modal, metadataRow, isDetailModal) {
    const durationEl =
      metadataRow.querySelector(".duration") ||
      queryOutsideSubCards(modal, ".videoMetadata--container .duration");
    const parsed = parseMediaTypeFromDurationText(durationEl?.textContent?.trim() || "");
    if (parsed) return parsed;

    if (isDetailModal && modal.querySelector('.episodeSelector, [data-uia="episode-selector"]')) {
      return "series";
    }

    return "";
  }

  function extractYear(metadataRow, fallbackRoot = null) {
    const yearEl =
      metadataRow.querySelector('.year, .item-year, [data-uia="item-year"]') ||
      (fallbackRoot
        ? queryOutsideSubCards(
            fallbackRoot,
            ".previewModal--detailsMetadata .year, .previewModal--detailsMetadata .item-year"
          )
        : null);
    const text = yearEl?.textContent?.trim() || "";
    const match = text.match(/^(19|20)\d{2}$/);
    return match ? match[0] : "";
  }

  // --- Feature 1: Homepage Hero Banner (Billboard) ---

  function findBillboardMetadataRow(billboard) {
    const selectors = [
      ".info-meta-wrapper .meta",
      ".billboard .meta",
      ".meta",
      ".info-meta-wrapper",
      ".videoMetadata--second-line",
      ".videoMetadata--line",
      ".videoMetadata--container",
      ".billboard-links",
      '[data-uia="billboard-links"]'
    ];
    for (const sel of selectors) {
      const candidate = billboard.querySelector(sel);
      if (candidate) return candidate;
    }
    return null;
  }

  function extractBillboardTitle(billboard) {
    // Primary: .billboard-title img[alt]
    const primaryAlt = billboard.querySelector(".billboard-title img[alt]")?.getAttribute("alt");
    if (isValidTitle(primaryAlt)) return primaryAlt.trim();

    const secondaryLogo = billboard
      .querySelector('[data-uia="billboard-title"] img[alt], .title-logo[alt], .billboard-title img[title]')
      ?.getAttribute("alt") ||
      billboard.querySelector(".billboard-title img[title]")?.getAttribute("title");
    if (isValidTitle(secondaryLogo)) return secondaryLogo.trim();

    const titleText = billboard.querySelector(".billboard-title")?.textContent;
    if (isValidTitle(titleText)) return titleText.trim();

    const videoId = extractVideoIdFromElement(billboard);
    if (videoId && videoIdToTitle.has(videoId)) {
      return videoIdToTitle.get(videoId);
    }

    const labeledControls = billboard.querySelectorAll("[aria-label], [title]");
    for (const ctrl of labeledControls) {
      const raw = ctrl.getAttribute("aria-label") || ctrl.getAttribute("title") || "";
      const infoMatch = raw.match(/^(?:more info about|details for)\s+(.+)$/i);
      if (infoMatch && isValidTitle(infoMatch[1])) {
        return infoMatch[1].trim();
      }
    }

    return "";
  }

  function extractBillboardYear(billboard, metadataRow) {
    const yearEl =
      metadataRow.querySelector('.year, .item-year, [data-uia="item-year"]') ||
      billboard.querySelector('.year, .item-year, [data-uia="item-year"]');
    if (yearEl) {
      const m = (yearEl.textContent || "").trim().match(/^(19|20)\d{2}$/);
      if (m) return m[0];
    }

    if (!metadataRow.classList.contains("billboard-links")) {
      const inlineMatch = (metadataRow.textContent || "").match(/\b(19|20)\d{2}\b/);
      if (inlineMatch) return inlineMatch[0];
    }

    return "";
  }

  function extractBillboardMediaType(billboard, metadataRow) {
    const durationEl =
      metadataRow.querySelector(".duration") || billboard.querySelector(".duration");
    const fromDuration = parseMediaTypeFromDurationText(durationEl?.textContent?.trim() || "");
    if (fromDuration) return fromDuration;

    const suppMsg = billboard.querySelector(".supplemental-message")?.textContent || "";
    if (/\b(tv\s+shows?|series|seasons?|episodes?)\b/i.test(suppMsg)) {
      return "series";
    }
    if (/\bmovies?\b/i.test(suppMsg)) {
      return "movie";
    }

    return "";
  }

  function syncBillboardButtonMargin(metadataRow) {
    if (
      !metadataRow.classList.contains("billboard-links") &&
      metadataRow.getAttribute("data-uia") !== "billboard-links"
    ) {
      return;
    }
    const refBtn = metadataRow.querySelector("button, a");
    if (!refBtn || typeof window.getComputedStyle !== "function") return;
    const mb = window.getComputedStyle(refBtn).marginBottom;
    if (mb && mb !== "0px") {
      metadataRow.style.setProperty("--nf-billboard-btn-mb", mb);
    } else {
      metadataRow.style.removeProperty("--nf-billboard-btn-mb");
    }
  }

  function processBillboard(billboard) {
    const metadataRow = findBillboardMetadataRow(billboard);
    if (!metadataRow) return;

    const title = extractBillboardTitle(billboard);
    if (!title) return;

    const videoId = extractVideoIdFromElement(billboard);
    if (videoId) {
      rememberVideoTitle(videoId, title);
    }

    const mediaType = extractBillboardMediaType(billboard, metadataRow);
    const year = extractBillboardYear(billboard, metadataRow);

    syncBillboardButtonMargin(metadataRow);

    window.injectImdbBadge(title, year, mediaType, metadataRow, {
      isDetailModal: false,
      shouldAbort: isActivelyWatching
    });
  }

  // --- Feature 2: "More Like This" / Recommended Cards ---

  function isEpisodeOrTrailerCard(el) {
    if (
      el.closest(
        '.episodeSelector, .episodeSelector-container, .episodes-container, [data-uia="episode-selector"], .trailersAndMore--container, [data-uia="trailers-and-more"], .episode-item'
      )
    ) {
      return true;
    }
    if (el.querySelector(".titleCard-title_index")) {
      return true;
    }
    return false;
  }

  function findRecCardMetadataRow(card) {
    const lineSelectors = [
      ".videoMetadata--second-line",
      ".videoMetadata--line",
      ".titleCard--metadataWrapper .meta",
      ".meta"
    ];

    for (const selector of lineSelectors) {
      const candidate = card.querySelector(selector);
      if (candidate) return candidate;
    }

    const containers = card.querySelectorAll(".videoMetadata--container");
    for (const container of containers) {
      const hasSubLines = container.querySelector(".videoMetadata--second-line, .videoMetadata--line");
      const hasMetaItems = container.querySelector(
        ".maturity-rating, .maturity-number, .duration, .year, .item-year"
      );
      if (!hasSubLines && hasMetaItems) {
        return container;
      }
    }

    // Structural fallback: flex row holding year or maturity-rating inside the card's metadata wrapper
    const metaAtom = card.querySelector(
      ".titleCard--metadataWrapper .year, .titleCard--metadataWrapper .item-year, .titleCard--metadataWrapper .maturity-rating"
    );
    if (metaAtom?.parentElement && metaAtom.parentElement !== card) {
      const parent = metaAtom.parentElement;
      if (
        parent.children.length === 1 &&
        parent.parentElement &&
        parent.parentElement !== card &&
        !parent.parentElement.classList.contains("titleCard--metadataWrapper")
      ) {
        return parent.parentElement;
      }
      return parent;
    }

    return null;
  }

  function extractRecCardTitle(card) {
    // 1. aria-label on the card link (excluding action buttons like Add to My List)
    const cardLinks = card.querySelectorAll(
      'a.slider-refocus[aria-label], a[href*="/watch/"][aria-label], a[href*="/title/"][aria-label], a[aria-label], [role="link"][aria-label]'
    );
    for (const link of cardLinks) {
      if (link.closest(".buttonControls--container")) continue;
      const aria = link.getAttribute("aria-label");
      if (isValidTitle(aria)) return aria.trim();
    }

    // 2. aria-label on the .titleCard--container itself
    const selfAria =
      card.getAttribute("aria-label") ||
      card.querySelector(".titleCard--container[aria-label]")?.getAttribute("aria-label");
    if (isValidTitle(selfAria)) return selfAria.trim();

    // 3. Fallback text spans inside the card
    const textSelectors = [
      ".fallback-text",
      ".titleCard-title",
      '[data-uia="titleCard-title"]',
      ".video-title"
    ];
    for (const sel of textSelectors) {
      const text = card.querySelector(sel)?.textContent;
      if (isValidTitle(text)) return text.trim();
    }

    // 4. Card boxart / preview image alt text
    const imgAlt = card
      .querySelector(
        ".titleCard-imageWrapper img[alt], img.boxart-image[alt], .boxart-container img[alt], img[alt]"
      )
      ?.getAttribute("alt");
    if (isValidTitle(imgAlt)) return imgAlt.trim();

    // 5. Tracking video_id lookup from previously seen cards
    const videoId = extractVideoIdFromElement(card);
    if (videoId && videoIdToTitle.has(videoId)) {
      return videoIdToTitle.get(videoId);
    }

    return "";
  }

  function extractRecCardMediaType(card, metadataRow) {
    const durationEl =
      metadataRow.querySelector(".duration") ||
      card.querySelector(".titleCard-imageWrapper .duration, .videoMetadata--container .duration, .duration");
    return parseMediaTypeFromDurationText(durationEl?.textContent?.trim() || "");
  }

  function extractRecCardYear(card, metadataRow) {
    const yearEl =
      metadataRow.querySelector('.year, .item-year, [data-uia="item-year"]') ||
      card.querySelector('.year, .item-year, [data-uia="item-year"]');
    const text = yearEl?.textContent?.trim() || "";
    const match = text.match(/^(19|20)\d{2}$/);
    return match ? match[0] : "";
  }

  function processRecommendedCard(card) {
    const metadataRow = findRecCardMetadataRow(card);
    if (!metadataRow) return;

    const title = extractRecCardTitle(card);
    if (!title) return;

    const videoId = extractVideoIdFromElement(card);
    if (videoId) {
      rememberVideoTitle(videoId, title);
    }

    const mediaType = extractRecCardMediaType(card, metadataRow);
    const year = extractRecCardYear(card, metadataRow);

    window.injectImdbBadge(title, year, mediaType, metadataRow, {
      isDetailModal: false,
      shouldAbort: isActivelyWatching
    });
  }

  // --- Primary Modal Processing ---

  function processModal(modal) {
    if (isBillboardElement(modal)) {
      processBillboard(modal);
      return;
    }

    const isDetailModal = isDetailModalElement(modal);
    const metadataRow = findMetadataRow(modal, isDetailModal);
    if (!metadataRow) return;

    const title = extractModalTitle(modal, isDetailModal);
    if (!title) return;

    const videoId = extractModalVideoId(modal, isDetailModal);
    if (videoId) {
      rememberVideoTitle(videoId, title);
    }

    const mediaType = extractMediaType(modal, metadataRow, isDetailModal);
    const year = extractYear(metadataRow, modal);
    const signature = `${title}|${mediaType}|${isDetailModal ? "detail" : "mini"}`;

    const existingBadge = metadataRow.querySelector(":scope > .nf-imdb-badge");
    if (existingBadge && existingBadge.dataset.imdbSignature === signature) {
      return;
    }

    if (isDetailModal) {
      window.injectImdbBadge(title, year, mediaType, metadataRow, {
        isDetailModal: true,
        shouldAbort: isActivelyWatching
      });
    } else {
      if (metadataRow.dataset.nfImdbPending === signature) return;
      metadataRow.dataset.nfImdbPending = signature;

      // Short settle delay on hover mini-modal so transient pass-overs that immediately close make 0 API calls
      setTimeout(() => {
        if (metadataRow.dataset.nfImdbPending === signature) {
          delete metadataRow.dataset.nfImdbPending;
        }
        if (isActivelyWatching() || !modal.isConnected || !metadataRow.isConnected) {
          return;
        }
        const settledTitle = extractModalTitle(modal, false) || title;
        const settledType = extractMediaType(modal, metadataRow, false) || mediaType;
        const settledYear = extractYear(metadataRow, modal) || year;
        window.injectImdbBadge(settledTitle, settledYear, settledType, metadataRow, {
          isDetailModal: false,
          shouldAbort: isActivelyWatching
        });
      }, HOVER_SETTLE_MS);
    }
  }

  function scanModals() {
    scanScheduled = false;

    if (isActivelyWatching()) {
      window.clearImdbBadges?.();
      return;
    }

    // 1. Primary loop: hover mini-modals, expanded detail modals, and homepage hero billboards
    const rawModals = Array.from(
      document.querySelectorAll(
        '.previewModal--container, [data-uia="preview-modal-container-mini-modal"], [data-uia="preview-modal-container-detail-modal"], .bob-card, .billboard-row, .billboard'
      )
    );

    if (rawModals.length > 0) {
      // Avoid processing both outer and inner matched containers (e.g. .billboard-row wrapping .billboard)
      const uniqueModals = rawModals.filter(
        (m) => !rawModals.some((other) => other !== m && other.contains(m))
      );

      for (const modal of uniqueModals) {
        processModal(modal);
      }
    }

    // 2. Secondary loop: "More Like This" / recommended cards as isolated entities
    const rawRecCards = Array.from(
      document.querySelectorAll(
        ".titleCard--container, .moreLikeThis--container .ptrack-content, .sims--container .ptrack-content"
      )
    );

    if (rawRecCards.length > 0) {
      const uniqueRecCards = rawRecCards.filter((el) => {
        if (isEpisodeOrTrailerCard(el)) return false;

        if (el.classList.contains("titleCard--container")) {
          return !el.parentElement?.closest(".titleCard--container");
        }

        // Skip .ptrack-content wrappers that wrap or sit inside a .titleCard--container
        if (el.closest(".titleCard--container") || el.querySelector(".titleCard--container")) {
          return false;
        }

        // Fallback when cards use .ptrack-content without .titleCard--container: keep only leaf card nodes with metadata
        if (!findRecCardMetadataRow(el)) {
          return false;
        }
        const hasNestedMetaCard = Array.from(el.querySelectorAll(".ptrack-content")).some(
          (child) => child !== el && findRecCardMetadataRow(child)
        );
        return !hasNestedMetaCard;
      });

      for (const card of uniqueRecCards) {
        processRecommendedCard(card);
      }
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(scanModals);
  }

  document.addEventListener("mouseover", handleCardInteraction, { capture: true, passive: true });
  document.addEventListener("pointerdown", handleCardInteraction, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", scheduleScan, { passive: true });

  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["alt", "aria-label", "class"]
    });
    scheduleScan();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["alt", "aria-label", "class"]
      });
      scheduleScan();
    });
  }
})();
