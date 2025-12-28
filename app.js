/* KillTracker (Alt1)
   - Chat OCR polling
   - KC parsing + golden-beam pet detection
   - localStorage persistence
   - export / copy
*/

const APP_STORAGE_KEY = "killtracker.v1";
const POLL_MS = 450;

// RS3 KC parsing
const KILL_PATTERN =
  /You have killed (\d+) (.+?)(?: \((hard mode|hm)\)| in (normal mode|hard mode))?\./i;

// Golden beam pet drop message
const PET_DROP_PATTERN =
  /A golden beam shines over one of your items, You receive: \d+x (.+)/i;

// ✅ FULL pet drop item list (lowercase)
const PET_ITEM_NAMES = new Set([
  "king black dragon scale",
  "kalphite egg",
  "shrivelled dagannoth claw",
  "dagannoth egg",
  "dagannoth scale",
  "ribs of chaos",
  "rotten fang",
  "giant feather",
  "auburn lock",
  "decaying tooth",
  "severed hoof",
  "blood-soaked feather",
  "blood tentacle",
  "corporeal bone",
  "volcanic shard",
  "queen black dragon scale",
  "kalphite claw",
  "corrupted ascension signet i",
  "corrupted ascension signet ii",
  "corrupted ascension signet iii",
  "corrupted ascension signet iv",
  "corrupted ascension signet v",
  "corrupted ascension signet vi",
  "ancient summoning stone",
  "ancient artefact",
  "araxyte egg",
  "durzag's helmet",
  "yakamaru's helmet",
  "faceless mask",
  "twisted antler",
  "avaryss' braid",
  "nymora's braid",
  "imbued blade slice",
  "glimmering scale",
  "telos' tendril",
  "soul fragment",
  "imbued bark shard",
  "chipped black stone crystal",
  "inert black stone crystal",
  "umbral urn",
  "broken shackle",
  "pristine bagrada rex egg",
  "pristine pavosaurus rex egg",
  "pristine corbicula rex egg",
  "kerapac's mask piece",
  "glacor core",
  "croesus's enriched root",
  "tzkal-zuk's armour piece",
  "jewels of zamorak",
  "hermod's armour spike",
  "miso's collar",
  "vorkath's claw",
  "calcified heart",
  "clawdia's shell clippings",
  "nefthys' tooth",
  "fragment of the gate",
  "amascut's promise",
  "snowverload's nose",
  "mhekarnahz's eye"
]);

// ---------- Session state ----------

let lastBossName = null;
let lastBossMode = null; // null | "nm" | "hm"
let lastKillCount = 0;
let petObtained = false;

// ---------- Runtime ----------

let running = false;
let timer = null;
let seen = new Set();
let debugLines = [];

// ---------- Utilities ----------

const $ = id => document.getElementById(id);

