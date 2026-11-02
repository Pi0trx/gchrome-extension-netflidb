(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  // 5-pointed star centered in viewBox="0 0 40 40" with generous body for legible score overlay
  const STAR_PATH_D =
    "M 20.00 3.30 L 25.53 13.20 L 36.64 15.39 L 28.94 23.70 L 30.29 34.96 " +
    "L 20.00 30.20 L 9.71 34.96 L 11.06 23.70 L 3.36 15.39 L 14.47 13.20 Z";

  // Symmetric award statuette silhouette on a 2-tier pedestal centered at x=7.5 in viewBox="0 0 15 20"
  const OSCAR_STATUETTE_PATH_D =
    "M 7.50 1.40 C 8.55 1.40 9.30 2.15 9.30 3.15 C 9.30 3.95 8.80 4.55 8.15 4.80 " +
    "L 8.30 5.30 C 9.85 5.50 11.10 6.20 11.10 7.30 C 11.10 8.20 10.45 9.15 9.50 9.70 " +
    "L 9.25 11.20 L 8.75 15.55 L 10.30 15.55 C 10.60 15.55 10.80 15.75 10.80 16.05 " +
    "L 10.80 16.95 L 11.80 16.95 C 12.15 16.95 12.40 17.20 12.40 17.55 L 12.40 18.60 " +
    "L 2.60 18.60 L 2.60 17.55 C 2.60 17.20 2.85 16.95 3.20 16.95 L 4.20 16.95 " +
    "L 4.20 16.05 C 4.20 15.75 4.40 15.55 4.70 15.55 L 6.25 15.55 L 5.75 11.20 " +
    "L 5.50 9.70 C 4.55 9.15 3.90 8.20 3.90 7.30 C 3.90 6.20 5.15 5.50 6.70 5.30 " +
    "L 6.85 4.80 C 6.20 4.55 5.70 3.95 5.70 3.15 C 5.70 2.15 6.45 1.40 7.50 1.40 Z";

  const TIER_CLASSES = [
    "nf-imdb-tier--bronze",
    "nf-imdb-tier--silver",
    "nf-imdb-tier--gold",
    "nf-imdb-tier--diamond"
  ];

  function createBadgeElement() {
    const badge = document.createElement("span");
    badge.className = "nf-imdb-badge nf-imdb-badge--loading";
    badge.setAttribute("aria-label", "IMDb rating");

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "nf-imdb-star");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "nf-imdb-star-body");
    path.setAttribute("d", STAR_PATH_D);
    svg.appendChild(path);

    const score = document.createElement("span");
    score.className = "nf-imdb-score";
    score.textContent = "…";

    badge.appendChild(svg);
    badge.appendChild(score);
    return badge;
  }

  function createOscarStatuetteSvg() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "nf-imdb-oscar-svg");
    svg.setAttribute("viewBox", "0 0 15 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", OSCAR_STATUETTE_PATH_D);
    svg.appendChild(path);

    return svg;
  }

  function parseOscarWins(awardsText) {
    if (!awardsText || typeof awardsText !== "string") return 0;
    const match = awardsText.match(/\bWon\s+(\d+)\s+Oscars?\b/i);
    if (!match) return 0;
    const wins = parseInt(match[1], 10);
    return Number.isFinite(wins) && wins > 0 ? wins : 0;
  }

  function removeAdjacentOscarWrapper(badge) {
    if (badge?.nextElementSibling?.classList.contains("nf-imdb-oscar-wrapper")) {
      badge.nextElementSibling.remove();
    }
  }

  function renderOscarCounter(badge, awardsText, isDetailModal) {
    removeAdjacentOscarWrapper(badge);
    if (!badge?.isConnected) return;

    const wins = parseOscarWins(awardsText);
    if (wins <= 0) return;

    const wrapper = document.createElement("span");
    wrapper.className = "nf-imdb-oscar-wrapper";
    wrapper.setAttribute("aria-label", `Won ${wins} Oscar${wins === 1 ? "" : "s"}`);

    const stack = document.createElement("span");
    stack.className = "nf-imdb-oscar-stack";
    stack.setAttribute("aria-hidden", "true");

    // Detail view: exact win count (e.g., 11 SVGs); Hover card: capped at 3 SVGs
    const statuetteCount = isDetailModal === true ? wins : Math.min(wins, 3);
    for (let i = 0; i < statuetteCount; i++) {
      stack.appendChild(createOscarStatuetteSvg());
    }

    const total = document.createElement("span");
    total.className = "nf-imdb-oscar-total";
    total.textContent = String(wins);

    wrapper.appendChild(stack);
    wrapper.appendChild(total);
    badge.insertAdjacentElement("afterend", wrapper);
  }

  function getTierClassForVotes(imdbVotes) {
    const votes = typeof imdbVotes === "number" && Number.isFinite(imdbVotes) ? imdbVotes : 0;
    if (votes >= 750000) return "nf-imdb-tier--diamond";
    if (votes >= 250000) return "nf-imdb-tier--gold";
    if (votes >= 50000) return "nf-imdb-tier--silver";
    return "nf-imdb-tier--bronze";
  }

  function updateBadgeDisplay(badge, ratingValue, imdbVotes = null) {
    const normalized =
      ratingValue && ratingValue !== "N/A" ? String(ratingValue).trim() : "N/A";
    const scoreEl = badge.querySelector(".nf-imdb-score");
    if (scoreEl) {
      scoreEl.textContent = normalized;
    }

    badge.classList.remove("nf-imdb-badge--loading", ...TIER_CLASSES, "high-rating-glow");

    if (normalized === "N/A") {
      badge.classList.add("nf-imdb-badge--na");
      badge.setAttribute("aria-label", "IMDb rating not available");
    } else {
      badge.classList.remove("nf-imdb-badge--na");
      const tierClass = getTierClassForVotes(imdbVotes);
      badge.classList.add(tierClass);

      const numericRating = parseFloat(normalized);
      if (
        Number.isFinite(numericRating) &&
        numericRating > 8.0 &&
        tierClass !== "nf-imdb-tier--diamond"
      ) {
        badge.classList.add("high-rating-glow");
      }

      badge.setAttribute("aria-label", `IMDb rating ${normalized}`);
    }
  }

  function normalizeYear(rawYear) {
    if (!rawYear) return "";
    const match = String(rawYear).match(/(19|20)\d{2}/);
    return match ? match[0] : "";
  }

  function normalizeMediaType(rawType) {
    if (rawType === "movie" || rawType === "series") return rawType;
    return "";
  }

  /**
   * Injects or updates the shared IMDb star badge and stacked Oscar win counter
   * inside a target container element and fetches rating/votes/awards from background.js.
   *
   * @param {string} title
   * @param {string} [year]
   * @param {"movie"|"series"|""} [type]
   * @param {Element} containerElement
   * @param {{ isDetailModal?: boolean, afterElement?: Element | null, shouldAbort?: () => boolean }} [options]
   * @returns {HTMLElement | null}
   */
  function injectImdbBadge(title, year, type, containerElement, options = {}) {
    if (!containerElement || !(containerElement instanceof Element) || !containerElement.isConnected) {
      return null;
    }

    const cleanTitle = typeof title === "string" ? title.trim() : "";
    if (!cleanTitle) return null;

    const isDetailModal = Boolean(options?.isDetailModal);
    const mediaType = normalizeMediaType(type);
    const cleanYear = normalizeYear(year);
    const signature = `${cleanTitle}|${mediaType}|${isDetailModal ? "detail" : "mini"}`;

    let badge = containerElement.querySelector(":scope > .nf-imdb-badge");
    if (badge && badge.dataset.imdbSignature === signature) {
      return badge;
    }

    if (!badge) {
      badge = createBadgeElement();
      const afterEl = options?.afterElement;
      if (afterEl && afterEl.parentElement === containerElement) {
        afterEl.insertAdjacentElement("afterend", badge);
      } else {
        containerElement.appendChild(badge);
      }
    } else {
      removeAdjacentOscarWrapper(badge);
      badge.classList.remove("nf-imdb-badge--na", ...TIER_CLASSES, "high-rating-glow");
      badge.classList.add("nf-imdb-badge--loading");
      const scoreEl = badge.querySelector(".nf-imdb-score");
      if (scoreEl) scoreEl.textContent = "…";
    }

    badge.dataset.imdbSignature = signature;

    if (!chrome.runtime?.id) {
      updateBadgeDisplay(badge, "N/A", null);
      return badge;
    }

    chrome.runtime.sendMessage(
      {
        type: "GET_IMDB_RATING",
        payload: {
          title: cleanTitle,
          mediaType,
          year: cleanYear
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          if (badge.isConnected && badge.dataset.imdbSignature === signature) {
            updateBadgeDisplay(badge, "N/A", null);
          }
          return;
        }
        if (!badge.isConnected || badge.dataset.imdbSignature !== signature) {
          return;
        }
        if (typeof options?.shouldAbort === "function" && options.shouldAbort()) {
          removeAdjacentOscarWrapper(badge);
          badge.remove();
          return;
        }
        updateBadgeDisplay(badge, response?.rating || "N/A", response?.imdbVotes ?? null);
        renderOscarCounter(badge, response?.awardsText || "", isDetailModal);
      }
    );

    return badge;
  }

  /**
   * Injects a semi-transparent frosted dark pill in the top-right corner of a bare poster container
   * (uses isDetailModal: false so Oscar stacks cap at 3 on hover cards).
   *
   * @param {string} title
   * @param {string} [year]
   * @param {"movie"|"series"|""} [type]
   * @param {Element} posterContainer
   * @param {{ shouldAbort?: () => boolean }} [options]
   * @returns {HTMLElement | null}
   */
  function injectImdbPosterOverlay(title, year, type, posterContainer, options = {}) {
    if (!posterContainer || !(posterContainer instanceof Element) || !posterContainer.isConnected) {
      return null;
    }

    posterContainer.classList.add("nf-imdb-poster-anchor");

    let pill = posterContainer.querySelector(":scope > .nf-imdb-poster-pill");
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "nf-imdb-poster-pill";
      posterContainer.appendChild(pill);
    }

    injectImdbBadge(title, year, type, pill, {
      ...options,
      isDetailModal: false
    });
    return pill;
  }

  function clearImdbBadges(root = document) {
    const nodes = root.querySelectorAll(
      ".nf-imdb-poster-pill, .nf-imdb-oscar-wrapper, .nf-imdb-badge"
    );
    for (const node of nodes) {
      node.remove();
    }
  }

  window.injectImdbBadge = injectImdbBadge;
  window.injectImdbPosterOverlay = injectImdbPosterOverlay;
  window.clearImdbBadges = clearImdbBadges;
})();
