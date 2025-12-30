const JSON_URL = "current_boss.json";
const REFRESH_INTERVAL = 1500;

const LOG_COLUMNS = 7;
const LOG_ROWS = 6;
const LOG_SLOTS = LOG_COLUMNS * LOG_ROWS;

let lastLatestUnique = null;
let obtainedCache = new Set();

async function fetchBossData() {
  try {
    const res = await fetch(`${JSON_URL}?_=${Date.now()}`);
    if (!res.ok) throw new Error("Fetch failed");
    const data = await res.json();
    updateUI(data);
  } catch (err) {
    console.error("Overlay fetch error:", err);
  }
}

function updateUI(data) {
  const boss = data.boss || {};
  const stats = data.stats || {};

  /* ===== BOSS ===== */

  let bossName = boss.name || "—";
  if (boss.mode === "NM") bossName += " (NM)";
  if (boss.mode === "HM") bossName += " (HM)";
  document.getElementById("boss-name").textContent = bossName;

  if (boss.image) {
    const img = document.getElementById("boss-image");
    img.src = boss.image;
    img.style.display = "block";
  }

  /* ===== STATS (NO MATH) ===== */

  document.getElementById("stat-total-kc").textContent =
    typeof stats.total_kc === "number" ? stats.total_kc : "—";

  document.getElementById("stat-nm-kc").textContent =
    typeof stats.nm_kc === "number" ? stats.nm_kc : "—";

  document.getElementById("stat-hm-kc").textContent =
    typeof stats.hm_kc === "number" ? stats.hm_kc : "—";

  document.getElementById("stat-session-kc").textContent =
    typeof stats.session_kc === "number" ? stats.session_kc : "—";

  document.getElementById("stat-pet").textContent =
    stats.pet ? stats.total_kc - stats.since_pet : "—";

  document.getElementById("stat-since-pet").textContent =
    stats.pet ? stats.since_pet : "—";

  document.getElementById("stat-log").textContent =
    stats.log_progress
      ? `${stats.log_progress.obtained} / ${stats.log_progress.total}`
      : "—";

  document.getElementById("stat-uniques").textContent =
    typeof stats.total_uniques === "number" ? stats.total_uniques : "—";

  document.getElementById("stat-dry").textContent =
    typeof stats.dry_streak === "number" ? stats.dry_streak : "—";

  /* ===== CLUES ===== */

  const cluesRow = document.getElementById("clues-row");
  cluesRow.innerHTML = "";

  if (stats.clues) {
    for (const tier of ["easy", "medium", "hard", "elite", "master"]) {
      const clue = stats.clues[tier];
      if (!clue) continue;

      const cell = document.createElement("div");
      cell.className = "item-cell";

      const img = document.createElement("img");
      img.src = clue.image;

      if (clue.count === 0) {
        img.classList.add("unobtained");
        cell.classList.add("unobtained");
      }

      cell.appendChild(img);

      if (clue.count > 1) {
        const badge = document.createElement("span");
        badge.className = "item-count";
        badge.textContent = clue.count;
        cell.appendChild(badge);
      }

      cluesRow.appendChild(cell);
    }
  }

  /* ===== LATEST UNIQUE ===== */

  const latestText = document.getElementById("stat-latest");
  const latestIcon = document.getElementById("latest-unique-icon");
  const latestPanel = document.getElementById("latest-unique-panel");

  if (stats.latest_unique) {
    latestText.textContent = stats.latest_unique;

    const iconName = stats.latest_unique
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");

    const basePath = boss.image.replace(/\/[^/]+$/, "");
    latestIcon.src = `${basePath}/${iconName}.png`;

    if (stats.latest_unique !== lastLatestUnique) {
      lastLatestUnique = stats.latest_unique;
      latestPanel.classList.remove("glow");
      void latestPanel.offsetWidth;
      latestPanel.classList.add("glow");
    }
  } else {
    latestText.textContent = "—";
  }

  /* ===== COLLECTION LOG ===== */

  const logEl = document.getElementById("collection-log");
  logEl.innerHTML = "";

  const items = data.collection_log || [];

  for (let i = 0; i < LOG_SLOTS; i++) {
    const cell = document.createElement("div");
    cell.className = "item-cell";

    if (i < items.length) {
      const item = items[i];
      const img = document.createElement("img");
      img.src = item.image;

      if (!item.obtained) {
        img.classList.add("unobtained");
        cell.classList.add("unobtained");
      } else if (!obtainedCache.has(item.name)) {
        cell.classList.add("new");
        obtainedCache.add(item.name);
      }

      cell.appendChild(img);

      if (item.count > 1) {
        const badge = document.createElement("span");
        badge.className = "item-count";
        badge.textContent = item.count;
        cell.appendChild(badge);
      }
    } else {
      cell.classList.add("empty");
    }

    logEl.appendChild(cell);
  }
}

setInterval(fetchBossData, REFRESH_INTERVAL);
fetchBossData();