function normalizeBoss(name) {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function buildKey(normName, mode) {
  const base = normName.replace(/ /g, "_");
  return mode ? `${base}_${mode}` : base;
}

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(APP_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveStore(obj) {
  localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(obj));
}

function setStatus(text) {
  $("status").textContent = text;
}

function pushDebug(line) {
  debugLines.push(line);
  if (debugLines.length > 12) debugLines.shift();
  $("debug").value = debugLines.join("\n");
}

// ---------- Rendering ----------

function renderLast() {
  $("lastBoss").textContent = lastBossName ?? "—";
  $("lastMode").textContent = lastBossMode ?? "—";
  $("lastKC").textContent = lastBossName ? String(lastKillCount) : "—";
  $("lastPet").textContent = lastBossName ? (petObtained ? "✅" : "❌") : "—";
}

function renderTable() {
  const data = loadStore();
  const keys = Object.keys(data).sort();

  if (!keys.length) {
    $("tableWrap").innerHTML =
      `<div class="muted">No data yet. Kill something scary 👁️</div>`;
    return;
  }

  let rows = keys.map(k => {
    const e = data[k];
    return `
      <tr>
        <td class="mono">${escapeHtml(e.bossDisplay)}</td>
        <td class="mono">${e.mode ?? "—"}</td>
        <td class="mono">${e.kc}</td>
        <td class="mono ${e.pet ? "ok" : "no"}">${e.pet ? "✅" : "❌"}</td>
      </tr>`;
  }).join("");

  $("tableWrap").innerHTML = `
    <table>
      <thead>
        <tr><th>Boss</th><th>Mode</th><th>KC</th><th>Pet</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Persistence ----------

function upsertCurrent() {
  if (!lastBossName) return;

  const norm = normalizeBoss(lastBossName);
  const key = buildKey(norm, lastBossMode);
  const store = loadStore();

  if (store[key]?.pet) petObtained = true;

  store[key] = {
    boss: norm,
    bossDisplay: lastBossName,
    mode: lastBossMode,
    kc: lastKillCount,
    pet: petObtained,
    updatedAt: Date.now()
  };

  saveStore(store);
  renderLast();
  renderTable();
}

// ---------- Chat reading ----------

function isAlt1() {
  return typeof window.alt1 !== "undefined";
}

function readChatLines() {
  if (!isAlt1()) return { ok: false, note: "Not running inside Alt1.", lines: [] };

  try {
    if (alt1.chat?.read) {
      const res = alt1.chat.read();
      return { ok: true, note: "alt1.chat.read()", lines: Array.isArray(res) ? res : res?.messages ?? [] };
    }
  } catch {}

  return { ok: false, note: "Chat API unavailable.", lines: [] };
}

function extractText(line) {
  if (!line) return "";
  if (typeof line === "string") return line;
  if (typeof line.text === "string") return line.text;
  return "";
}

function poll() {
  const { ok, note, lines } = readChatLines();
  if (!ok) {
    setStatus(`🟠 ${note}`);
    return;
  }

  setStatus(`🟢 Running (poll ${POLL_MS}ms) via ${note}`);

  for (const l of lines.slice(-30)) {
    const text = extractText(l);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if (seen.size > 1500) seen = new Set([...seen].slice(-800));

    pushDebug(text);

    const kill = text.match(KILL_PATTERN);
    if (kill) {
      lastKillCount = parseInt(kill[1], 10);
      lastBossName = kill[2];
      lastBossMode = kill[3] || kill[4]?.includes("hard") ? "hm" : null;
      petObtained = false;

      const key = buildKey(normalizeBoss(lastBossName), lastBossMode);
      if (loadStore()[key]?.pet) petObtained = true;

      upsertCurrent();
      continue;
    }

    if (!petObtained) {
      const pet = text.match(PET_DROP_PATTERN);
      if (pet && PET_ITEM_NAMES.has(pet[1].toLowerCase().trim())) {
        petObtained = true;
        upsertCurrent();
      }
    }
  }
}

// ---------- Export ----------

function buildExportText() {
  const store = loadStore();
  return Object.values(store).map(e =>
    `${e.bossDisplay}${e.mode ? ` (${e.mode})` : ""}\n  KC: ${e.kc}\n  Pet: ${e.pet ? "✅" : "❌"}`
  ).join("\n\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: filename
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- Alt1 identify ----------

function identifyApp() {
  if (!isAlt1() || typeof alt1.identifyApp !== "function") return;

  fetch("./appconfig.json", { cache: "no-store" })
    .then(r => r.json())
    .then(cfg => {
      console.log("Alt1 identify:", cfg);
      alt1.identifyApp(JSON.stringify(cfg));
    })
    .catch(err => {
      console.error("identifyApp failed:", err);
      setStatus("🔴 identifyApp failed (check console)");
    });
}

// ---------- UI ----------

function start() {
  if (running) return;
  running = true;
  seen.clear();
  debugLines = [];
  $("debug").value = "";
  timer = setInterval(poll, POLL_MS);
  poll();
}

function stop() {
  running = false;
  clearInterval(timer);
  setStatus("🔵 Stopped.");
}

function clearAll() {
  localStorage.removeItem(APP_STORAGE_KEY);
  lastBossName = lastBossMode = null;
  lastKillCount = 0;
  petObtained = false;
  renderLast();
  renderTable();
  setStatus("🧼 Cleared all stored data.");
}

function wireUi() {
  $("btnStart").onclick = start;
  $("btnStop").onclick = stop;
  $("btnClear").onclick = clearAll;
  $("btnExport").onclick = () =>
    downloadText(`killtracker_${new Date().toISOString().slice(0, 10)}.txt`, buildExportText());
  $("btnCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(buildExportText());
      setStatus("📋 Copied export.");
    } catch {
      setStatus("🟠 Clipboard blocked.");
    }
  };
}

// ---------- Init ----------

(function init() {
  wireUi();
  renderLast();
  renderTable();
  identifyApp();
  setStatus(isAlt1() ? "🟡 Ready. Click Start." : "🟠 Open inside Alt1.");
})();
