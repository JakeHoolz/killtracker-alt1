import os
import re
import time
from dataclasses import dataclass
from collections import deque, defaultdict
from typing import Dict, Set, List, Tuple, Optional

import numpy as np
import cv2
from PIL import Image
from mss import mss
import pytesseract

pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


# ============================================================
# CONFIG
# ============================================================

DEBUG = True

# If tesseract isn't in PATH, set this:
TESSERACT_EXE = None
# Example:
# TESSERACT_EXE = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

POLL_SEC = 0.50

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BOSSES_DIR = os.path.join(SCRIPT_DIR, "bosses")

UNIQUE_MAP_FILE = os.path.join(SCRIPT_DIR, "boss_uniques_map.txt")
PET_MAP_FILE = os.path.join(SCRIPT_DIR, "boss_pets.txt")
GLOBAL_UI_FILE = os.path.join(SCRIPT_DIR, "current_boss.txt")
LOCAL_USERNAME_FILE = os.path.join(SCRIPT_DIR, "local_username.txt")

RECEIVE_WINDOW_MS = 1000

# ---- Chat capture region as ratios of the chosen 4K monitor ----
# You said: RS3 fullscreen, chat bottom-left.
# Start here; tune if needed.
CHAT_LEFT_RATIO = 0.0   # ~0.6% from left
CHAT_TOP_RATIO  = 0.81   # ~70.5% down from top
CHAT_W_RATIO    = 0.31    # ~30% of screen width
CHAT_H_RATIO    = 0.175    # ~28% of screen height

# OCR tuning
OCR_PSM = 7  # single text line
THRESHOLD = 165  # binary threshold for chat text

# De-dupe behavior: ignore identical normalized lines seen recently
SEEN_TTL_SEC = 8.0

# ============================================================
# JAVA-PARITY REGEX (ported)
# ============================================================

KILL_PATTERN = re.compile(
    r"You have killed ([\d,]+) (.+?)(?: \((hard mode|hm)\)| in (normal mode|hard mode))?\.",
    re.I
)

MILESTONE_PATTERN = re.compile(
    r"Milestone: You have killed ([\d,]+) (.+?)!",
    re.I
)

RECEIVE_PATTERN = re.compile(
    r"You receive: \d+\s*x\s*(.+?)\.",
    re.I
)

NEWS_DROP_PATTERN = re.compile(
    r"News: (.+?) has received (?:a |an )?(.+?) drop!(?: at ([\d,]+) kills!)?",
    re.I
)

SESSION_WELCOME_PATTERN = re.compile(
    r"Welcome to your session again: (.+?)\.",
    re.I
)

# ============================================================
# PET ITEM NAMES (same set as Java, normalized)
# ============================================================

_PET_ITEMS_RAW = [
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
]

def normalize_item(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]", " ", s.lower())).strip()

def normalize_boss(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z]", " ", s.lower())).strip()

PET_ITEM_NAMES: Set[str] = {normalize_item(x) for x in _PET_ITEMS_RAW}

# ============================================================
# DATA STRUCTS
# ============================================================

@dataclass
class PendingDrop:
    item: str
    timestamp_ms: int

pending_drops: deque[PendingDrop] = deque()

boss_uniques: Dict[str, Set[str]] = defaultdict(set)

# Session state (Java parity)
lastBossName: Optional[str] = None
lastBossMode: Optional[str] = None  # "HM" or None
lastKillCount: int = 0
sessionStartKC: Optional[int] = None
lastLoggedDropKey: Optional[str] = None
sessionPending: bool = False  # drop happened before KC message (backdate sessionStartKC)

localUsername: Optional[str] = None  # normalized lower-case name

# ============================================================
# DEBUG
# ============================================================

def debug(fmt: str, *args):
    if not DEBUG:
        return
    msg = fmt % args if args else fmt
    print(f"[KT-OCR] {msg}")

# ============================================================
# FILE / MAP LOADERS (Java parity)
# ============================================================

def ensure_dirs():
    os.makedirs(SCRIPT_DIR, exist_ok=True)
    os.makedirs(BOSSES_DIR, exist_ok=True)

