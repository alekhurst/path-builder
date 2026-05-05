import { useState, useRef, useEffect, useCallback } from "react";

const DEFAULT_CENTER = { lat: 39.5, lng: -98.35 };
const DEFAULT_ZOOM = 4;
const EXPECTED_COLUMNS = "latitude,longitude,timestamp,type,title";

function getDefaultTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

function tzOffsetStr(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(date);
    const name = parts.find((p) => p.type === "timeZoneName")?.value || "GMT";
    const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return "+00:00";
    return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] || "00").padStart(2, "0")}`;
  } catch { return "+00:00"; }
}

function parseOffsetMin(s) {
  const m = s.match(/([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === "+" ? 1 : -1) * (parseInt(m[2]) * 60 + parseInt(m[3]));
}

function formatDateTime(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  let hour = get("hour"); if (hour === "24") hour = "00";
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}${tzOffsetStr(date, tz)}`;
}

function displayDateTime(ts, tz) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return d.toLocaleString(undefined, {
    timeZone: tz,
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

function toLocalInput(tsOrDate, tz) {
  if (!tsOrDate) return "";
  const d = tsOrDate instanceof Date ? tsOrDate : new Date(tsOrDate);
  if (isNaN(d)) return "";
  return formatDateTime(d, tz).slice(0, 19);
}

function fromLocalInput(val, tz) {
  if (!val) return "";
  // Interpret val (YYYY-MM-DDTHH:MM[:SS]) as wall-clock in tz; return ISO for the true UTC instant.
  const approxUtc = new Date(val + "Z");
  if (isNaN(approxUtc)) return "";
  const offMin1 = parseOffsetMin(tzOffsetStr(approxUtc, tz));
  const firstPass = approxUtc.getTime() - offMin1 * 60000;
  const offMin2 = parseOffsetMin(tzOffsetStr(new Date(firstPass), tz));
  const finalUtc = offMin1 === offMin2 ? firstPass : approxUtc.getTime() - offMin2 * 60000;
  return formatDateTime(new Date(finalUtc), tz);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { dist: Math.hypot(px - ax, py - ay), t: 0 };
  const tRaw = ((px - ax) * dx + (py - ay) * dy) / len2;
  const t = Math.max(0, Math.min(1, tRaw));
  return { dist: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t: tRaw };
}

function autoDistribute(points, tz) {
  const result = points.map((p) => ({ ...p }));
  const eventIndices = [];
  result.forEach((p, i) => { if (p.isEvent) eventIndices.push(i); });

  if (eventIndices.length === 0) return result;

  const firstEvent = eventIndices[0];
  if (firstEvent > 0) {
    const anchor = new Date(result[firstEvent].timestamp).getTime();
    for (let i = firstEvent - 1; i >= 0; i--) {
      result[i].timestamp = formatDateTime(new Date(anchor - (firstEvent - i) * 10000), tz);
    }
  }

  for (let w = 0; w < eventIndices.length - 1; w++) {
    const si = eventIndices[w], ei = eventIndices[w + 1];
    const st = new Date(result[si].timestamp).getTime();
    const et = new Date(result[ei].timestamp).getTime();
    const gaps = ei - si;
    for (let i = si + 1; i < ei; i++) {
      result[i].timestamp = formatDateTime(new Date(st + ((i - si) / gaps) * (et - st)), tz);
    }
  }

  const lastEvent = eventIndices[eventIndices.length - 1];
  if (lastEvent < result.length - 1) {
    const anchor = new Date(result[lastEvent].timestamp).getTime();
    for (let i = lastEvent + 1; i < result.length; i++) {
      result[i].timestamp = formatDateTime(new Date(anchor + (i - lastEvent) * 10000), tz);
    }
  }

  return result;
}

function parseCSV(text) {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("File is empty or has no data rows.");

  const header = lines[0];
  if (header !== EXPECTED_COLUMNS) {
    throw new Error(`This file doesn't match the Path Builder format.\n\nExpected:\n${EXPECTED_COLUMNS}\n\nGot:\n${header}`);
  }

  const points = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = lines[r].split(",");
    if (cols.length < 5) throw new Error(`Row ${r + 1}: expected 5 columns, got ${cols.length}.`);

    const lat = parseFloat(cols[0]);
    const lng = parseFloat(cols[1]);
    if (isNaN(lat) || isNaN(lng)) throw new Error(`Row ${r + 1}: invalid latitude/longitude.`);
    if (lat < -90 || lat > 90) throw new Error(`Row ${r + 1}: latitude out of range (-90 to 90).`);
    if (lng < -180 || lng > 180) throw new Error(`Row ${r + 1}: longitude out of range (-180 to 180).`);

    // Rejoin remaining columns for timestamp (which contains colons but no commas)
    // Format: latitude,longitude,TIMESTAMP,type,title
    // But title could contain commas, so we parse carefully:
    // cols[0]=lat, cols[1]=lng, cols[2]=timestamp, cols[3]=type, cols[4+]=title
    const timestamp = cols[2];
    const type = cols[3];
    const title = cols.slice(4).join(",");

    const tsDate = new Date(timestamp);
    if (isNaN(tsDate.getTime())) throw new Error(`Row ${r + 1}: invalid timestamp "${timestamp}".`);

    if (type !== "event" && type !== "path_point") {
      throw new Error(`Row ${r + 1}: type must be "event" or "path_point", got "${type}".`);
    }

    points.push({
      lat: lat.toFixed(6),
      lng: lng.toFixed(6),
      timestamp,
      isEvent: type === "event",
      title: type === "event" ? (title || "") : "",
    });
  }

  if (points.length === 0) throw new Error("No valid data rows found.");
  return points;
}

export default function MapPointPicker() {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]);
  const polylineRef = useRef([]);
  const modeRef = useRef("event");
  const fileInputRef = useRef(null);
  const cursorIdxRef = useRef(null);
  const cursorDirRef = useRef("fwd"); // "fwd" or "bwd"
  const pointsRef = useRef([]);
  const scrolledToIdxRef = useRef(null);
  const historyRef = useRef({ stack: [{ points: [], cursorIdx: null, cursorDir: "fwd", hiddenEvents: new Set() }], index: 0 });
  const MAX_HISTORY = 50;

  const [points, setPoints] = useState([]);
  const [mode, setMode] = useState("event");
  const [editingIdx, setEditingIdx] = useState(null);
  const [editTimestamp, setEditTimestamp] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editLat, setEditLat] = useState("");
  const [editLng, setEditLng] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [importError, setImportError] = useState(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState(null);
  const [cursorIdx, setCursorIdx] = useState(null);
  const [collapsedEvents, setCollapsedEvents] = useState(() => new Set());
  const [hiddenEvents, setHiddenEvents] = useState(() => new Set());
  const hiddenEventsRef = useRef(new Set());
  useEffect(() => { hiddenEventsRef.current = hiddenEvents; }, [hiddenEvents]);

  const parentEventOf = (pts, i) => {
    for (let k = i - 1; k >= 0; k--) if (pts[k].isEvent) return k;
    return -1;
  };
  const isPointVisible = (i, pts = points, hidden = hiddenEvents) => {
    if (i < 0 || i >= pts.length) return false;
    if (pts[i].isEvent) return !hidden.has(i);
    const parent = parentEventOf(pts, i);
    if (parent < 0) return true;
    return !hidden.has(parent);
  };

  const shiftCollapsedOnInsert = (insertIdx) => {
    setCollapsedEvents((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set();
      prev.forEach((idx) => next.add(idx >= insertIdx ? idx + 1 : idx));
      return next;
    });
  };
  const shiftCollapsedOnDelete = (deleteIdx) => {
    setCollapsedEvents((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set();
      prev.forEach((idx) => {
        if (idx === deleteIdx) return;
        next.add(idx > deleteIdx ? idx - 1 : idx);
      });
      return next;
    });
  };
  const toggleEventCollapsed = (eventIdx) => {
    setCollapsedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventIdx)) next.delete(eventIdx);
      else next.add(eventIdx);
      return next;
    });
  };
  const commitHidden = (next) => {
    hiddenEventsRef.current = next;
    setHiddenEvents(next);
  };
  const shiftHiddenOnInsert = (insertIdx) => {
    const prev = hiddenEventsRef.current;
    if (prev.size === 0) return;
    const next = new Set();
    prev.forEach((idx) => next.add(idx >= insertIdx ? idx + 1 : idx));
    commitHidden(next);
  };
  const unhideEvent = (eventIdx) => {
    const prev = hiddenEventsRef.current;
    if (!prev.has(eventIdx)) return;
    const next = new Set(prev);
    next.delete(eventIdx);
    commitHidden(next);
  };
  const toggleEventHidden = (eventIdx) => {
    const prev = hiddenEventsRef.current;
    const willHide = !prev.has(eventIdx);
    if (willHide) {
      // If cursor is on the event itself or any of its children, reset it.
      const cursor = cursorIdxRef.current;
      const arr = pointsRef.current;
      if (cursor !== null && arr[cursor]) {
        const onEvent = cursor === eventIdx;
        const onChild = !arr[cursor].isEvent && parentEventOf(arr, cursor) === eventIdx;
        if (onEvent || onChild) {
          cursorIdxRef.current = null;
          setCursorIdx(null);
          cursorDirRef.current = "fwd";
        }
      }
    }
    const next = new Set(prev);
    if (next.has(eventIdx)) next.delete(eventIdx);
    else next.add(eventIdx);
    commitHidden(next);
    pushHistory(pointsRef.current);
  };
  const [displayTz, setDisplayTz] = useState(getDefaultTz());
  const displayTzRef = useRef(displayTz);
  useEffect(() => { displayTzRef.current = displayTz; }, [displayTz]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchPins, setSearchPins] = useState([]);
  const searchMarkersRef = useRef([]);
  const searchPinIdRef = useRef(0);
  const searchAbortRef = useRef(null);
  const searchContainerRef = useRef(null);
  const modeBtnsRef = useRef(null);
  const [modeBtnsWidth, setModeBtnsWidth] = useState(null);
  useEffect(() => {
    const el = modeBtnsRef.current;
    if (!el) return;
    setModeBtnsWidth(el.offsetWidth);
    const ro = new ResizeObserver(() => setModeBtnsWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const syncUndoRedo = () => {
    const h = historyRef.current;
    setCanUndo(h.index > 0);
    setCanRedo(h.index < h.stack.length - 1);
  };

  const pushHistory = (newPoints, hiddenOverride) => {
    const h = historyRef.current;
    // Truncate any redo future
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push({
      points: newPoints.map((p) => ({ ...p })),
      cursorIdx: cursorIdxRef.current,
      cursorDir: cursorDirRef.current,
      hiddenEvents: new Set(hiddenOverride ?? hiddenEventsRef.current),
    });
    // Enforce max size
    if (h.stack.length > MAX_HISTORY) {
      h.stack.shift();
    } else {
      h.index++;
    }
    syncUndoRedo();
  };

  const resetHistory = (newPoints) => {
    historyRef.current = {
      stack: [{ points: newPoints.map((p) => ({ ...p })), cursorIdx: null, cursorDir: "fwd", hiddenEvents: new Set() }],
      index: 0,
    };
    cursorIdxRef.current = null;
    setCursorIdx(null);
    cursorDirRef.current = "fwd";
    syncUndoRedo();
  };

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index--;
    const snap = h.stack[h.index];
    pointsRef.current = snap.points.map((p) => ({ ...p }));
    cursorIdxRef.current = snap.cursorIdx;
    setCursorIdx(snap.cursorIdx);
    cursorDirRef.current = snap.cursorDir;
    setPoints(pointsRef.current);
    setEditingIdx(null);
    setSelectedIdx(null);
    commitHidden(new Set(snap.hiddenEvents ?? []));
    syncUndoRedo();
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index++;
    const snap = h.stack[h.index];
    pointsRef.current = snap.points.map((p) => ({ ...p }));
    cursorIdxRef.current = snap.cursorIdx;
    setCursorIdx(snap.cursorIdx);
    cursorDirRef.current = snap.cursorDir;
    setPoints(pointsRef.current);
    setEditingIdx(null);
    setSelectedIdx(null);
    commitHidden(new Set(snap.hiddenEvents ?? []));
    syncUndoRedo();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'z') {
        e.preventDefault();
        redo();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // Update points + push to undo history
  const updatePoints = (newPoints, { undoable = true } = {}) => {
    pointsRef.current = newPoints;
    setPoints(newPoints);
    if (undoable) pushHistory(newPoints);
  };

  // Insert a point at a given index
  const insertPoint = useCallback((lat, lng, insertIdx, isBisect) => {
    const isEvent = modeRef.current === "event";
    const prev = pointsRef.current;

    const newPoint = {
      lat: lat.toFixed(6), lng: lng.toFixed(6),
      timestamp: "", isEvent, title: "",
    };

    if (isEvent) {
      const before = [...prev.slice(0, insertIdx)].reverse().find((p) => p.isEvent);
      const after = prev.slice(insertIdx).find((p) => p.isEvent);

      const tz = displayTzRef.current;
      if (before && after && before.timestamp && after.timestamp) {
        const mid = (new Date(before.timestamp).getTime() + new Date(after.timestamp).getTime()) / 2;
        newPoint.timestamp = formatDateTime(new Date(mid), tz);
      } else if (before && before.timestamp) {
        newPoint.timestamp = formatDateTime(new Date(new Date(before.timestamp).getTime() + 10 * 60000), tz);
      } else if (after && after.timestamp) {
        newPoint.timestamp = formatDateTime(new Date(new Date(after.timestamp).getTime() - 10 * 60000), tz);
      } else {
        newPoint.timestamp = formatDateTime(new Date(2038, 0, 19, 18, 0, 0), tz);
      }
    }

    if (isBisect) {
      cursorDirRef.current = "none";
    }
    cursorIdxRef.current = insertIdx;
    setCursorIdx(insertIdx);

    if (!isEvent) {
      const parent = parentEventOf(prev, insertIdx);
      if (parent >= 0) unhideEvent(parent);
    }

    const newPoints = [...prev];
    newPoints.splice(insertIdx, 0, newPoint);
    shiftCollapsedOnInsert(insertIdx);
    shiftHiddenOnInsert(insertIdx);
    updatePoints(autoDistribute(newPoints, displayTzRef.current));
  }, []);

  // Load Leaflet
  useEffect(() => {
    const linkEl = document.createElement("link");
    linkEl.rel = "stylesheet";
    linkEl.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(linkEl);

    const scriptEl = document.createElement("script");
    scriptEl.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    scriptEl.onload = () => setLoaded(true);
    document.head.appendChild(scriptEl);

    return () => {
      document.head.removeChild(linkEl);
      document.head.removeChild(scriptEl);
    };
  }, []);

  // Inject hover CSS for map delete buttons
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      .pb-marker-wrap .pb-marker-del { display:none; }
      .pb-marker-wrap:hover .pb-marker-del { display:flex; }
      .pb-marker-wrap { transition: transform 0.15s ease, filter 0.15s ease; }
      .pb-marker-highlight .pb-marker-wrap { transform: scale(1.4); }
      .pb-marker-selected .pb-marker-wrap { transform: scale(1.6); }
      .pb-marker-selected.pb-marker-highlight .pb-marker-wrap { transform: scale(1.6); filter: brightness(1.2); }
      .pb-marker-cursor .pb-marker-wrap > div:first-child { background: #eab308 !important; color: #000 !important; }
      @keyframes pb-path-flow { to { stroke-dashoffset: -14; } }
      .pb-path-flow { animation: pb-path-flow 0.8s linear infinite; }
      .pb-search-input::placeholder { color: #334155; opacity: 1; }
      .pb-search-input::-webkit-input-placeholder { color: #334155; }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  // Init map
  useEffect(() => {
    if (!loaded || mapInstanceRef.current) return;
    const L = window.L;
    const map = L.map(mapRef.current, {
      center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
      zoom: DEFAULT_ZOOM,
      zoomControl: false,
      maxZoom: 26,
    });
    const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxNativeZoom: 19,
      maxZoom: 26,
    });
    const satellite = L.tileLayer("https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
      attribution: "© Google",
      subdomains: ["0", "1", "2", "3"],
      maxNativeZoom: 20,
      maxZoom: 26,
    });
    satellite.addTo(map);
    L.control.layers({ "Satellite": satellite, "Streets": streets }, null, { position: "topright" }).addTo(map);
    L.control.zoom({ position: "topright" }).addTo(map);

    // Map click: continuation logic (append/prepend/continue interior)
    map.on("click", (e) => {
      const { lat, lng } = e.latlng;
      const prev = pointsRef.current;
      const cursor = cursorIdxRef.current;
      const hidden = hiddenEventsRef.current;
      const BIAS = 5;

      setSelectedIdx(null);
      setEditingIdx(null);

      if (prev.length < 2) {
        insertPoint(lat, lng, prev.length, false);
        return;
      }

      // Work in visible-only space: nearest segment/point must reference visible markers.
      const visibleIdxs = [];
      for (let i = 0; i < prev.length; i++) {
        if (isPointVisible(i, prev, hidden)) visibleIdxs.push(i);
      }
      if (visibleIdxs.length === 0) {
        insertPoint(lat, lng, prev.length, false);
        return;
      }
      if (visibleIdxs.length < 2) {
        insertPoint(lat, lng, visibleIdxs[0] + 1, false);
        return;
      }

      const firstV = visibleIdxs[0];
      const lastV = visibleIdxs[visibleIdxs.length - 1];

      // Nearest visible segment — only count segments between underlying-adjacent
      // visible points (skipped spans aren't drawn, so they aren't clickable).
      let minSegDist = Infinity, bisectVk = -1;
      for (let k = 0; k < visibleIdxs.length - 1; k++) {
        const ia = visibleIdxs[k], ib = visibleIdxs[k + 1];
        if (ib - ia > 1) continue;
        const { dist } = distToSegment(lat, lng,
          parseFloat(prev[ia].lat), parseFloat(prev[ia].lng),
          parseFloat(prev[ib].lat), parseFloat(prev[ib].lng));
        if (dist < minSegDist) { minSegDist = dist; bisectVk = k + 1; }
      }
      const hasBisectCandidate = bisectVk >= 0;
      const bisectAUnder = hasBisectCandidate ? visibleIdxs[bisectVk - 1] : -1;
      const bisectBUnder = hasBisectCandidate ? visibleIdxs[bisectVk] : -1;

      // Pixel distance from click to nearest visible segment
      const clickPt = map.latLngToContainerPoint(e.latlng);
      const segPixelDist = hasBisectCandidate ? (() => {
        const a = map.latLngToContainerPoint([parseFloat(prev[bisectAUnder].lat), parseFloat(prev[bisectAUnder].lng)]);
        const b = map.latLngToContainerPoint([parseFloat(prev[bisectBUnder].lat), parseFloat(prev[bisectBUnder].lng)]);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(clickPt.x - a.x, clickPt.y - a.y);
        const t = Math.max(0, Math.min(1, ((clickPt.x - a.x) * dx + (clickPt.y - a.y) * dy) / len2));
        return Math.hypot(clickPt.x - (a.x + t * dx), clickPt.y - (a.y + t * dy));
      })() : Infinity;

      const HIT_ZONE_PX = 30;
      const onSegment = hasBisectCandidate && segPixelDist <= HIT_ZONE_PX;

      const distToFirst = Math.hypot(lat - parseFloat(prev[firstV].lat), lng - parseFloat(prev[firstV].lng));
      const distToLast = Math.hypot(lat - parseFloat(prev[lastV].lat), lng - parseFloat(prev[lastV].lng));
      console.log(`[CLICK] vSeg=${bisectVk} (${bisectAUnder}→${bisectBUnder}) segPx=${segPixelDist.toFixed(1)} onSeg=${onSegment} | ${visibleIdxs.length}/${prev.length} visible`);

      let insertIdx;

      if (onSegment) {
        insertIdx = bisectBUnder;
        console.log(`[RESULT] BISECT at ${insertIdx}`);
        insertPoint(lat, lng, insertIdx, true);
        return;
      }

      // Continuation logic in visible-space
      const cursorVisible = cursor !== null && isPointVisible(cursor, prev, hidden);
      const wasAppending = cursorVisible && cursor === lastV;
      const wasPrepending = cursorVisible && cursor === firstV;
      const wasInterior = cursorVisible && !wasAppending && !wasPrepending;

      // Jump continuation: nearest visible point
      const vPointPx = visibleIdxs.map((vi) => {
        const pt = map.latLngToContainerPoint([parseFloat(prev[vi].lat), parseFloat(prev[vi].lng)]);
        return Math.hypot(clickPt.x - pt.x, clickPt.y - pt.y);
      });
      let nearestVk = 0;
      for (let k = 1; k < vPointPx.length; k++) if (vPointPx[k] < vPointPx[nearestVk]) nearestVk = k;
      const nearestUnder = visibleIdxs[nearestVk];
      const nearestPx = vPointPx[nearestVk];
      const cursorUnder = wasAppending ? lastV
        : wasPrepending ? firstV
        : wasInterior ? cursor
        : lastV;
      const cursorVk = visibleIdxs.indexOf(cursorUnder);
      const cursorPx = cursorVk >= 0 ? vPointPx[cursorVk] : Infinity;
      const JUMP_NEAR_PX = 120;
      const JUMP_RATIO = 5;
      if (nearestUnder !== cursorUnder && nearestPx < JUMP_NEAR_PX && nearestPx * JUMP_RATIO < cursorPx) {
        let jumpIdx;
        if (nearestVk === 0) {
          jumpIdx = firstV;
          cursorDirRef.current = "bwd";
        } else if (nearestVk === visibleIdxs.length - 1) {
          jumpIdx = lastV + 1;
          cursorDirRef.current = "fwd";
        } else {
          const prevV = visibleIdxs[nearestVk - 1];
          const nextV = visibleIdxs[nearestVk + 1];
          const prevSegDist = distToSegment(lat, lng,
            parseFloat(prev[prevV].lat), parseFloat(prev[prevV].lng),
            parseFloat(prev[nearestUnder].lat), parseFloat(prev[nearestUnder].lng)).dist;
          const nextSegDist = distToSegment(lat, lng,
            parseFloat(prev[nearestUnder].lat), parseFloat(prev[nearestUnder].lng),
            parseFloat(prev[nextV].lat), parseFloat(prev[nextV].lng)).dist;
          if (nextSegDist <= prevSegDist) {
            jumpIdx = nearestUnder + 1;
            cursorDirRef.current = "fwd";
          } else {
            jumpIdx = nearestUnder;
            cursorDirRef.current = "bwd";
          }
        }
        console.log(`[RESULT] JUMP to near visible ${nearestUnder} → INSERT at ${jumpIdx}`);
        insertPoint(lat, lng, jumpIdx, false);
        return;
      }

      if (wasAppending) {
        const biasCheck = distToLast <= minSegDist * BIAS;
        if (biasCheck) {
          insertIdx = lastV + 1;
        } else {
          insertIdx = distToLast <= distToFirst ? lastV + 1 : firstV;
        }
      } else if (wasPrepending) {
        const biasCheck = distToFirst <= minSegDist * BIAS;
        if (biasCheck) {
          insertIdx = firstV;
        } else {
          insertIdx = distToFirst <= distToLast ? firstV : lastV + 1;
        }
      } else if (wasInterior) {
        const dir = cursorDirRef.current;
        if (dir === "none") {
          // Pick direction by angular alignment in screen space: which visible
          // path-neighbor of the cursor does the click point toward?
          const cursorPt = map.latLngToContainerPoint([parseFloat(prev[cursor].lat), parseFloat(prev[cursor].lng)]);
          const prevNV = visibleIdxs[cursorVk - 1];
          const nextNV = visibleIdxs[cursorVk + 1];
          const prevPt = map.latLngToContainerPoint([parseFloat(prev[prevNV].lat), parseFloat(prev[prevNV].lng)]);
          const nextPt = map.latLngToContainerPoint([parseFloat(prev[nextNV].lat), parseFloat(prev[nextNV].lng)]);
          const norm = (vx, vy) => {
            const m = Math.hypot(vx, vy);
            return m === 0 ? { x: 0, y: 0 } : { x: vx / m, y: vy / m };
          };
          const vBack = norm(prevPt.x - cursorPt.x, prevPt.y - cursorPt.y);
          const vFwd = norm(nextPt.x - cursorPt.x, nextPt.y - cursorPt.y);
          const vClick = norm(clickPt.x - cursorPt.x, clickPt.y - cursorPt.y);
          const dotFwd = vFwd.x * vClick.x + vFwd.y * vClick.y;
          const dotBack = vBack.x * vClick.x + vBack.y * vClick.y;
          cursorDirRef.current = dotFwd >= dotBack ? "fwd" : "bwd";
          const forward = cursorDirRef.current === "fwd";
          insertIdx = forward ? cursor + 1 : cursor;
          console.log(`[RESULT] SET dir=${cursorDirRef.current} (fwd=${dotFwd.toFixed(2)}, bwd=${dotBack.toFixed(2)}) → INSERT at ${insertIdx}`);
        } else {
          const forward = dir === "fwd";
          insertIdx = forward ? cursor + 1 : cursor;
          console.log(`[RESULT] CONTINUING ${dir} → INSERT at ${insertIdx}`);
        }
      } else {
        insertIdx = lastV + 1;
      }

      console.log(`[RESULT] INSERT at ${insertIdx}`);
      insertPoint(lat, lng, insertIdx, false);
    });

    mapInstanceRef.current = map;

    // Ensure Leaflet knows the container size before any vector layers are added.
    // Without this, the SVG renderer's _bounds can be undefined and _clipPoints
    // throws "Cannot read properties of undefined (reading 'x')".
    map.invalidateSize();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(mapRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [loaded]);

  // Sync markers + polyline
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L) return;
    const L = window.L;
    const map = mapInstanceRef.current;

    markersRef.current.forEach((m) => { if (m) map.removeLayer(m); });
    markersRef.current = [];
    (polylineRef.current || []).forEach((p) => map.removeLayer(p));
    polylineRef.current = [];

    let eventCount = 0;
    points.forEach((p, i) => {
      const isEvent = p.isEvent;
      if (isEvent) eventCount++;
      if (!isPointVisible(i, points, hiddenEvents)) return;
      const eventIdx = eventCount;
      const size = isEvent ? 28 : 20;
      const bg = "#3b82f6";
      const label = isEvent ? `#${eventIdx}` : "";

      const icon = L.divIcon({
        className: "",
        html: `<div class="pb-marker-wrap" style="position:relative;width:${size}px;height:${size}px;">
          <div style="
            width:${size}px;height:${size}px;border-radius:${isEvent ? '4px' : '50%'};
            background:${bg};
            border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);
display:flex;align-items:center;justify-content:center;
            color:#fff;font-size:${isEvent ? 11 : 9}px;font-weight:700;font-family:monospace;
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            line-height:1;
            position:relative;
          ">${label}</div>
          <div class="pb-marker-del" data-del-idx="${i}" style="
            position:absolute;top:-8px;right:-8px;
            width:16px;height:16px;border-radius:50%;
            background:#ef4444;border:1.5px solid #fff;
            align-items:center;justify-content:center;
            color:#fff;font-size:10px;font-weight:700;cursor:pointer;
            box-shadow:0 1px 3px rgba(0,0,0,.4);line-height:0;padding-bottom:2px;
          ">×</div>
        </div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      const marker = L.marker([parseFloat(p.lat), parseFloat(p.lng)], { icon, draggable: true }).addTo(map);
      marker.on("mouseover", () => setHoveredIdx(i));
      marker.on("mouseout", () => setHoveredIdx(null));
      marker.on("click", () => {
        setEditingIdx(null);
        setSelectedIdx((prev) => {
          if (prev === i) return null;
          if (p.isEvent) {
            setEditingIdx(i);
            setEditTimestamp(toLocalInput(p.timestamp, displayTzRef.current));
            setEditTitle(p.title || "");
            setEditLat(p.lat);
            setEditLng(p.lng);
          }
          cursorIdxRef.current = i;
          setCursorIdx(i);
          cursorDirRef.current = "none";
          return i;
        });
      });
      marker.on("dragend", (e) => {
        const { lat, lng } = e.target.getLatLng();
        const updated = pointsRef.current.map((pt, j) => (j === i ? { ...pt, lat: lat.toFixed(6), lng: lng.toFixed(6) } : pt));
        cursorIdxRef.current = i;
        setCursorIdx(i);
        cursorDirRef.current = "none";
        updatePoints(autoDistribute(updated, displayTzRef.current));
      });
      markersRef.current[i] = marker;
    });

    // Handle delete button clicks on markers via event delegation
    const container = map.getContainer();
    const delHandler = (e) => {
      const btn = e.target.closest("[data-del-idx]");
      if (btn) {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.delIdx);
        // If deleting the most-recently-inserted point, rewind continuation
        // state to the snapshot before that insertion so the next click resumes
        // from where the user left off.
        // Clear continuation state on any delete. Undo will restore the prior
        // cursorIdx/cursorDir from the previous history snapshot.
        cursorIdxRef.current = null;
        setCursorIdx(null);
        cursorDirRef.current = "fwd";
        applyDeleteSideEffects(idx);
        updatePoints(autoDistribute(pointsRef.current.filter((_, i) => i !== idx), displayTzRef.current));
      }
    };
    container.addEventListener("click", delHandler, true);

    if (map.getSize().x > 0) {
      const visibleIdxs = [];
      for (let i = 0; i < points.length; i++) {
        if (isPointVisible(i, points, hiddenEvents)) visibleIdxs.push(i);
      }
      const normalSegs = [];
      for (let k = 0; k < visibleIdxs.length - 1; k++) {
        const a = visibleIdxs[k], b = visibleIdxs[k + 1];
        if (b - a > 1) continue; // hidden span — leave tips unconnected
        normalSegs.push([
          [parseFloat(points[a].lat), parseFloat(points[a].lng)],
          [parseFloat(points[b].lat), parseFloat(points[b].lng)],
        ]);
      }
      if (normalSegs.length > 0) {
        const line = L.polyline(normalSegs, {
          color: "#3b82f6", weight: 3, opacity: 0.9,
          dashArray: "8 6", dashOffset: "0",
          lineCap: "round", lineJoin: "round",
          interactive: false,
          className: "pb-path-flow",
        }).addTo(map);
        polylineRef.current.push(line);
      }
    }

    return () => {
      container.removeEventListener("click", delHandler, true);
    };
  }, [points, hiddenEvents]);

  // Highlight marker on sidebar hover / selection / cursor point
  useEffect(() => {
    markersRef.current.forEach((m, i) => {
      if (!m) return;
      const el = m.getElement();
      if (!el) return;
      el.classList.toggle("pb-marker-highlight", i === hoveredIdx);
      el.classList.toggle("pb-marker-selected", i === selectedIdx);
      el.classList.toggle("pb-marker-cursor", i === cursorIdx);
    });
  }, [hoveredIdx, selectedIdx, cursorIdx, points, hiddenEvents]);

  // Reset auto-scroll tracker when nothing is active, so re-selecting later scrolls again
  useEffect(() => {
    if (editingIdx === null && selectedIdx === null) scrolledToIdxRef.current = null;
  }, [editingIdx, selectedIdx]);

  // Selecting a path point inside a collapsed group should expand that group
  // exactly once per selection, so the user can re-collapse after.
  const autoExpandedForSelRef = useRef(null);
  useEffect(() => {
    if (selectedIdx === null) {
      autoExpandedForSelRef.current = null;
      return;
    }
    if (autoExpandedForSelRef.current === selectedIdx) return;
    autoExpandedForSelRef.current = selectedIdx;
    const p = points[selectedIdx];
    if (!p || p.isEvent) return;
    let parentIdx = -1;
    for (let k = selectedIdx - 1; k >= 0; k--) {
      if (points[k].isEvent) { parentIdx = k; break; }
    }
    if (parentIdx >= 0 && collapsedEvents.has(parentIdx)) {
      setCollapsedEvents((prev) => {
        const next = new Set(prev);
        next.delete(parentIdx);
        return next;
      });
    }
  }, [selectedIdx, points]);

  // When the TZ changes while an edit is open, re-sync the edit input so it
  // reflects the stored instant in the new TZ. Otherwise saving would reinterpret
  // the stale old-TZ wall-clock as if it were in the new TZ.
  useEffect(() => {
    if (editingIdx === null) return;
    const p = pointsRef.current[editingIdx];
    if (!p) return;
    setEditTimestamp(toLocalInput(p.timestamp, displayTz));
  }, [displayTz, editingIdx]);

  // Debounced Nominatim address search
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearchLoading(false);
      if (searchAbortRef.current) searchAbortRef.current.abort();
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(() => {
      if (searchAbortRef.current) searchAbortRef.current.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=10&addressdetails=1`, {
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((data) => {
          setSearchResults(Array.isArray(data) ? data : []);
          setSearchLoading(false);
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            setSearchResults([]);
            setSearchLoading(false);
          }
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Sync address-search pin markers (kept separate from path points — not exported to CSV)
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L) return;
    const L = window.L;
    const map = mapInstanceRef.current;

    searchMarkersRef.current.forEach((m) => map.removeLayer(m));
    searchMarkersRef.current = [];

    searchPins.forEach((pin) => {
      const icon = L.divIcon({
        className: "",
        html: `<div style="position:relative;width:28px;height:36px;">
          <svg width="28" height="36" viewBox="0 0 28 36" style="display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5));">
            <path d="M14 1 C6.8 1, 1 6.8, 1 14 C1 22, 14 35, 14 35 C14 35, 27 22, 27 14 C27 6.8, 21.2 1, 14 1 Z" fill="#f87171" stroke="#fff" stroke-width="2"/>
            <circle cx="14" cy="13" r="4.5" fill="#fff"/>
          </svg>
          <div data-search-del-id="${pin.id}" style="
            position:absolute;top:-6px;right:-6px;
            width:18px;height:18px;border-radius:50%;
            background:#7f1d1d;border:1.5px solid #fff;
            display:flex;align-items:center;justify-content:center;
            color:#fff;font-size:11px;font-weight:700;cursor:pointer;
            box-shadow:0 1px 3px rgba(0,0,0,.4);line-height:0;padding-bottom:2px;
          ">×</div>
        </div>`,
        iconSize: [28, 36],
        iconAnchor: [14, 36],
      });
      const marker = L.marker([pin.lat, pin.lng], { icon, draggable: false, title: pin.label }).addTo(map);
      searchMarkersRef.current.push(marker);
    });

    const container = map.getContainer();
    const delHandler = (e) => {
      const btn = e.target.closest("[data-search-del-id]");
      if (btn) {
        e.stopPropagation();
        const id = parseInt(btn.dataset.searchDelId);
        setSearchPins((prev) => prev.filter((p) => p.id !== id));
      }
    };
    container.addEventListener("click", delHandler, true);

    return () => {
      container.removeEventListener("click", delHandler, true);
    };
  }, [searchPins]);

  // Close search dropdown on outside click
  useEffect(() => {
    if (!searchFocused) return;
    const handler = (e) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [searchFocused]);

  const selectSearchResult = (result) => {
    const lat = parseFloat(result.lat);
    const lng = parseFloat(result.lon);
    if (isNaN(lat) || isNaN(lng)) return;
    const id = ++searchPinIdRef.current;
    setSearchPins((prev) => [...prev, { id, lat, lng, label: result.display_name }]);
    setSearchQuery("");
    setSearchResults([]);
    setSearchFocused(false);
    const map = mapInstanceRef.current;
    if (map) {
      map.flyTo([lat, lng], Math.min(map.getZoom(), 13), { duration: 0.8 });
    }
  };

  const applyDeleteSideEffects = (idx) => {
    const arr = pointsRef.current;
    const isEvent = arr[idx]?.isEvent;
    let mergeParent = -1;
    if (isEvent) {
      const nextPt = arr[idx + 1];
      if (nextPt && !nextPt.isEvent) {
        mergeParent = parentEventOf(arr, idx);
      }
    }
    const prevHidden = hiddenEventsRef.current;
    if (prevHidden.size > 0) {
      const nextHidden = new Set();
      prevHidden.forEach((eIdx) => {
        if (eIdx === idx) return;
        if (eIdx === mergeParent) return; // unhide merged parent so children stay visible
        nextHidden.add(eIdx > idx ? eIdx - 1 : eIdx);
      });
      commitHidden(nextHidden);
    }
    shiftCollapsedOnDelete(idx);
  };

  const removePoint = (idx) => {
    setSelectedIdx(null);
    cursorIdxRef.current = null;
    setCursorIdx(null);
    cursorDirRef.current = "fwd";
    applyDeleteSideEffects(idx);
    updatePoints(autoDistribute(pointsRef.current.filter((_, i) => i !== idx), displayTz));
  };

  const startEdit = (idx) => {
    if (!points[idx].isEvent) return;
    setEditingIdx(idx);
    setEditTimestamp(toLocalInput(points[idx].timestamp, displayTz));
    setEditTitle(points[idx].title || "");
    setEditLat(points[idx].lat);
    setEditLng(points[idx].lng);
  };

  const saveEdit = () => {
    const parsedLat = parseFloat(editLat);
    const parsedLng = parseFloat(editLng);
    const updated = pointsRef.current.map((p, i) => {
      if (i !== editingIdx) return p;
      const next = { ...p, timestamp: fromLocalInput(editTimestamp, displayTz), title: editTitle };
      if (!isNaN(parsedLat) && parsedLat >= -90 && parsedLat <= 90) next.lat = parsedLat.toFixed(6);
      if (!isNaN(parsedLng) && parsedLng >= -180 && parsedLng <= 180) next.lng = parsedLng.toFixed(6);
      return next;
    });
    updatePoints(autoDistribute(updated, displayTz));
    setEditingIdx(null);
    setSelectedIdx(null);
  };

  const exportCSV = () => {
    const header = EXPECTED_COLUMNS;
    const rows = points.map((p) => {
      const d = p.timestamp ? new Date(p.timestamp) : null;
      const localTs = d && !isNaN(d) ? formatDateTime(d, displayTz) : p.timestamp;
      return `${p.lat},${p.lng},${localTs},${p.isEvent ? "event" : "path_point"},${p.isEvent ? (p.title || "") : ""}`;
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const h = now.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${h12}.${pad(now.getMinutes())}.${pad(now.getSeconds())} ${ampm}`;
    a.download = `Path Builder Export ${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importCSV = (e) => {
    setImportError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".csv")) {
      setImportError("Only .csv files are accepted.");
      e.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = parseCSV(evt.target.result);

        if (points.length > 0 && !window.confirm("This will replace your current path. Continue?")) {
          e.target.value = "";
          return;
        }

        commitHidden(new Set());
        updatePoints(imported, { undoable: false });
        resetHistory(imported);
        setEditingIdx(null);
        setCollapsedEvents(new Set());

        // Fit map to imported points
        if (mapInstanceRef.current && window.L && imported.length > 0) {
          const bounds = window.L.latLngBounds(
            imported.map((p) => [parseFloat(p.lat), parseFloat(p.lng)])
          );
          mapInstanceRef.current.fitBounds(bounds, { padding: [40, 40] });
        }
      } catch (err) {
        setImportError(err.message);
      }
      e.target.value = "";
    };
    reader.onerror = () => {
      setImportError("Failed to read file.");
      e.target.value = "";
    };
    reader.readAsText(file);
  };

  const s = {
    root: { display: "flex", height: "100vh", fontFamily: "'JetBrains Mono', 'SF Mono', monospace", background: "#0a0f1a", color: "#c8d3e0" },
    sidebar: { width: 340, display: "flex", flexDirection: "column", borderRight: "1px solid #1a2236", overflow: "hidden" },
    header: { padding: "16px 16px 12px", borderBottom: "1px solid #1a2236" },
    title: { fontSize: 13, fontWeight: 700, color: "#e2e8f0", letterSpacing: "0.06em", textTransform: "uppercase", margin: 0 },
    sub: { fontSize: 10, color: "#8a9bb3", marginTop: 4 },
    controls: { padding: "12px 16px", borderBottom: "1px solid #1a2236", display: "flex", flexDirection: "column", gap: 8 },
    row: { display: "flex", gap: 8, alignItems: "center" },
    label: { fontSize: 9, color: "#5a6a80", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 },
    input: { background: "#111827", border: "1px solid #1e293b", borderRadius: 4, padding: "5px 8px", color: "#c8d3e0", fontSize: 11, fontFamily: "inherit", outline: "none", width: "100%" },
    btn: { padding: "6px 12px", borderRadius: 4, border: "none", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase", letterSpacing: "0.05em" },
    btnPrimary: { background: "#2563eb", color: "#fff" },
    btnDanger: { background: "#991b1b", color: "#fca5a5" },
    btnGhost: { background: "#1e293b", color: "#94a3b8" },
    btnActive: { background: "#f59e0b", color: "#000" },
    pointList: { flex: 1, overflowY: "auto", padding: 0 },
    pointItem: { display: "flex", alignItems: "center", padding: "8px 16px", gap: 10, borderBottom: "1px solid #111827", fontSize: 10, position: "relative" },
    pointNum: { width: 20, height: 20, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#fff", flexShrink: 0 },
    mapWrap: { flex: 1, position: "relative" },
    empty: { display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "#3a4a5e", fontSize: 11, textAlign: "center", padding: 24 },
  };

  const modeBtn = (m) => ({
    ...s.btn,
    padding: "8px 16px",
    borderRadius: 0,
    fontSize: 11,
    ...(mode === m
      ? { background: "#f59e0b", color: "#000" }
      : { background: "rgba(10,15,26,0.85)", color: "#94a3b8" }),
  });

  const timestampErrors = (() => {
    const events = [];
    points.forEach((p) => { if (p.isEvent && p.timestamp) events.push({ num: events.length + 1, t: new Date(p.timestamp).getTime() }); });
    const errs = [];
    for (let i = 0; i < events.length; i++) {
      const after = [];
      for (let j = i + 1; j < events.length; j++) if (events[j].t < events[i].t) after.push(events[j].num);
      if (after.length) errs.push({ n: events[i].num, after });
    }
    return errs;
  })();
  const hasTimestampErrors = timestampErrors.length > 0;

  return (
    <div style={s.root}>
      <div style={s.sidebar}>
        <div style={s.header}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p style={s.title}>Path Builder</p>
            {points.length > 0 && (
              <button
                style={{
                  ...s.btn, background: "transparent", padding: "2px 4px", fontSize: 9,
                  color: "#64748b",
                  marginTop: -20, marginRight: -10,
                }}
                onClick={() => setConfirmClear(true)}
                title="Clear all points"
              >Clear all</button>
            )}
          </div>
          <p style={s.sub}>Path builder is an open source tool for creating custom paths for LUMYX. Unlike other path building tools, this one includes timestamps to allow for animated playback.</p>
          <p style={{ ...s.sub, marginTop: 8 }}>Instructions:</p>
          <ol style={{ ...s.sub, margin: 0, paddingLeft: 28 }}>
            <li>Add event points with known locations to the map</li>
            <li>Set timestamps for each event point in the left pane</li>
            <li>Add path points between event points to fill in the path</li>
            <li>Press Export CSV and import into LUMYX (or re-import here to continue working)</li>
          </ol>
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            style={{
              ...s.sub, marginTop: 8, background: "transparent", border: "none",
              color: "#5a6a80", cursor: "pointer", padding: 0, fontFamily: "inherit",
              textDecoration: "underline", textAlign: "left",
            }}
          >{showAdvanced ? "Hide More Info" : "More Info"}</button>
          {showAdvanced && (
            <div style={{ ...s.sub, marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              <p style={{ margin: 0 }}>In path builder event points are simply "time anchors" for your path.</p>
              <p style={{ margin: 0 }}>Once you add event points to the map and assign timestamps to them, path point timestamps will evenly distribute between their previous and next event point.</p>
              <p style={{ margin: 0 }}>This saves a lot of time over manually assigning timestamps to every single path point.</p>
              <p style={{ margin: 0 }}>IMPORTANT NOTE: path builder event points WILL NOT become Lumyx events when imported to Lumyx... they will appear as normal points.</p>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            <button
              style={{ ...s.btn, background: "#f59e0b", color: "#000", width: "100%", padding: "8px 12px", opacity: points.length ? 1 : 0.4 }}
              onClick={exportCSV}
              disabled={!points.length}
            >Export CSV</button>
            <button
              style={{ ...s.btn, ...s.btnGhost, width: "100%", padding: "8px 12px" }}
              onClick={() => fileInputRef.current?.click()}
            >Import CSV</button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: "none" }}
            onChange={importCSV}
          />
          {importError && (
            <div style={{
              marginTop: 8, padding: "8px 10px", borderRadius: 4,
              background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
              color: "#fca5a5", fontSize: 9, lineHeight: 1.5, whiteSpace: "pre-wrap",
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Import failed</div>
              {importError}
              <button
                style={{ ...s.btn, background: "transparent", color: "#fca5a5", padding: "2px 0", marginTop: 8, fontSize: 8, display: "block" }}
                onClick={() => setImportError(null)}
              >Dismiss</button>
            </div>
          )}
          {points.length > 0 && (
            <div style={{
              marginTop: 12, paddingTop: 12,
              borderTop: "1px solid #1a2236",
            }}>
              <div style={{ ...s.label, marginBottom: 4 }}>Timezone</div>
              <select
                value={displayTz}
                onChange={(e) => setDisplayTz(e.target.value)}
                title="Timezone used for displaying and exporting timestamps"
                style={{
                  ...s.input, fontSize: 10, padding: "5px 6px",
                  cursor: "pointer", width: "100%",
                }}
              >
                {(() => {
                  const browserTz = getDefaultTz();
                  const common = [
                    "UTC",
                    "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles",
                    "America/Denver", "America/Chicago", "America/New_York",
                    "America/Mexico_City", "America/Sao_Paulo",
                    "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
                    "Africa/Johannesburg",
                    "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok",
                    "Asia/Shanghai", "Asia/Tokyo",
                    "Australia/Sydney", "Pacific/Auckland",
                  ];
                  const tzs = Array.from(new Set([browserTz, displayTz, ...common]));
                  return tzs.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz === browserTz ? `${tz} (local)` : tz}
                    </option>
                  ));
                })()}
              </select>
            </div>
          )}
        </div>
        <div style={s.pointList}>
          {hasTimestampErrors && (
            <div style={{
              background: "rgba(153,27,27,0.9)", color: "#fecaca",
              padding: "8px 12px", fontSize: 10, fontWeight: 600,
              borderBottom: "1px solid #7f1d1d", position: "sticky", top: 0, zIndex: 2,
            }}>
              <div style={{ marginBottom: 4 }}>Event point timestamps out of order</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontWeight: 500 }}>
                {timestampErrors.map((e) => (
                  <li key={e.n}>Event point {e.n} is after event point {e.after.join(", ")}</li>
                ))}
              </ul>
            </div>
          )}
          {points.length === 0 ? (
            <div style={s.empty}>
              No points yet. Use the controls on the map to get started.
            </div>
          ) : (
            points.map((p, i) => {
              const eventIdx = p.isEvent ? points.slice(0, i + 1).filter((pt) => pt.isEvent).length : null;
              let pathLabel = null;
              let parentEventIdx = -1;
              if (!p.isEvent) {
                let prevEventNum = 0;
                for (let k = 0; k < i; k++) {
                  if (points[k].isEvent) { prevEventNum++; parentEventIdx = k; }
                }
                pathLabel = `${prevEventNum}.${i - parentEventIdx}`;
              }
              if (!p.isEvent && parentEventIdx >= 0 && collapsedEvents.has(parentEventIdx)) {
                return null;
              }
              const childCount = p.isEvent ? (() => {
                let n = 0;
                for (let k = i + 1; k < points.length; k++) {
                  if (points[k].isEvent) break;
                  n++;
                }
                return n;
              })() : 0;
              const isCollapsed = p.isEvent && collapsedEvents.has(i);
              const isHidden = p.isEvent && hiddenEvents.has(i);
              const isRowHidden = isHidden || (!p.isEvent && parentEventIdx >= 0 && hiddenEvents.has(parentEventIdx));
              return (<div
                key={i}
                ref={(el) => {
                  const active = editingIdx === i || selectedIdx === i;
                  if (el && active && scrolledToIdxRef.current !== i) {
                    scrolledToIdxRef.current = i;
                    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
                  }
                }}
                style={{
                  ...s.pointItem,
                  cursor: "pointer",
                  opacity: isRowHidden ? 0.45 : 1,
                  background: (() => {
                    const base = [59,130,246];
                    const selected = selectedIdx === i;
                    const hovered = hoveredIdx === i;
                    if (selected && hovered) return `rgba(${base},0.25)`;
                    if (selected) return `rgba(${base},0.2)`;
                    if (hovered) return `rgba(${base},0.1)`;
                    return p.isEvent ? "rgba(59,130,246,0.06)" : "transparent";
                  })(),
                }}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
                onClick={() => {
                  if (editingIdx !== null && editingIdx !== i) setEditingIdx(null);
                  if (p.isEvent) {
                    setSelectedIdx(i);
                    if (editingIdx !== i) startEdit(i);
                    cursorIdxRef.current = i;
                    setCursorIdx(i);
                    cursorDirRef.current = "none";
                    return;
                  }
                  if (selectedIdx === i) {
                    setSelectedIdx(null);
                  } else {
                    setSelectedIdx(i);
                    if (!isRowHidden) {
                      cursorIdxRef.current = i;
                      setCursorIdx(i);
                      cursorDirRef.current = "none";
                    }
                  }
                }}
              >
                <div style={{
                  ...s.pointNum,
                  background: "#3b82f6",
                  borderRadius: p.isEvent ? 4 : "50%",
                  width: p.isEvent ? 24 : 14,
                  height: p.isEvent ? 24 : 14,
                  fontSize: p.isEvent ? 10 : 9,
                }}>
                  {p.isEvent ? `#${eventIdx}` : ""}
                </div>
                <div style={{ flex: 1, lineHeight: 1.5 }}>
                  {editingIdx === i || (p.isEvent && selectedIdx === i) ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                        {confirmDeleteIdx === i ? (
                          <>
                            <span style={{ fontSize: 8, color: "#fca5a5" }}>delete?</span>
                            <button
                              style={{ ...s.btn, background: "#991b1b", color: "#fca5a5", padding: "2px 6px", fontSize: 8 }}
                              onClick={() => { setConfirmDeleteIdx(null); removePoint(i); }}
                            >Yes</button>
                            <button
                              style={{ ...s.btn, ...s.btnGhost, padding: "2px 6px", fontSize: 8 }}
                              onClick={() => setConfirmDeleteIdx(null)}
                            >No</button>
                          </>
                        ) : (
                          <button
                            style={{ ...s.btn, background: "#991b1b", color: "#fca5a5", padding: "2px 6px", fontSize: 8 }}
                            onClick={() => setConfirmDeleteIdx(i)}
                          >Delete</button>
                        )}
                        <button style={{ ...s.btn, ...s.btnPrimary, padding: "2px 6px", fontSize: 8 }} onClick={saveEdit}>Save</button>
                        <button style={{ ...s.btn, ...s.btnGhost, padding: "2px 6px", fontSize: 8 }} onClick={() => { setConfirmDeleteIdx(null); setEditingIdx(null); setSelectedIdx(null); }}>Cancel</button>
                      </div>
                      <div>
                        <div style={{ ...s.label, marginBottom: 2 }}>Title</div>
                        <input
                          style={{ ...s.input, fontSize: 9, padding: "2px 4px" }}
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                        />
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ ...s.label, marginBottom: 2 }}>Latitude</div>
                          <input
                            style={{ ...s.input, fontSize: 9, padding: "2px 4px" }}
                            value={editLat}
                            onChange={(e) => setEditLat(e.target.value)}
                          />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ ...s.label, marginBottom: 2 }}>Longitude</div>
                          <input
                            style={{ ...s.input, fontSize: 9, padding: "2px 4px" }}
                            value={editLng}
                            onChange={(e) => setEditLng(e.target.value)}
                          />
                        </div>
                      </div>
                      <div>
                        <div style={{ ...s.label, marginBottom: 2 }}>Timestamp</div>
                        <input
                          type="datetime-local"
                          step="1"
                          style={{ ...s.input, fontSize: 9, padding: "2px 4px" }}
                          value={editTimestamp}
                          onChange={(e) => setEditTimestamp(e.target.value)}
                        />
                      </div>
                      {(() => {
                        let prevEventIdx = -1;
                        for (let k = i - 1; k >= 0; k--) if (points[k].isEvent) { prevEventIdx = k; break; }
                        let nextEventIdx = -1;
                        for (let k = i + 1; k < points.length; k++) if (points[k].isEvent) { nextEventIdx = k; break; }
                        if (prevEventIdx < 0 && nextEventIdx < 0) return null;
                        const posOffsets = [["+1min", 60000], ["+1hr", 3600000], ["+1day", 86400000]];
                        const negOffsets = [["-1min", -60000], ["-1hr", -3600000], ["-1day", -86400000]];
                        const apply = (baseTs, ms) => {
                          if (!baseTs) return;
                          setEditTimestamp(toLocalInput(new Date(new Date(baseTs).getTime() + ms), displayTz));
                        };
                        const row = (key, label, ts, offsets) => (
                          <div key={key} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontSize: 8, color: "#5a6a80" }}>{label}:</span>
                            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                              {offsets.map(([lbl, ms]) => (
                                <button
                                  key={lbl}
                                  style={{ ...s.btn, ...s.btnGhost, padding: "1px 4px", fontSize: 8, textTransform: "none" }}
                                  onClick={() => apply(ts, ms)}
                                >{lbl}</button>
                              ))}
                            </div>
                          </div>
                        );
                        return (
                          <div style={{ display: "flex", gap: 8 }}>
                            {prevEventIdx >= 0 && (() => {
                              const n = points.slice(0, prevEventIdx + 1).filter((pt) => pt.isEvent).length;
                              return row("prev", `from #${n}`, points[prevEventIdx].timestamp, posOffsets);
                            })()}
                            {nextEventIdx >= 0 && (() => {
                              const n = points.slice(0, nextEventIdx + 1).filter((pt) => pt.isEvent).length;
                              return row("next", `from #${n}`, points[nextEventIdx].timestamp, negOffsets);
                            })()}
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <>
                      {p.isEvent && <div style={{ color: "#3b82f6", fontWeight: 600, fontSize: 10 }}>{p.title || "-"}</div>}
                      <div style={{ color: "#c8d3e0", fontWeight: 600, fontSize: 10 }}>
                        {pathLabel && <span style={{ color: "#5a6a80" }}>{pathLabel}: </span>}
                        {displayDateTime(p.timestamp, displayTz)}
                      </div>
                      <div style={{ color: "#5a6a80", fontSize: 9 }}>{p.lat}, {p.lng}</div>
                    </>
                  )}
                </div>
                {editingIdx !== i && (
                  <>
                    {isRowHidden && (
                      <span
                        title="Hidden from the map"
                        style={{
                          position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                          color: "#5a6a80",
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          width: 20, height: 20, flexShrink: 0, pointerEvents: "none",
                          visibility: hoveredIdx === i ? "hidden" : "visible",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 8 C 4 4, 12 4, 14 8 C 12 12, 4 12, 2 8" />
                          <line x1="2" y1="2" x2="14" y2="14" />
                        </svg>
                      </span>
                    )}
                    <div style={{
                      position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                      display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                      visibility: hoveredIdx === i ? "visible" : "hidden",
                    }}>
                      <button
                        style={{
                          background: "#991b1b", border: "none", color: "#fca5a5",
                          cursor: "pointer", fontSize: 11, fontWeight: 700,
                          width: 20, height: 20, borderRadius: 4,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          flexShrink: 0,
                        }}
                        onClick={(e) => { e.stopPropagation(); removePoint(i); }}
                      >×</button>
                      {p.isEvent && (
                        <button
                          style={{
                            background: "#1e293b", border: "none", color: "#94a3b8",
                            cursor: "pointer", fontSize: 12, fontWeight: 600,
                            width: 20, height: 20, borderRadius: 4,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            flexShrink: 0,
                          }}
                          onClick={(e) => { e.stopPropagation(); startEdit(i); }}
                        ><span style={{ display: "inline-block", transform: "scaleX(-1)" }}>✎</span></button>
                      )}
                      {p.isEvent && (childCount > 0 || isHidden) && (
                        <span style={{
                          width: 1, height: 14, background: "#334155",
                          margin: "0 2px", flexShrink: 0,
                        }} />
                      )}
                      {p.isEvent && (childCount > 0 || isHidden) && (
                        <button
                          title={isHidden ? `Show ${childCount} path point${childCount === 1 ? "" : "s"} on map` : "Hide path points from map"}
                          style={{
                            background: "#1e293b", border: "none",
                            color: isHidden ? "#eab308" : "#94a3b8",
                            cursor: "pointer", fontSize: 10, fontWeight: 700,
                            width: 20, height: 20, borderRadius: 4,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            flexShrink: 0,
                          }}
                          onClick={(e) => { e.stopPropagation(); toggleEventHidden(i); }}
                        >
                          {isHidden ? (
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M2 8 C 4 4, 12 4, 14 8 C 12 12, 4 12, 2 8" />
                              <line x1="2" y1="2" x2="14" y2="14" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M2 8 C 4 4, 12 4, 14 8 C 12 12, 4 12, 2 8" />
                              <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
                            </svg>
                          )}
                        </button>
                      )}
                      {p.isEvent && childCount > 0 && (
                        <button
                          title={isCollapsed ? `Expand ${childCount} path point${childCount === 1 ? "" : "s"}` : "Collapse path points"}
                          style={{
                            background: "#1e293b", border: "none", color: "#94a3b8",
                            cursor: "pointer", fontSize: 10, fontWeight: 700,
                            width: 20, height: 20, borderRadius: 4,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            flexShrink: 0,
                          }}
                          onClick={(e) => { e.stopPropagation(); toggleEventCollapsed(i); }}
                        >{isCollapsed ? "▸" : "▾"}</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );})
          )}
        </div>
      </div>
      <div style={s.mapWrap}>
        <div ref={mapRef} style={{ width: "100%", height: "100%" }} />
        {!loaded && <div style={{ ...s.empty, position: "absolute", inset: 0, background: "#0a0f1a" }}>Loading map…</div>}
        {loaded && (
          <div
            ref={searchContainerRef}
            style={{
              position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)",
              zIndex: 1000, width: 260,
              display: "flex", flexDirection: "column-reverse", gap: 6,
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              background: "rgba(255,255,255,0.28)",
              border: "1px solid rgba(255,255,255,0.45)",
              borderRadius: 6,
              padding: "7px 10px",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
              backdropFilter: "blur(12px) saturate(140%)",
              WebkitBackdropFilter: "blur(12px) saturate(140%)",
            }}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#334155" strokeWidth="1.75" style={{ flexShrink: 0 }}>
                <circle cx="7" cy="7" r="5" />
                <line x1="10.5" y1="10.5" x2="14.5" y2="14.5" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                className="pb-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                placeholder="Search address…"
                style={{
                  flex: 1, background: "transparent", border: "none", outline: "none",
                  color: "#0f172a", fontSize: 11, fontFamily: "inherit", padding: 0, minWidth: 0,
                }}
              />
              {searchLoading && <span style={{ color: "#475569", fontSize: 9 }}>…</span>}
              {!searchLoading && searchQuery && (
                <button
                  style={{
                    background: "transparent", border: "none", color: "#475569",
                    cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1, flexShrink: 0,
                  }}
                  onClick={() => { setSearchQuery(""); setSearchResults([]); }}
                  title="Clear"
                >×</button>
              )}
            </div>
            {searchFocused && searchQuery.trim() && (
              <div style={{
                background: "rgba(255,255,255,0.4)",
                border: "1px solid rgba(255,255,255,0.45)",
                borderRadius: 6,
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                maxHeight: 440, overflowY: "auto",
                backdropFilter: "blur(16px) saturate(140%)",
                WebkitBackdropFilter: "blur(16px) saturate(140%)",
              }}>
                {searchResults.length === 0 ? (
                  <div style={{ padding: "8px 10px", fontSize: 10, color: "#475569" }}>
                    {searchLoading ? "Searching…" : "No results."}
                  </div>
                ) : searchResults.map((r, i) => {
                  const addr = r.address || {};
                  const streetLine = [addr.house_number, addr.road].filter(Boolean).join(" ");
                  const fallbackFirst = (r.display_name || "").split(",")[0]?.trim();
                  const primary = streetLine || addr.name || r.name || fallbackFirst || "";
                  const localityParts = [
                    addr.city || addr.town || addr.village || addr.hamlet || addr.suburb,
                    addr.state || addr.region || addr.county,
                    addr.postcode,
                  ].filter(Boolean);
                  if (localityParts[0] && localityParts[0] === primary) localityParts.shift();
                  const locality = localityParts.join(", ");
                  const tail = addr.country || "";
                  return (
                    <div
                      key={r.place_id ?? i}
                      style={{
                        padding: "9px 12px",
                        borderBottom: i < searchResults.length - 1 ? "1px solid rgba(15,23,42,0.08)" : "none",
                        cursor: "pointer", lineHeight: 1.4,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(59,130,246,0.18)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      onClick={() => selectSearchResult(r)}
                    >
                      <div style={{ fontSize: 12, color: "#0f172a", fontWeight: 600, wordBreak: "break-word" }}>
                        {primary}
                      </div>
                      {locality && (
                        <div style={{ fontSize: 10, color: "#334155", marginTop: 2, wordBreak: "break-word" }}>
                          {locality}
                        </div>
                      )}
                      {tail && (
                        <div style={{ fontSize: 9, color: "#64748b", marginTop: 1, wordBreak: "break-word" }}>
                          {tail}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {loaded && (
          <div style={{
            position: "absolute", top: 10, left: 10, zIndex: 1000,
            display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6,
          }}>
            <div style={{ display: "flex", gap: 6 }}>
              <div ref={modeBtnsRef} style={{
                display: "flex", borderRadius: 6, overflow: "hidden",
                boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)",
              }}>
                <button style={modeBtn("event")} onClick={() => setMode("event")}>Event point</button>
                <button style={modeBtn("path")} onClick={() => setMode("path")}>Path point</button>
              </div>
              <div style={{
                display: "flex", borderRadius: 6, overflow: "hidden",
                boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)",
              }}>
                <button
                  style={{
                    ...s.btn, padding: "8px 12px", borderRadius: 0, fontSize: 11,
                    background: "rgba(10,15,26,0.85)",
                    color: canUndo ? "#94a3b8" : "#3a4a5e",
                    cursor: canUndo ? "pointer" : "default",
                    borderRight: "1px solid rgba(255,255,255,0.08)",
                  }}
                  onClick={undo}
                  disabled={!canUndo}
                  title="Undo (Cmd+Z)"
                >← Undo</button>
                <button
                  style={{
                    ...s.btn, padding: "8px 12px", borderRadius: 0, fontSize: 11,
                    background: "rgba(10,15,26,0.85)",
                    color: canRedo ? "#94a3b8" : "#3a4a5e",
                    cursor: canRedo ? "pointer" : "default",
                  }}
                  onClick={redo}
                  disabled={!canRedo}
                  title="Redo (Cmd+Shift+Z)"
                >Redo →</button>
              </div>
            </div>
            {(() => {
              const hasEvents = points.some((p) => p.isEvent);
              const hasPathPoints = points.some((p) => !p.isEvent);
              const show = mode === "event" ? !hasEvents : !hasPathPoints;
              if (!show) return null;
              return (
                <div style={{
                  fontSize: 10, color: "#fff", padding: "4px 8px", borderRadius: 4,
                  background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)",
                  width: modeBtnsWidth ?? 220, boxSizing: "border-box", lineHeight: 1.4,
                }}>
                  {mode === "event"
                    ? <>Click to place event points at important locations.</>
                    : <>Click between event points to add path points.</>}
                </div>
              );
            })()}
            {cursorIdx !== null && cursorIdx < points.length && (() => {
              const p = points[cursorIdx];
              let label;
              if (p.isEvent) {
                const n = points.slice(0, cursorIdx + 1).filter((pt) => pt.isEvent).length;
                label = `Event Point: #${n}`;
              } else {
                let prevEventNum = 0;
                let prevEventIdx = -1;
                for (let k = 0; k < cursorIdx; k++) {
                  if (points[k].isEvent) { prevEventNum++; prevEventIdx = k; }
                }
                label = `Path Point: ${prevEventNum}.${cursorIdx - prevEventIdx}`;
              }
              return (
                <div style={{
                  fontSize: 10, color: "#fff", padding: "6px 8px", borderRadius: 4,
                  background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)",
                  width: (modeBtnsWidth ?? 220) + 50, boxSizing: "border-box", lineHeight: 1.4,
                  display: "flex", flexDirection: "column", gap: 4,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 9, height: 9, borderRadius: 2, background: "#eab308", flexShrink: 0, border: "1.5px solid #fff" }} />
                    <span style={{ flex: 1 }}>Cursor: {label}</span>
                    <button
                      style={{
                        background: "transparent", border: "none", color: "#94a3b8",
                        cursor: "pointer", padding: 0, fontSize: 10, fontFamily: "inherit",
                        textDecoration: "underline",
                      }}
                      onClick={() => {
                        cursorIdxRef.current = null;
                        setCursorIdx(null);
                        cursorDirRef.current = "fwd";
                      }}
                      title="Clear cursor"
                    >clear</button>
                  </div>
                  <div style={{ fontSize: 9, color: "#94a3b8", lineHeight: 1.3 }}>
                    new points will bias towards connecting to the cursor point
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
      {confirmClear && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000,
          }}
          onClick={() => setConfirmClear(false)}
        >
          <div
            style={{
              background: "#0f1626", border: "1px solid #1a2236", borderRadius: 8,
              padding: 20, width: 320, boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", marginBottom: 8 }}>
              Clear all points?
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16, lineHeight: 1.5 }}>
              This will remove all {points.length} point{points.length === 1 ? "" : "s"}. You can undo with Cmd+Z.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                style={{ ...s.btn, ...s.btnGhost, padding: "6px 14px", fontSize: 12 }}
                onClick={() => setConfirmClear(false)}
              >Cancel</button>
              <button
                style={{
                  ...s.btn, padding: "6px 14px", fontSize: 12,
                  background: "#ef4444", color: "#fff",
                }}
                onClick={() => {
                  commitHidden(new Set());
                  updatePoints([]);
                  setSelectedIdx(null);
                  setEditingIdx(null);
                  setCollapsedEvents(new Set());
                  setConfirmClear(false);
                }}
              >Clear all</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
