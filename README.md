# Streaming IMDb Ratings (Chrome Extension)

Displays IMDb ratings via the [OMDb API](https://www.omdbapi.com/) inside a vote-tiered star across **Netflix**, **Amazon Prime Video**, **Disney+**, and **SkyShowtime**.

## Architecture

- **`background.js` & `config.js`:** Shared OMDb service worker with primary + backup API key failover (`ee99e74c` -> `32e16a2a` -> `98870b09`), vote-count parsing, and 3-day `chrome.storage.session` caching (automatically cleared when Chrome closes).
- **`content-shared.js` & `styles.css`:** Shared SVG badge builder (`window.injectImdbBadge`, `window.injectImdbPosterOverlay`), vote-count color tiers (Bronze, Silver, Gold, Diamond ice shimmer), `> 8.0` metallic glows, and a stacked overlapping Oscar win counter (capped at 3 statuettes on hover cards; exact win count on detail views).
- **Isolated Platform Modules:**
  - `content-netflix.js` (`*://*.netflix.com/*`)
  - `content-prime.js` (`*://*.primevideo.com/*`, `*://*.amazon.com/*`, `*://*.amazon.pl/*`, `*://*.amazon.co.uk/*`) — includes aggressive tag/bracket title cleaning and hides Amazon's native plain-text IMDb label.
  - `content-disney.js` (`*://*.disneyplus.com/*`)
  - `content-skyshowtime.js` (`*://*.skyshowtime.com/*`)

## Installation / Reload

1. Open `chrome://extensions/` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select this folder (or click the reload icon on the extension card).
