if (window.A1lib?.identifyApp) {
  A1lib.identifyApp("appconfig.json");
} else {
  console.warn("Alt1 base library missing; chat reading disabled.");
}

function log(msg) {
  console.log(msg);
  const out = document.getElementById("output");
  if (!out) return;
  const div = document.createElement("div");
  div.textContent = msg;
  out.prepend(div);
  while (out.childElementCount > 80) out.removeChild(out.lastChild);
}

if (!window.alt1) {
  document.body.innerHTML = `<div style="padding:16px">Alt1 not detected. Open this page in Alt1 or click <a href="alt1://addapp/${location.href}">here</a> to add the app.</div>`;
}

const CLUE_ITEMS = new Set([
  "sealed clue scroll easy",
  "sealed clue scroll medium",
  "sealed clue scroll hard",
  "sealed clue scroll elite",
  "sealed clue scroll master",
]);

const PET_ITEM_NAMES = new Set([
  "king black dragon scale","kalphite egg","shrivelled dagannoth claw","dagannoth egg",
  "dagannoth scale","ribs of chaos","rotten fang","giant feather","auburn lock",
  "decaying tooth","severed hoof","blood-soaked feather","blood tentacle",
  "corporeal bone","volcanic shard","queen black dragon scale","kalphite claw",
  "corrupted ascension signet i","corrupted ascension signet ii",
  "corrupted ascension signet iii","corrupted ascension signet iv",
  "corrupted ascension signet v","corrupted ascension signet vi",
  "ancient summoning stone","ancient artefact","araxyte egg","durzag's helmet",
  "yakamaru's helmet","faceless mask","twisted antler","avaryss' braid",
  "nymora's braid","imbued blade slice","glimmering scale","telos' tendril",
  "soul fragment","imbued bark shard","chipped black stone crystal",
  "inert black stone crystal","umbral urn","broken shackle",
  "pristine bagrada rex egg","pristine pavosaurus rex egg",
  "pristine corbicula rex egg","kerapac's mask piece","glacor core",
  "croesus's enriched root","tzkal-zuk's armour piece","jewels of zamorak",
  "hermod's armour spike","miso's collar","vorkath's claw","calcified heart",
  "clawdia's shell clippings","nefthys' tooth","fragment of the gate",
  "amascut's promise","snowverload's nose","mhekarnahz's eye"
].map(normalizeItem));

const RECEIVE_WINDOW_MS = 2000;
const DROP_DEDUPE_WINDOW_MS = 2500;
const BUFFER_CLEAR_INTERVAL = 3000;

const KILL_PATTERN = /You have killed ([\d,]+)\s+(.+?)(?: \((hard mode|hm)\)| in (normal mode|hard mode))?\./i;
const MILESTONE_PATTERN = /Milestone: You have killed ([\d,]+) (.+?)!/i;
const RECEIVE_PATTERN = /You receive:\s*\d+(?:\s*[x×]\s*)?(.+?)(?:[.!?]|$)/i;
const GOLDEN_BEAM_PATTERN =
  /A golden beam shines over one of your items\.\s*You receive:\s*\d+(?:\s*[x×]\s*)?(.+?)(?:[.!?]|$)/i;
const NEWS_DROP_PATTERN = /News: (.+?) has received (?:a |an )?(.+?) drop!(?: at ([\d,]+) kills!)?/i;
const SESSION_WELCOME_PATTERN = /Welcome to your session again: (.+?)\./i;

const seenLineTimes = new Map();