def load_local_username():
    global localUsername
    if os.path.exists(LOCAL_USERNAME_FILE):
        try:
            raw = open(LOCAL_USERNAME_FILE, "r", encoding="utf-8").read().strip()
            if raw:
                localUsername = raw.lower().strip()
                debug("Local username loaded: %s", localUsername)
        except Exception as e:
            debug("Failed reading local_username.txt: %s", str(e))

def load_boss_uniques():
    boss_uniques.clear()
    if not os.path.exists(UNIQUE_MAP_FILE):
        debug("Unique map file missing: %s", UNIQUE_MAP_FILE)
        return

    boss_key = None
    try:
        for line in open(UNIQUE_MAP_FILE, "r", encoding="utf-8").read().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.endswith(":"):
                boss_key = normalize_boss(line[:-1])
                boss_uniques[boss_key]  # ensure exists
                debug("Loaded boss section | Boss=%s", boss_key)
            else:
                if boss_key is None:
                    continue
                item = normalize_item(line)
                boss_uniques[boss_key].add(item)
                # debug("Added unique | Boss=%s Item=%s", boss_key, item)
    except Exception as e:
        debug("ERROR loading unique map: %s", str(e))

def get_uniques_file(boss_name: str) -> str:
    # Your requirement: files prefilled inside "bosses" folder
    fname = normalize_boss(boss_name).replace(" ", "_") + "_uniques.txt"
    return os.path.join(BOSSES_DIR, fname)

def read_unique_entries() -> List[Tuple[int, str]]:
    if not lastBossName:
        return []
    path = get_uniques_file(lastBossName)
    if not os.path.exists(path):
        return []
    out: List[Tuple[int, str]] = []
    try:
        for l in open(path, "r", encoding="utf-8").read().splitlines():
            if "|" in l:
                a, b = l.split("|", 1)
                a = a.strip().replace(",", "")
                b = b.strip()
                if a.isdigit():
                    out.append((int(a), b))
    except Exception:
        pass
    return out

def distinct_uniques_count() -> int:
    return len({item for _, item in read_unique_entries()})

def total_unique_drops() -> int:
    return len(read_unique_entries())

def kills_since_last_unique() -> int:
    e = read_unique_entries()
    if not e:
        return 0
    last_kc = e[-1][0]
    return max(0, lastKillCount - last_kc)

def total_uniques_for_boss() -> int:
    if not lastBossName:
        return 0
    return len(boss_uniques.get(normalize_boss(lastBossName), set()))

def has_pet(boss_name: str) -> bool:
    if not os.path.exists(PET_MAP_FILE):
        return False
    key = normalize_boss(boss_name)
    try:
        for line in open(PET_MAP_FILE, "r", encoding="utf-8").read().splitlines():
            if not line or line.strip().startswith("#"):
                continue
            parts = line.split(":", 1)
            if len(parts) != 2:
                continue
            if normalize_boss(parts[0]) == key:
                return parts[1].strip().lower() == "yes"
    except Exception:
        pass
    return False

def mark_pet_obtained(boss_name: str):
    # Java behavior: load all, update, rewrite file with header
    key = normalize_boss(boss_name)
    pets: Dict[str, bool] = {}

    if os.path.exists(PET_MAP_FILE):
        try:
            for line in open(PET_MAP_FILE, "r", encoding="utf-8").read().splitlines():
                if not line or line.strip().startswith("#"):
                    continue
                parts = line.split(":", 1)
                if len(parts) == 2:
                    pets[normalize_boss(parts[0])] = (parts[1].strip().lower() == "yes")
        except Exception:
            pass

    if pets.get(key, False):
        debug("Pet already marked for boss: %s", key)
        return

    pets[key] = True
    debug("Pet marked obtained | Boss=%s", key)

    try:
        with open(PET_MAP_FILE, "w", encoding="utf-8") as w:
            w.write("# boss pets (yes/no)\n\n")
            for b in sorted(pets.keys()):
                w.write(f"{b}: {'yes' if pets[b] else 'no'}\n")
    except Exception:
        pass

