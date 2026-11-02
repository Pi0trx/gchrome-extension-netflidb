# Streaming IMDb Ratings (Chrome Extension)

Displays IMDb ratings via the [OMDb API](https://www.omdbapi.com/) inside a vote-tiered star across **Netflix**, **Amazon Prime Video**, **Disney+**, and **SkyShowtime**.

## Features & Visual Guide

The extension dynamically styles the IMDb badge to give you instant visual feedback on a title's popularity, critical acclaim, and award history, blending seamlessly into each platform's native UI.

### 🌟 The Star Color Tiers (Vote Count)
The color of the star indicates how many people have rated the title, helping you distinguish between niche indie films and massive blockbusters.
* **Bronze:** `< 50,000` votes (Niche titles, hidden gems, or newer releases)
* **Silver:** `50,000` to `249,999` votes (Highly popular mainstream titles)
* **Gold:** `250,000` to `749,999` votes (Massive blockbusters and cultural hits)
* **Diamond (Animated Shimmer):** `>= 750,000` votes (Legendary, historic status — e.g., *Breaking Bad*, *Stranger Things*)

### ✨ High Rating Glow (`> 8.0`)
If a title sits in the Bronze, Silver, or Gold tier but has an exceptional IMDb rating strictly greater than **8.0**, the star emits a pulsing metallic glow. This immediately highlights incredible movies and shows that you might otherwise scroll past.

### 🏆 Stacked Oscar Counter
Titles that have won Academy Awards feature a custom, golden statuette icon stacked next to the badge.
* **Hover Cards:** To save space while browsing, the UI displays a maximum of 3 overlapping statuettes, plus the total number (e.g., 🕴️🕴️🕴️ `11`).
* **Detail Pages:** When you click into a movie, the UI displays the absolute total number of statues perfectly stacked like a deck of cards to visually communicate the magnitude of the wins.

---

## Installation

> **Note on API Keys:** Because this is a public repository, the `config.js` file containing the OMDb API keys is excluded via `.gitignore` for security. You must add your own free keys to run the extension.

1. **Download the Extension:** Clone this repository or download it as a `.zip` and extract it to a permanent folder on your computer.
2. **Add Your API Keys:** Inside the extension folder, create a new file named exactly `config.js` and paste the following code, replacing the placeholder strings with your keys from [OMDb API](https://www.omdbapi.com/):
   ```javascript
   const OMDB_API_KEYS = [
     "YOUR_KEY_1",
     "YOUR_KEY_2" // Add backups for automatic failover
   ];