function normalizeItem(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeBoss(s) {
  return (s || "").toLowerCase().replace(/[^a-z]/g, " ").replace(/\s+/g, " ").trim();
}
function normalizePath(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function stripTags(s) {
  return (s || "").replace(/<[^>]+>/g, "");
}

const state = {
  bossUniques: {},
  petKC: new Map(),
  latestKC: new Map(),
  lastBossName: null,
  lastBossMode: null,
  lastKillCount: 0,
  lastNMKC: 0,
  lastHMKC: 0,
  lastKillAt: 0,
  sessionStartKC: null,
  pendingDrops: [],
  recentBuffered: new Set(),
  lastRecentClear: 0,
  sessionLoggedUniques: new Set(),
  sessionLoggedClues: new Set(),
  sessionLoggedCluesKC: new Set(),
  lastLoggedDropKey: null,
  lastLoggedDropAt: 0,
  collectionCounts: new Map(),
  clueCounts: new Map(),
  latestUnique: null,
};

async function loadStaticData() {
  try {
    const resp = await fetch("./rs3-stats/boss_uniques_map.txt");
    const text = await resp.text();
    parseUniqueMap(text);
  } catch (e) {
    log("⚠️ Failed to load uniques map: " + e);
  }

  try {
    const resp = await fetch("./rs3-stats/boss_pets.txt");
    const text = await resp.text();
    parsePetMap(text);
  } catch {}

  try {
    const resp = await fetch("./rs3-stats/boss_latest_kc.txt");
    const text = await resp.text();
    parseLatestKC(text);
  } catch {}
}

function parseUniqueMap(text) {
  const lines = text.split(/\r?\n/);
  let boss = null;
  lines.forEach((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) return;
    if (clean.endsWith(":")) {
      boss = normalizeBoss(clean.replace(":", ""));
      state.bossUniques[boss] = [];
    } else if (boss) {
      state.bossUniques[boss].push(normalizeItem(clean));
    }
  });
}

function parsePetMap(text) {
  text.split(/\r?\n/).forEach((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#") || !clean.includes(":")) return;
    const [boss, kc] = clean.split(":");
    const num = Number(kc.trim());
    state.petKC.set(normalizeBoss(boss), Number.isFinite(num) ? num : null);
  });
}

function parseLatestKC(text) {
  text.split(/\r?\n/).forEach((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) return;
    const parts = clean.split(":");
    if (parts.length !== 3) return;
    const key = normalizeBoss(parts[0]);
    const mode = parts[1].toLowerCase();
    const kc = Number(parts[2]);
    if (!Number.isFinite(kc)) return;
    const entry = state.latestKC.get(key) || { nm: 0, hm: 0 };
    if (mode === "nm") entry.nm = kc;
    if (mode === "hm") entry.hm = kc;
    state.latestKC.set(key, entry);
  });
}

function shouldIgnoreLine(lineId, windowMs = 5000) {
  const now = Date.now();
  const last = seenLineTimes.get(lineId) ?? 0;
  if (now - last < windowMs) return true;
  seenLineTimes.set(lineId, now);
  if (seenLineTimes.size > 400) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [id, ts] of seenLineTimes) {
      if (ts < cutoff) seenLineTimes.delete(id);
    }
  }
  return false;
}

function getClueImage(tier) {
  return `./webui/images/clues/sealed_clue_scroll_${tier}.png`;
}

function extractClueTier(item) {
  if (!item.startsWith("sealed clue scroll")) return null;
  if (item.includes("easy")) return "easy";
  if (item.includes("medium")) return "medium";
  if (item.includes("hard")) return "hard";
  if (item.includes("elite")) return "elite";
  if (item.includes("master")) return "master";
  return null;
}

function getSessionKC() {
  if (state.sessionStartKC == null) return 0;
  return Math.max(0, state.lastKillCount - state.sessionStartKC);
}

function killsSincePet() {
  const key = normalizeBoss(state.lastBossName);
  const petKC = state.petKC.get(key);
  if (petKC == null) return 0;
  return Math.max(0, state.lastKillCount - petKC);
}

function totalUniquesForBoss() {
  const key = normalizeBoss(state.lastBossName);
  const list = state.bossUniques[key] || [];
  return list.length;
}

function distinctUniquesCount() {
  const seen = new Set();
  for (const [item] of state.collectionCounts) {
    seen.add(item);
  }
  return seen.size;
}

function totalUniqueDrops() {
  let total = 0;
  for (const [, count] of state.collectionCounts) total += count;
  return total;
}