def get_session_kc() -> int:
    if sessionStartKC is None:
        return 0
    return max(0, lastKillCount - sessionStartKC)

def write_global_ui():
    # Java formatting parity
    if not lastBossName:
        return

    sep = "────────────"
    boss_line = lastBossName + (f" ({lastBossMode})" if lastBossMode else "")

    try:
        with open(GLOBAL_UI_FILE, "w", encoding="utf-8") as w:
            w.write(boss_line + "\n")
            w.write(sep + "\n")
            w.write("KC: " + f"{lastKillCount:,d}" + "\n")
            w.write("Session KC: +" + str(get_session_kc()) + "\n")
            w.write("Pet Obtained: " + ("YES" if has_pet(lastBossName) else "NO") + "\n")
            w.write("Collection: " + f"{distinct_uniques_count()}/{total_uniques_for_boss()}" + "\n")
            w.write("Unique Drops: " + str(total_unique_drops()) + "\n")
            w.write("Since Last Unique: " + str(kills_since_last_unique()) + "\n")
            w.write(sep)
    except Exception:
        pass

def record_unique_if_applicable(item: str, kc: int):
    if not lastBossName:
        return

    boss_key = normalize_boss(lastBossName)
    allowed = boss_uniques.get(boss_key)

    if not allowed:
        debug("No unique table for boss: %s", boss_key)
        return

    if item not in allowed:
        debug("Item is NOT a unique for this boss | Boss=%s Item=%s", boss_key, item)
        return

    path = get_uniques_file(lastBossName)
    entry = f"{kc}|{item}"

    try:
        # Ensure bosses dir exists
        os.makedirs(os.path.dirname(path), exist_ok=True)

        # Prevent duplicates (case-insensitive)
        if os.path.exists(path):
            for line in open(path, "r", encoding="utf-8").read().splitlines():
                if line.strip().lower() == entry.lower():
                    debug("Unique already logged | Entry=%s", entry)
                    return

        with open(path, "a", encoding="utf-8") as w:
            w.write(entry + "\n")

        debug("Unique written | Entry=%s File=%s", entry, path)
    except Exception as e:
        debug("ERROR writing unique: %s", str(e))

# ============================================================
# CORE LOGIC (Java parity)
# ============================================================

def handle_drop(item: str, kc: int):
    global lastLoggedDropKey

    debug('Drop detected | Item="%s" KC=%d Boss="%s"', item, kc, lastBossName)

    key = f"{kc}|{item}"
    if key == lastLoggedDropKey:
        debug("Duplicate drop ignored | Key=%s", key)
        return

    lastLoggedDropKey = key
    debug("Drop accepted | Key=%s", key)

    if item in PET_ITEM_NAMES:
        debug('Pet item detected | Item="%s"', item)
        if lastBossName:
            mark_pet_obtained(lastBossName)
    else:
        debug('Not a pet item | Item="%s"', item)

    record_unique_if_applicable(item, kc)
    write_global_ui()

def handle_kc_update(kc_text: str, boss_name: str, hm: bool):
    global lastKillCount, lastBossName, lastBossMode, sessionStartKC, sessionPending

    kc = int(kc_text.replace(",", ""))
    debug('KC update | Boss="%s" KC=%d HM=%s', boss_name, kc, str(hm))

    newBossSession = (lastBossName is None) or (normalize_boss(lastBossName) != normalize_boss(boss_name))

    if newBossSession:
        if sessionPending:
            sessionStartKC = kc - 1
            debug("Session resolved from pending drop | SessionStartKC=%d", sessionStartKC)
        else:
            sessionStartKC = kc
            debug("New boss session started | SessionStartKC=%d", kc)

    sessionPending = False

    lastKillCount = kc
    lastBossName = boss_name
    lastBossMode = "HM" if hm else None

    # Attach pending receives within window
    now_ms = int(time.time() * 1000)
    while pending_drops:
        pd = pending_drops[0]
        if now_ms - pd.timestamp_ms > RECEIVE_WINDOW_MS:
            debug('Pending receive expired | Item="%s"', pd.item)
            pending_drops.popleft()
            continue

        debug('Pending receive attached to KC | Item="%s" KC=%d', pd.item, lastKillCount)
        handle_drop(pd.item, lastKillCount)
        pending_drops.popleft()

    write_global_ui()

