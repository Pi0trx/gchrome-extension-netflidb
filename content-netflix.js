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
    "dialog"
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
    if (IGNORED_LABELS.has(trimmed.toLowerCase())) return false;
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

  function extractVideoIdFromElement(root) {
    if (!root) return "";

    const link = root.querySelector('a[href*="/watch/"], a[href*="/title/"]');
    const selfHref = root.matches?.('a[href*="/watch/"], a[href*="/title/"]')
      ? root.getAttribute("href")
      : null;
    const href = selfHref || link?.getAttribute("href") || "";
    const hrefMatch = href.match(/\/(?:watch|title)\/(\d+)/);
    if (hrefMatch) return hrefMatch[1];

    const trackingNode = root.matches?.("[data-ui-tracking-context]")
      ? root
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

    const fallbackText = card.querySelector(".fallback-text")?.textContent;
    if (isValidTitle(fallbackText)) return fallbackText.trim();

    const imgAlt = card
      .querySelector(".billboard-title img[alt], img.boxart-image[alt], .boxart-container img[alt]")
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
      '.title-card-container, .title-card, .slider-item, [data-uia="title-card"], .billboard-row, .lolomoRow_title_card'
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

  function isSubCardElement(el) {
    return Boolean(
      el.closest(
        ".moreLikeThis--container, .sims--container, .titleCard--container, .trailersAndMore--container, .episodeSelector, .episodes-container"
      )
    );
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
    const domVideoId = extractVideoIdFromElement(modal);
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
      const alt = modal.querySelector(sel)?.getAttribute("alt");
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
      const node = modal.querySelector(sel);
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

  function extractMediaType(modal, metadataRow, isDetailModal) {
    const durationEl =
      metadataRow.querySelector(".duration") || modal.querySelector(".videoMetadata--container .duration");
    const durationText = durationEl?.textContent?.trim() || "";

    if (durationText) {
      if (/\b(seasons?|episodes?|series|parts?|volumes?|collection)\b/i.test(durationText)) {
        return "series";
      }
      if (/^\d+\s*h(\s*\d+\s*m(in)?)?$/i.test(durationText) || /^\d+\s*m(in)?$/i.test(durationText)) {
        return "movie";
      }
    }

    if (isDetailModal && modal.querySelector('.episodeSelector, [data-uia="episode-selector"]')) {
      return "series";
    }

    return "";
  }

  function extractYear(metadataRow, modal) {
    const yearEl =
      metadataRow.querySelector('.year, .item-year, [data-uia="item-year"]') ||
      modal.querySelector('.previewModal--detailsMetadata .year, .previewModal--detailsMetadata .item-year');
    const text = yearEl?.textContent?.trim() || "";
    const match = text.match(/^(19|20)\d{2}$/);
    return match ? match[0] : "";
  }

  function processModal(modal) {
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

    const rawModals = Array.from(
      document.querySelectorAll(
        '.previewModal--container, [data-uia="preview-modal-container-mini-modal"], [data-uia="preview-modal-container-detail-modal"], .bob-card'
      )
    );
    if (rawModals.length === 0) return;

    // Avoid processing both outer and inner matched containers for the same modal
    const uniqueModals = rawModals.filter(
      (m) => !rawModals.some((other) => other !== m && other.contains(m))
    );

    for (const modal of uniqueModals) {
      processModal(modal);
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