function killsSinceLastUnique() {
  if (!state.latestUnique) return state.lastKillCount;
  const entry = state.latestUnique;
  return Math.max(0, state.lastKillCount - entry.kc);
}

function updateUI() {
  const bossName = state.lastBossName || "Waiting for boss...";
  const bossNorm = normalizePath(state.lastBossName || "");
  const bossImg = document.getElementById("boss-image");
  bossImg.src = state.lastBossName ? `./webui/images/${bossNorm}/${bossNorm}.png` : "";
  const mode = state.lastBossMode ? ` (${state.lastBossMode})` : "";
  const bossTitle = document.getElementById("boss-name");
  if (bossTitle) bossTitle.textContent = `${bossName}${mode}`.trim();

  document.getElementById("stat-total").textContent = state.lastKillCount.toLocaleString();
  document.getElementById("stat-nm").textContent = state.lastNMKC.toLocaleString();
  document.getElementById("stat-hm").textContent = state.lastHMKC.toLocaleString();

  const sessionKC = getSessionKC().toLocaleString();
  document.getElementById("stat-session").textContent = sessionKC;
  const sessionInline = document.getElementById("stat-session-inline");
  if (sessionInline) sessionInline.textContent = sessionKC;

  const petKey = normalizeBoss(state.lastBossName);
  const petKC = state.petKC.get(petKey);
  const petText = petKC != null ? petKC.toLocaleString() : "—";
  document.getElementById("stat-pet").textContent = petText;
  const petInline = document.getElementById("stat-pet-inline");
  if (petInline) petInline.textContent = petText;

  const sincePetText = petKC != null ? killsSincePet().toLocaleString() : "—";
  document.getElementById("stat-since-pet").textContent = sincePetText;
  const sincePetInline = document.getElementById("stat-since-pet-inline");
  if (sincePetInline) sincePetInline.textContent = sincePetText;

  document.getElementById("stat-log").textContent = `${distinctUniquesCount()}/${totalUniquesForBoss()}`;
  document.getElementById("stat-uniques").textContent = totalUniqueDrops().toLocaleString();
  document.getElementById("stat-dry").textContent = killsSinceLastUnique().toLocaleString();

  updateLatestUnique();
  renderClues();
  renderCollectionLog();
}

function renderClues() {
  const container = document.getElementById("clues");
  if (!container) return;
  container.innerHTML = "";
  const tiers = ["easy", "medium", "hard", "elite", "master"];
  tiers.forEach((tier) => {
    const count = state.clueCounts.get(tier) || 0;
    const div = document.createElement("div");
    div.className = "clue";
    div.innerHTML = `<img src="${getClueImage(tier)}" alt="${tier}"><div><div>${tier}</div><div class="log-count">${count}</div></div>`;
    container.appendChild(div);
  });
}

function renderCollectionLog() {
  const container = document.getElementById("collection-log");
  if (!container) return;
  container.innerHTML = "";
  const key = normalizeBoss(state.lastBossName);
  const uniques = state.bossUniques[key];
  if (!uniques || uniques.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No uniques mapped for this boss.";
    container.appendChild(empty);
    return;
  }

  uniques.forEach((item) => {
    const count = state.collectionCounts.get(item) || 0;
    const obtained = count > 0;
    const itemNorm = normalizePath(item);
    const div = document.createElement("div");
    div.className = "log-slot" + (obtained ? " obtained" : " missing");

    const img = document.createElement("img");
    img.src = `./webui/images/${normalizePath(state.lastBossName || "")}/${itemNorm}.png`;
    img.alt = item;

    const countEl = document.createElement("div");
    countEl.className = "log-count" + (obtained ? "" : " missing");
    countEl.textContent = count.toLocaleString();

    div.appendChild(img);
    div.appendChild(countEl);
    container.appendChild(div);
  });
}