# ============================================================
# OCR / CAPTURE
# ============================================================

def strip_tags(s: str) -> str:
    # Java stripTags removes <...>
    return re.sub(r"<[^>]+>", "", s)

def choose_primary_4k_monitor(sct: mss) -> int:
    """
    MSS monitors:
      monitors[0] = virtual screen
      monitors[1..] = physical monitors (order can vary)
    We'll pick the monitor that looks like 4K (>= 3840x2160), otherwise the largest by area.
    """
    best_idx = 1
    best_area = -1
    best_is_4k = False

    for i in range(1, len(sct.monitors)):
        m = sct.monitors[i]
        w, h = m["width"], m["height"]
        area = w * h
        is_4k = (w >= 3840 and h >= 2160)

        if is_4k and not best_is_4k:
            best_is_4k = True
            best_idx = i
            best_area = area
        elif is_4k and best_is_4k and area > best_area:
            best_idx = i
            best_area = area
        elif not best_is_4k and area > best_area:
            best_idx = i
            best_area = area

    debug("Selected monitor index=%d (%dx%d)", best_idx, sct.monitors[best_idx]["width"], sct.monitors[best_idx]["height"])
    return best_idx

def compute_chat_region(mon: dict) -> dict:
    left = mon["left"] + int(mon["width"] * CHAT_LEFT_RATIO)
    top  = mon["top"]  + int(mon["height"] * CHAT_TOP_RATIO)
    width  = int(mon["width"] * CHAT_W_RATIO)
    height = int(mon["height"] * CHAT_H_RATIO)
    return {"left": left, "top": top, "width": width, "height": height}

def preprocess_for_ocr(rgb: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    # Light blur to smooth UI text
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    # Adaptive threshold tuned for dark RS3 chat background; invert so text = white
    thr = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        9
    )

    return thr


def ocr_image(img: np.ndarray) -> str:
    cfg = f"--psm {OCR_PSM} -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:,.+-'()"
    return pytesseract.image_to_string(img, config=cfg)


def segment_lines(binary_img: np.ndarray) -> List[np.ndarray]:
    """Split a binary chat image into individual line images."""
    # Treat any white pixel as text signal (because preprocess produced white text on black)
    text_presence = (binary_img > 0).sum(axis=1)
    if not text_presence.any():
        return []

    threshold = binary_img.shape[1] * 0.01  # at least 1% of row has text
    lines: List[np.ndarray] = []

    in_line = False
    start = 0
    for idx, val in enumerate(text_presence):
        has_text = val > threshold
        if has_text and not in_line:
            start = idx
            in_line = True
        elif not has_text and in_line:
            end = idx
            in_line = False
            if end - start >= 8:  # ignore tiny noise bands
                pad_top = max(0, start - 2)
                pad_bot = min(binary_img.shape[0], end + 2)
                lines.append(binary_img[pad_top:pad_bot, :])

    if in_line:
        end = binary_img.shape[0]
        if end - start >= 8:
            pad_top = max(0, start - 2)
            lines.append(binary_img[pad_top:end, :])

    return lines


# ============================================================
# CHAT LINE INGESTION
# ============================================================

