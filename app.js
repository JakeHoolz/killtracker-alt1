/* KillTracker (Alt1)
   - Chat OCR polling
   - KC parsing + golden-beam pet detection
   - localStorage persistence
   - export/copy
*/

const APP_STORAGE_KEY = "killtracker.v1";
const POLL_MS = 450;

// RS3 KC parsing (ported from your Java)
const KILL_PATTERN =
  /You have killed (\d+) (.+?)(?: \((hard mode|hm)\)| in (normal mode|hard mode))?\./i;

// Golden beam pet drop message (ported)
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

// Session state (mirrors your Java state)
let lastBossName = null;
let lastBossMode = null; // null | "nm" | "hm"
let lastKillCount = 0;
let petObtained = false;

// Runtime
let running = false;
let timer = null;

// Alt1 chat line de-duplication
let seen = new Set();
let debugLines = [];

// ---------- Utility ----------

function $(id) { return document.getElementById(id); }

function normalizeBoss(bossName) {
  return bossName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

function buildKey(bossNameNormalized, mode) {
  const base = bossNameNormalized.replace(/ /g, "_");
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

// ---------- UI render ----------

function renderLast() {
  $("lastBoss").textContent = lastBossName ? lastBossName : "—";
  $("lastMode").textContent = lastBossMode ? lastBossMode : "—";
  $("lastKC").textContent = lastBossName ? String(lastKillCount) : "—";
  $("lastPet").textContent = lastBossName ? (petObtained ? "✅" : "❌") : "—";
}

function renderTable() {
  const data = loadStore();
  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b));

  if (keys.length === 0) {
    $("tableWrap").innerHTML = `<div class="muted">No data yet. Kill something scary 👁️</div>`;
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th>Boss</th>
          <th>Mode</th>
          <th>KC</th>
          <th>Pet</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const k of keys) {
    const entry = data[k];
    const { boss, mode, kc, pet } = entry;
    html += `
      <tr>
        <td class="mono">${escapeHtml(boss)}</td>
        <td class="mono">${mode ? mode : "—"}</td>
        <td class="mono">${kc}</td>
        <td class="mono ${pet ? "ok" : "no"}">${pet ? "✅" : "❌"}</td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  $("tableWrap").innerHTML = html;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Persistence (Java writeKillsFile equivalent) ----------

function upsertCurrent() {
  if (!lastBossName) return;

  const bossNorm = normalizeBoss(lastBossName);
  const key = buildKey(bossNorm, lastBossMode);

  const store = loadStore();
  const existing = store[key];

  // 🔒 Never downgrade pet status
  if (existing?.pet) petObtained = true;

  store[key] = {
    boss: bossNorm,
    mode: lastBossMode,       // null | "nm" | "hm"
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

/*
  Alt1 has had a few chat APIs across versions/apps.
  We try a few approaches to keep this “works out of the box” for more people.

  Expected line object shapes we tolerate:
    - {text: "..."}
    - "raw string"
*/
function readChatLinesBestEffort() {
  // If not in Alt1: no chat access
  if (!isAlt1()) return { ok: false, lines: [], note: "Not running inside Alt1." };

  // (1) If a built-in chat API exists
  try {
    if (alt1.chat && typeof alt1.chat.read === "function") {
      const res = alt1.chat.read();
      // Some versions return arrays, some return objects with .messages
      const lines = Array.isArray(res) ? res : (res?.messages || res?.lines || []);
      return { ok: true, lines, note: "alt1.chat.read()" };
    }
  } catch (e) {
    // keep going
  }

  // (2) Older/other variants sometimes expose alt1.rs.chat
  try {
    if (alt1.rs && alt1.rs.chat && typeof alt1.rs.chat.read === "function") {
      const res = alt1.rs.chat.read();
      const lines = Array.isArray(res) ? res : (res?.messages || res?.lines || []);
      return { ok: true, lines, note: "alt1.rs.chat.read()" };
    }
  } catch (e) {
    // keep going
  }

  return {
    ok: false,
    lines: [],
    note: "Alt1 chat API not available. Ensure the app has Game State permission and chatbox is visible."
  };
}

function extractText(line) {
  if (!line) return "";
  if (typeof line === "string") return line;
  if (typeof line.text === "string") return line.text;
  if (typeof line.message === "string") return line.message;
  return "";
}

function lineId(text) {
  // lightweight hash-ish id
  // avoids spamming repeats if OCR polls the same visible lines
  return text + "|" + text.length;
}

function poll() {
  const got = readChatLinesBestEffort();
  if (!got.ok) {
    setStatus(`🟠 ${got.note}`);
    return;
  }

  setStatus(`🟢 Running (poll ${POLL_MS}ms) via ${got.note}`);

  // Grab a handful of lines and process new ones only
  const raw = got.lines.slice(-30);

  for (const l of raw) {
    const text = extractText(l);
    if (!text) continue;

    const id = lineId(text);
    if (seen.has(id)) continue;
    seen.add(id);

    // prevent the set from growing forever
    if (seen.size > 2000) {
      seen = new Set(Array.from(seen).slice(-1200));
    }

    pushDebug(text);

    // 1️⃣ KC parsing
    const killMatch = text.match(KILL_PATTERN);
    if (killMatch) {
      lastKillCount = parseInt(killMatch[1], 10);
      lastBossName = killMatch[2];

      let mode = null;
      if (killMatch[3]) {
        mode = "hm";
      } else if (killMatch[4]) {
        mode = killMatch[4].toLowerCase().includes("hard") ? "hm" : "nm";
      }
      lastBossMode = mode;

      // reset pet flag for “session state” unless store already has pet
      petObtained = false;

      // store may already have pet for this boss/mode, keep it
      const bossNorm = normalizeBoss(lastBossName);
      const key = buildKey(bossNorm, lastBossMode);
      const store = loadStore();
      if (store[key]?.pet) petObtained = true;

      upsertCurrent();
      continue;
    }

    // 2️⃣ Pet detection via golden beam
    if (!petObtained) {
      const petMatch = text.match(PET_DROP_PATTERN);
      if (petMatch) {
        const itemName = petMatch[1].toLowerCase().trim();
        if (PET_ITEM_NAMES.has(itemName)) {
          petObtained = true;
          upsertCurrent();
        }
      }
    }
  }
}

// ---------- Export ----------

function buildExportText() {
  const store = loadStore();
  const keys = Object.keys(store).sort((a, b) => a.localeCompare(b));

  let out = [];
  out.push("KillTracker export");
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push("");

  for (const k of keys) {
    const e = store[k];
    const bossLabel = e.mode ? `${e.boss} (${e.mode})` : e.boss;
    out.push(`${bossLabel}`);
    out.push(`  KC: ${e.kc}`);
    out.push(`  Pet: ${e.pet ? "✅" : "❌"}`);
    out.push("");
  }
  return out.join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- App bootstrap ----------

async function identifyIfPossible() {
  if (!isAlt1() || typeof alt1.identifyApp !== "function") return;

  try {
    const cfg = await fetch("./appconfig.json", { cache: "no-store" }).then(r => r.json());
    // alt1.identifyApp expects a JSON string :contentReference[oaicite:2]{index=2}
    alt1.identifyApp(JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

function start() {
  if (running) return;
  running = true;

  // clear de-dupe for a clean start
  seen.clear();
  debugLines = [];
  $("debug").value = "";

  timer = setInterval(poll, POLL_MS);
  poll();
}

function stop() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  setStatus("🔵 Stopped.");
}

function clearAll() {
  localStorage.removeItem(APP_STORAGE_KEY);

  lastBossName = null;
  lastBossMode = null;
  lastKillCount = 0;
  petObtained = false;

  renderLast();
  renderTable();
  setStatus("🧼 Cleared all stored data.");
}

function wireUi() {
  $("btnStart").addEventListener("click", start);
  $("btnStop").addEventListener("click", stop);
  $("btnClear").addEventListener("click", clearAll);

  $("btnExport").addEventListener("click", () => {
    const txt = buildExportText();
    const fn = `killtracker_export_${new Date().toISOString().slice(0,10)}.txt`;
    downloadText(fn, txt);
  });

  $("btnCopy").addEventListener("click", async () => {
    const txt = buildExportText();
    try {
      await navigator.clipboard.writeText(txt);
      setStatus("📋 Export copied to clipboard.");
    } catch {
      setStatus("🟠 Clipboard blocked. Use Download instead.");
    }
  });
}

// Init
(async function main() {
  wireUi();
  renderLast();
  renderTable();
  await identifyIfPossible();

  if (!isAlt1()) {
    setStatus("🟠 Open this page inside Alt1 to read chat.");
  } else {
    setStatus("🟡 Ready. Click Start.");
  }
})();