function updateLatestUnique() {
  const latestText = document.getElementById("latest-unique-text");
  const icons = document.getElementById("latest-unique-icons");
  if (!latestText || !icons) return;

  const latestItem = state.latestUnique?.item;
  latestText.textContent = latestItem || "—";
  icons.innerHTML = "";

  if (!latestItem) return;

  const slot = document.createElement("div");
  slot.className = "latest-slot";
  const img = document.createElement("img");
  const bossNorm = normalizePath(state.lastBossName || "");
  img.src = `./webui/images/${bossNorm}/${normalizePath(latestItem)}.png`;
  img.alt = latestItem;
  slot.appendChild(img);
  icons.appendChild(slot);
}

function handleChatLine(rawLine) {
  const line = stripTags(rawLine)
    .replace(/^\[(?:\d{2}:){2}\d{2}\]\s*/, "")
    .trim();
  if (!line) return;
  if (shouldIgnoreLine(line)) return;

  let m;
  if ((m = SESSION_WELCOME_PATTERN.exec(line))) {
    const boss = m[1];
    state.lastBossName = boss;
    state.sessionStartKC = state.lastKillCount || 0;
    loadBaselineKC(boss);
    updateUI();
    log(`Session resumed for ${boss}`);
    return;
  }

  if ((m = KILL_PATTERN.exec(line))) {
    const kc = Number(m[1].replace(/,/g, ""));
    const boss = m[2].replace(/\s*\(.*?\)/, "").trim();
    const hm = !!(m[3] || (m[4] && m[4].toLowerCase().includes("hard")));
    handleKill(boss, kc, hm);
    return;
  }

  if ((m = MILESTONE_PATTERN.exec(line))) {
    const kc = Number(m[1].replace(/,/g, ""));
    const boss = m[2];
    state.lastBossName = boss;
    state.lastKillCount = kc;
    updateUI();
    log(`Milestone: ${boss} at ${kc}`);
    return;
  }

  if ((m = GOLDEN_BEAM_PATTERN.exec(line))) {
    const item = normalizeItem(m[1]);
    bufferDrop(item);
    return;
  }

  if ((m = RECEIVE_PATTERN.exec(line))) {
    const item = normalizeItem(m[1]);
    bufferDrop(item);
    return;
  }

  if ((m = NEWS_DROP_PATTERN.exec(line))) {
    log(`News drop spotted for ${m[1]}: ${m[2]}`);
    return;
  }
}

function bufferDrop(item) {
  const now = Date.now();
  if (now - state.lastRecentClear > BUFFER_CLEAR_INTERVAL) {
    state.recentBuffered.clear();
    state.lastRecentClear = now;
  }
  if (state.recentBuffered.has(item)) {
    log(`Ignoring duplicate drop line: ${item}`);
    return;
  }
  state.recentBuffered.add(item);
  state.pendingDrops.push({ item, timestamp: now });
  if (
    state.lastBossName &&
    state.lastKillCount > 0 &&
    state.lastKillAt &&
    now - state.lastKillAt <= RECEIVE_WINDOW_MS
  ) {
    const resolved = processPendingDrops(
      state.lastKillCount,
      normalizeBoss(state.lastBossName)
    );
    if (resolved) updateUI();
  }
  if (!state.lastBossName) {
    state.sessionStartKC = state.lastKillCount;
  }
  log(`Buffered drop: ${item}`);
}

function handleKill(boss, kc, hm) {
  state.lastBossName = boss;
  state.lastBossMode = hm ? "HM" : "NM";
  state.lastKillAt = Date.now();
  if (hm) state.lastHMKC = kc; else state.lastNMKC = kc;
  state.lastKillCount = Math.max(state.lastKillCount, (state.lastNMKC || 0) + (state.lastHMKC || 0));
  if (state.sessionStartKC == null) state.sessionStartKC = state.lastKillCount - 1;

  const key = normalizeBoss(boss);
  const entry = state.latestKC.get(key) || { nm: 0, hm: 0 };
  if (hm) entry.hm = Math.max(entry.hm, kc); else entry.nm = Math.max(entry.nm, kc);
  state.latestKC.set(key, entry);

  processPendingDrops(kc, key);
  updateUI();
  log(`KC updated for ${boss}: ${kc} (${state.lastBossMode})`);
}