def process_chat_message(msg_raw: str):
    """
    Mirrors Java onChatMessage ordering:
      session welcome
      kill
      milestone
      receive (buffer)
      news (local player only)
    """
    global lastBossName, lastBossMode, sessionStartKC, sessionPending, lastKillCount

    if not msg_raw:
        return

    msg_raw = strip_tags(msg_raw)
    msg = msg_raw.strip()
    if not msg:
        return

    debug('Chat message received: "%s"', msg)

    # SESSION WELCOME
    m = SESSION_WELCOME_PATTERN.search(msg)
    if m:
        boss = m.group(1)
        debug('Session welcome detected | Boss="%s"', boss)
        lastBossName = boss
        lastBossMode = None
        sessionStartKC = lastKillCount
        sessionPending = False
        write_global_ui()
        return

    # KILL / KC
    m = KILL_PATTERN.search(msg)
    if m:
        debug("Kill message matched")
        kc_text = m.group(1)
        boss_name = m.group(2)
        hm = (m.group(3) is not None) or (m.group(4) is not None and "hard" in m.group(4).lower())
        handle_kc_update(kc_text, boss_name, hm)
        return

    # MILESTONE
    m = MILESTONE_PATTERN.search(msg)
    if m:
        debug("Milestone message matched")
        kc = int(m.group(1).replace(",", ""))
        boss = m.group(2)
        lastKillCount = kc
        if lastBossName is None:
            lastBossName = boss
        write_global_ui()
        return

    # RECEIVE
    m = RECEIVE_PATTERN.search(msg)
    if m:
        item = normalize_item(m.group(1))
        pending_drops.append(PendingDrop(item=item, timestamp_ms=int(time.time() * 1000)))

        if lastBossName is None:
            debug("Receive before KC — marking pending session")
            sessionPending = True

        debug('Receive buffered | Item="%s" Pending=%d', item, len(pending_drops))
        return

    # NEWS DROP
    m = NEWS_DROP_PATTERN.search(msg)
    if m:
        debug("News message matched")

        if localUsername is None:
            debug("No local username configured -> ignoring news drops")
            return

        user = m.group(1).lower().strip()
        if user != localUsername:
            debug("News drop ignored — not local player (%s)", user)
            return

        item = normalize_item(m.group(2))

        if lastBossName is None:
            debug("News drop before KC — marking pending session")
            sessionPending = True

        kc = int(m.group(3).replace(",", "")) if m.group(3) else lastKillCount
        handle_drop(item, kc)
        return

def normalize_line_for_dedupe(line: str) -> str:
    # Keep it close to raw to avoid merging distinct lines; just strip + collapse spaces
    line = strip_tags(line)
    line = line.strip()
    line = re.sub(r"\s+", " ", line)
    return line

# ============================================================
# MAIN LOOP
# ============================================================

def main():
    global TESSERACT_EXE

    ensure_dirs()
    load_boss_uniques()
    load_local_username()

    if TESSERACT_EXE:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_EXE

    sct = mss()
    mon_idx = choose_primary_4k_monitor(sct)
    mon = sct.monitors[mon_idx]
    region = compute_chat_region(mon)

    debug("Capture region: left=%d top=%d w=%d h=%d", region["left"], region["top"], region["width"], region["height"])
    debug("Running OCR loop... (CTRL+C to stop)")

    # seen map: normalized_line -> last_seen_time
    seen: Dict[str, float] = {}

    while True:
        start = time.time()

        grabbed = sct.grab(region)
        img = np.array(Image.frombytes("RGB", grabbed.size, grabbed.rgb))  # RGB
        pre = preprocess_for_ocr(img)

        # Keep the debug output in the Tesseract-friendly black-on-white style
        pre_for_ocr = cv2.bitwise_not(pre)
        cv2.imwrite("DEBUG_preprocessed.png", pre_for_ocr)

        # Split into individual text lines using projection instead of fixed slices
        lines = []
        for line_img in segment_lines(pre):
            text = ocr_image(cv2.bitwise_not(line_img)).strip()
            if len(text) >= 4:
                lines.append(text)

        # Clean out old seen entries
        now = time.time()
        if seen:
            cutoff = now - SEEN_TTL_SEC
            for k in list(seen.keys()):
                if seen[k] < cutoff:
                    del seen[k]

        # Process in natural top-to-bottom order.
        for raw in lines:
            norm = normalize_line_for_dedupe(raw)
            if not norm:
                continue

            # Dedupe
            if norm in seen:
                continue
            seen[norm] = now

            process_chat_message(norm)

        # Sleep remaining interval
        elapsed = time.time() - start
        if elapsed < POLL_SEC:
            time.sleep(POLL_SEC - elapsed)

if __name__ == "__main__":
    main()