function processPendingDrops(kc, bossKey) {
  const now = Date.now();
  const remaining = [];
  let resolved = false;
  for (const pd of state.pendingDrops) {
    if (now - pd.timestamp > RECEIVE_WINDOW_MS) continue;
    const dedupeKey = `${kc}|${pd.item}|${bossKey}`;
    if (state.lastLoggedDropKey === dedupeKey && now - state.lastLoggedDropAt <= DROP_DEDUPE_WINDOW_MS) continue;
    state.lastLoggedDropKey = dedupeKey;
    state.lastLoggedDropAt = now;
    resolveDrop(pd.item, kc);
    resolved = true;
  }
  state.pendingDrops = remaining;
  return resolved;
}

function resolveDrop(item, kc) {
  const bossKey = normalizeBoss(state.lastBossName);
  const uniques = state.bossUniques[bossKey] || [];
  if (PET_ITEM_NAMES.has(item) && !state.petKC.has(bossKey)) {
    state.petKC.set(bossKey, kc);
    log(`Pet obtained at ${kc}!`);
  }

  if (uniques.includes(item)) {
    const uniqueKey = `${bossKey}|${kc}|${item}`;
    if (state.sessionLoggedUniques.has(uniqueKey)) return;
    state.sessionLoggedUniques.add(uniqueKey);
    const prev = state.collectionCounts.get(item) || 0;
    state.collectionCounts.set(item, prev + 1);
    state.latestUnique = { item, kc };
    log(`Unique drop: ${item} at ${kc}`);
  }

  const tier = extractClueTier(item);
  if (tier) {
    const clueKey = `${bossKey}|${kc}|${item}`;
    if (!state.sessionLoggedCluesKC.has(clueKey)) {
      state.sessionLoggedCluesKC.add(clueKey);
      state.sessionLoggedClues.add(`${bossKey}|${item}`);
      const prev = state.clueCounts.get(tier) || 0;
      state.clueCounts.set(tier, prev + 1);
      log(`Clue scroll (${tier}) at ${kc}`);
    }
  }
}

function loadBaselineKC(boss) {
  const key = normalizeBoss(boss);
  const entry = state.latestKC.get(key);
  if (!entry) return;
  state.lastNMKC = entry.nm;
  state.lastHMKC = entry.hm;
  state.lastKillCount = (entry.nm || 0) + (entry.hm || 0);
}

function startChatReader() {
  if (!window.Chatbox?.default) {
    log("Chatbox library missing; ensure vendor scripts are loaded.");
    return;
  }

  const reader = new Chatbox.default();
  reader.readargs = { ...reader.readargs, backwards: true };

  function tick() {
    try {
      const segs = reader.read();
      if (!segs || !segs.length) return;
      for (const seg of segs) {
        if (!seg || typeof seg.text !== "string") continue;
        handleChatLine(seg.text);
      }
    } catch (e) {
      log(`Chat read error: ${e?.message || e}`);
    }
  }

  function findChat() {
    try {
      reader.find();
      if (reader.pos && reader.pos.mainbox) {
        log("✅ Chatbox found");
        showSelected(reader.pos);
        setInterval(tick, 300);
        clearInterval(finder);
      }
    } catch (e) {
      log(`Chat find failed: ${e?.message || e}`);
    }
  }

  const finder = setInterval(findChat, 800);
}

function showSelected(pos) {
  try {
    const b = pos.mainbox.rect;
    alt1.overLayRect(A1lib.mixColor(0, 255, 0), b.x, b.y, b.width, b.height, 2000, 4);
  } catch {}
}

(async function init() {
  await loadStaticData();
  updateUI();
  if (!window.alt1) {
    log("Alt1 not detected; chat reading disabled.");
    return;
  }

  if (!alt1?.permissionPixel) {
    log("Alt1 pixel permission missing. Re-add the app to grant screen capture permissions.");
    return;
  }

  startChatReader();
})();
