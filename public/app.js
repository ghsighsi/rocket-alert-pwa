/* ═══════════════════════════════════════════════
   Rocket Alert PWA – Client Application v3
   tzevaadom-style: red pin markers + polygons
   ═══════════════════════════════════════════════ */
(function () {
  "use strict";

  const ISRAEL_CENTER = [31.4, 34.85];
  const ISRAEL_ZOOM = 8;

  const COLORS = {
    alarm:   { stroke: "#c41e1e", fill: "#dc2626", fillOpacity: 0.28 },
    warning: { stroke: "#b45309", fill: "#f59e0b", fillOpacity: 0.22 },
    release: { stroke: "#16a34a", fill: "#22c55e", fillOpacity: 0.18 },
  };

  // ── Solid dot markers (small, no animation) ──
  const DOT_COLORS = {
    alarm:   "#dc2626",
    warning: "#f59e0b",
    release: "#22c55e",
  };

  // ── State ──
  let map, socket;
  let activeZones = {};     // { cityName: { layer, pinMarker, timeoutId, type } }
  let releaseZones = {};    // { cityName: { layer, pinMarker, timeoutId } }
  let homeCity = "";
  let isMuted = false;
  let alertsListCollapsed = false;
  let isDarkMode = false;   // Light by default (tzevaadom-style)
  let darkTileLayer = null;
  let lightTileLayer = null;

  // ── GeoJSON ──
  let geoData = null;
  let geoIndex = {};

  // ── DOM ──
  const $ = (id) => document.getElementById(id);
  const $statusBadge = $("status-badge");
  const $statusText = $statusBadge.querySelector(".status-text");
  const $alertsContent = $("alerts-list-content");
  const $alertsBody = $("alerts-list-body");
  const $toggleBtn = $("btn-toggle-alerts");
  const $alertCountBadge = $("alert-count-badge");
  const $connIndicator = $("connection-indicator");
  const $connText = $connIndicator.querySelector(".conn-text");
  const $settingsPanel = $("settings-panel");
  const $selectCity = $("select-city");
  const $notifStatus = $("notif-status");

  // ══════════════════════════════════════════════
  // THEME
  // ══════════════════════════════════════════════
  const TILE_DARK = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
  const TILE_LIGHT = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

  function applyTheme(dark) {
    isDarkMode = dark;
    document.body.classList.toggle("theme-light", !dark);
    document.body.classList.toggle("theme-dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#0a0a0f" : "#f0f0f5";

    if (dark) {
      if (lightTileLayer && map.hasLayer(lightTileLayer)) map.removeLayer(lightTileLayer);
      if (!map.hasLayer(darkTileLayer)) map.addLayer(darkTileLayer);
    } else {
      if (darkTileLayer && map.hasLayer(darkTileLayer)) map.removeLayer(darkTileLayer);
      if (!map.hasLayer(lightTileLayer)) map.addLayer(lightTileLayer);
    }

    const btn = $("btn-theme");
    if (btn) btn.innerHTML = dark
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  // ══════════════════════════════════════════════
  // MAP
  // ══════════════════════════════════════════════
  function initMap() {
    map = L.map("map", {
      center: ISRAEL_CENTER,
      zoom: ISRAEL_ZOOM,
      zoomControl: true,
      attributionControl: true,
      maxBounds: [[28, 33], [34, 37]],
      minZoom: 7,
      maxZoom: 16,
    });

    darkTileLayer = L.tileLayer(TILE_DARK, {
      attribution: '&copy; OSM &copy; CARTO',
      subdomains: "abcd",
      maxZoom: 19,
      className: "map-tiles-dark",
    });

    lightTileLayer = L.tileLayer(TILE_LIGHT, {
      attribution: '&copy; OSM &copy; CARTO',
      subdomains: "abcd",
      maxZoom: 19,
      className: "map-tiles-light",
    });

    // Default: light (tzevaadom-style)
    const saved = localStorage.getItem("theme");
    isDarkMode = saved === "dark";
    if (isDarkMode) {
      darkTileLayer.addTo(map);
    } else {
      lightTileLayer.addTo(map);
    }
    applyTheme(isDarkMode);
  }

  // ══════════════════════════════════════════════
  // GEOJSON LOADING & INDEXING
  // ══════════════════════════════════════════════
  function normalizeName(name) {
    if (!name) return "";
    return name
      .replace(/[\u0591-\u05C7]/g, "")
      .replace(/[-–—]/g, " ")
      .replace(/['"״׳`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildGeoIndex(geojson) {
    geoIndex = {};
    if (!geojson || !geojson.features) return;

    geojson.features.forEach((feature) => {
      const props = feature.properties || {};
      const displayName = props._displayName || "";
      if (!displayName) return;

      const key = normalizeName(displayName);
      if (key) geoIndex[key] = feature;

      const variants = [
        props.Muni_Heb, props.MUNI_HEB, props.name_he, props.NAME_HE,
        props.Heb_Name, props.HEB_NAME, props.Name, props.name, props.NAME,
        props.Muni_He, props.MUNI_NAME, props.MUN_HEB,
      ].filter(Boolean);

      variants.forEach((v) => {
        const k = normalizeName(v);
        if (k && !geoIndex[k]) geoIndex[k] = feature;
      });
    });

    console.log(`[GEO] Indexed ${Object.keys(geoIndex).length} city names`);
  }

  function findGeoFeature(cityName) {
    const key = normalizeName(cityName);

    // 1. Exact match
    if (geoIndex[key]) return geoIndex[key];

    // 2. Sub-area matching: "תל אביב - מרכז העיר" → try "תל אביב יפו", "תל אביב"
    //    "חיפה - מערב" → try "חיפה"
    //    "חדרה - נווה חיים" → try "חדרה"
    const dashIdx = key.indexOf(" ");
    if (dashIdx > 1) {
      // Try progressively shorter prefixes
      const parts = key.split(" ");
      for (let len = parts.length - 1; len >= 1; len--) {
        const prefix = parts.slice(0, len).join(" ");
        if (prefix.length < 2) continue;

        // Direct prefix match
        if (geoIndex[prefix]) return geoIndex[prefix];

        // Try prefix + common suffixes ("תל אביב" → "תל אביב יפו")
        const geoKeys = Object.keys(geoIndex);
        for (const gk of geoKeys) {
          if (gk.startsWith(prefix + " ") || gk === prefix) {
            return geoIndex[gk];
          }
        }
      }
    }

    return null;
  }

  async function loadGeoJSON(retries) {
    retries = retries || 0;
    try {
      const res = await fetch("/api/geojson");
      if (!res.ok) {
        if (retries < 5) {
          console.warn(`[GEO] Server returned ${res.status}, retry ${retries + 1}/5 in 3s...`);
          setTimeout(() => loadGeoJSON(retries + 1), 3000);
        } else {
          console.warn("[GEO] GeoJSON unavailable after 5 retries");
        }
        return;
      }
      geoData = await res.json();
      buildGeoIndex(geoData);
      console.log(`[GEO] Loaded ${geoData.features.length} features, indexed ${Object.keys(geoIndex).length} names`);
    } catch (e) {
      console.warn("[GEO] Failed to load GeoJSON:", e.message);
      if (retries < 5) {
        setTimeout(() => loadGeoJSON(retries + 1), 3000);
      }
    }
  }

  // ══════════════════════════════════════════════
  // DRAWING — Pin markers + Polygons (tzevaadom-style)
  // ══════════════════════════════════════════════
  function createPinMarker(latlng, type) {
    const color = DOT_COLORS[type] || DOT_COLORS.alarm;
    const icon = L.divIcon({
      className: "",
      html: `<div class="alert-dot" style="background:${color};"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
    return L.marker(latlng, { icon, interactive: false }).addTo(map);
  }

  function drawZone(cityObj, type) {
    const coords = cityObj.coords;
    if (!coords || !coords.lat || !coords.lng) return { layer: null, pinMarker: null };

    const style = COLORS[type] || COLORS.alarm;
    const latlng = [coords.lat, coords.lng];

    let layer = null;
    let pinMarker = null;
    const geoFeature = findGeoFeature(cityObj.name);

    if (geoFeature && geoFeature.geometry) {
      try {
        const tempLayer = L.geoJSON(geoFeature);
        const bounds = tempLayer.getBounds();

        // Check: alert point must be inside or very close to the polygon bounds
        const alertLatLng = L.latLng(coords.lat, coords.lng);
        const isInside = bounds.contains(alertLatLng);
        const polyCenter = bounds.getCenter();
        const distKm = distanceBetween(coords.lat, coords.lng, polyCenter.lat, polyCenter.lng);

        if (isInside || distKm < 5) {
          layer = L.geoJSON(geoFeature, {
            style: {
              color: style.stroke,
              fillColor: style.fill,
              fillOpacity: style.fillOpacity,
              weight: 2,
            },
          }).addTo(map);
        }
      } catch (e) {
        layer = null;
      }
    }

    if (!layer) {
      pinMarker = createPinMarker(latlng, type);
    }

    return { layer, pinMarker };
  }

  // Haversine distance in km
  function distanceBetween(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function removeZone(cityName) {
    const zone = activeZones[cityName];
    if (zone) {
      if (zone.timeoutId) clearTimeout(zone.timeoutId);
      if (zone.layer) map.removeLayer(zone.layer);
      if (zone.pinMarker) map.removeLayer(zone.pinMarker);
      delete activeZones[cityName];
    }
    updateUI();
  }

  function drawReleaseZone(cityName, coords) {
    if (!coords || !coords.lat || !coords.lng) return;

    if (releaseZones[cityName]) {
      clearTimeout(releaseZones[cityName].timeoutId);
      if (releaseZones[cityName].layer) map.removeLayer(releaseZones[cityName].layer);
      if (releaseZones[cityName].pinMarker) map.removeLayer(releaseZones[cityName].pinMarker);
    }

    const style = COLORS.release;
    const latlng = [coords.lat, coords.lng];
    let layer = null;
    let pinMarker = null;

    const geoFeature = findGeoFeature(cityName);
    if (geoFeature && geoFeature.geometry) {
      try {
        const tempLayer = L.geoJSON(geoFeature);
        const bounds = tempLayer.getBounds();
        const alertLatLng = L.latLng(coords.lat, coords.lng);
        const isInside = bounds.contains(alertLatLng);
        const polyCenter = bounds.getCenter();
        const distKm = distanceBetween(coords.lat, coords.lng, polyCenter.lat, polyCenter.lng);

        if (isInside || distKm < 5) {
          layer = L.geoJSON(geoFeature, {
            style: {
              color: style.stroke, fillColor: style.fill,
              fillOpacity: style.fillOpacity, weight: 2,
              dashArray: "6 4",
            },
          }).addTo(map);
        }
      } catch (e) {
        layer = null;
      }
    }

    // Dot only as fallback
    if (!layer) {
      pinMarker = createPinMarker(latlng, "release");
    }

    const timeoutId = setTimeout(() => {
      if (layer) map.removeLayer(layer);
      if (pinMarker) map.removeLayer(pinMarker);
      delete releaseZones[cityName];
      updateUI();
    }, 15000);

    releaseZones[cityName] = { layer, pinMarker, timeoutId };
  }

  // ══════════════════════════════════════════════
  // ALERT HANDLING
  // ══════════════════════════════════════════════
  function handleAlert(data) {
    if (!data || !data.cities) return;
    const type = data.type || "alarm";
    let newCount = 0;

    data.cities.forEach((cityObj) => {
      const existing = activeZones[cityObj.name];

      if (existing) {
        if (existing.type === "warning" && type === "alarm") {
          removeZone(cityObj.name);
        } else {
          return;
        }
      }

      const { layer, pinMarker } = drawZone(cityObj, type);
      activeZones[cityObj.name] = { layer, pinMarker, timeoutId: null, type };
      newCount++;
    });

    updateUI();

    if (newCount > 0 && !isMuted) {
      const cities = data.cities.map((c) => c.name);
      const isHome = isHomeCityMatch(cities);
      if (isHome) {
        playAlertSound(type);
        sendNotification(data, type);
      }
    }
  }

  // Shared helper: check if any city name matches homeCity
  function isHomeCityMatch(cityNames) {
    if (!homeCity) return true; // No home city = hear everything
    const match = cityNames.some((c) => c === homeCity);
    if (!match) {
      console.log(`[FILTER] Muted — home="${homeCity}" not in [${cityNames.slice(0, 3).join(", ")}${cityNames.length > 3 ? "..." : ""}]`);
    }
    return match;
  }

  function handleRelease(data) {
    let releasedCount = 0;
    const releasedNames = [];

    if (data && data.cities && data.cities.length > 0) {
      data.cities.forEach((city) => {
        const name = typeof city === "string" ? city : city.name;
        const zone = activeZones[name];
        if (!zone) return;

        let coords = city.coords || null;
        if (zone.pinMarker) {
          const ll = zone.pinMarker.getLatLng();
          coords = coords || { lat: ll.lat, lng: ll.lng };
        }

        removeZone(name);
        if (coords) drawReleaseZone(name, coords);
        releasedNames.push(name);
        releasedCount++;
      });
    } else {
      Object.keys(activeZones).forEach((name) => {
        const zone = activeZones[name];
        let coords = null;
        if (zone && zone.pinMarker) {
          const ll = zone.pinMarker.getLatLng();
          coords = { lat: ll.lat, lng: ll.lng };
        }
        removeZone(name);
        if (coords) drawReleaseZone(name, coords);
        releasedNames.push(name);
        releasedCount++;
      });
    }

    updateUI();

    if (releasedCount > 0 && !isMuted) {
      const isHome = isHomeCityMatch(releasedNames);
      if (isHome) playReleaseSound();
    }
  }
  function updateUI() {
    updateStatusBadge();
    updateAlertsList();
  }

  function updateStatusBadge() {
    const count = Object.keys(activeZones).length;
    const releaseCount = Object.keys(releaseZones).length;

    document.body.classList.remove("alert-active", "warning-active", "release-active");

    if (count === 0 && releaseCount > 0) {
      document.body.classList.add("release-active");
      $statusBadge.className = "status-release";
      $statusText.textContent = "שחרור";
    } else if (count === 0) {
      $statusBadge.className = "status-quiet";
      $statusText.textContent = "שקט כרגע";
    } else {
      let hasAlarm = false;
      Object.values(activeZones).forEach((z) => { if (z.type === "alarm") hasAlarm = true; });

      if (hasAlarm) {
        document.body.classList.add("alert-active");
        $statusBadge.className = "status-alert";
        $statusText.textContent = `צבע אדום — ${count} אזורים`;
      } else {
        document.body.classList.add("warning-active");
        $statusBadge.className = "status-warning";
        $statusText.textContent = `התרעה — ${count} אזורים`;
      }
    }

    $alertCountBadge.textContent = count;
    $alertCountBadge.style.display = count > 0 ? "flex" : "none";
  }

  function updateAlertsList() {
    $alertsContent.innerHTML = "";

    const alarms = [], warnings = [], releases = [];
    Object.entries(activeZones).forEach(([name, z]) => {
      if (z.type === "alarm") alarms.push(name);
      else warnings.push(name);
    });
    Object.keys(releaseZones).forEach((name) => releases.push(name));

    if (alarms.length > 0) addGroup("🚨 אזעקה", alarms, "alarm");
    if (warnings.length > 0) addGroup("⚠️ התרעה", warnings, "warning");
    if (releases.length > 0) addGroup("✓ שחרור", releases, "release");

    if (alarms.length === 0 && warnings.length === 0 && releases.length === 0) {
      $alertsContent.innerHTML = '<div class="alerts-empty-msg">אין התראות פעילות</div>';
    }

    if (alertsListCollapsed) {
      $alertsBody.style.display = "none";
    }
  }

  function addGroup(title, cities, type) {
    const h = document.createElement("div");
    h.className = `alerts-group-header alerts-group-${type}`;
    h.textContent = `${title} (${cities.length})`;
    $alertsContent.appendChild(h);

    cities.forEach((name) => {
      const el = document.createElement("div");
      el.className = `alert-item alert-item-${type}`;
      const dotColor = type === "alarm" ? "#ef4444" : type === "warning" ? "#f59e0b" : "#22c55e";
      el.innerHTML = `<div class="alert-item-dot" style="background:${dotColor}"></div>
        <div class="alert-item-info"><div class="alert-item-name">${name}</div></div>`;
      el.addEventListener("click", () => {
        const zone = activeZones[name] || releaseZones[name];
        if (zone && zone.layer) {
          if (zone.layer.getLatLng) {
            map.panTo(zone.layer.getLatLng());
          } else if (zone.layer.getBounds) {
            map.fitBounds(zone.layer.getBounds(), { padding: [40, 40] });
          }
        }
      });
      $alertsContent.appendChild(el);
    });
  }

  // ══════════════════════════════════════════════
  // TOGGLE
  // ══════════════════════════════════════════════
  function setAlertsListOpen(open) {
    alertsListCollapsed = !open;
    $alertsBody.style.display = open ? "" : "none";
    $toggleBtn.textContent = open ? "▾" : "▴";
  }

  // ══════════════════════════════════════════════
  // SOUND (with cooldown to prevent rapid-fire)
  // ══════════════════════════════════════════════
  let lastSoundTime = 0;
  const SOUND_COOLDOWN = 10000; // 10 seconds minimum between sounds

  function canPlaySound() {
    const now = Date.now();
    if (now - lastSoundTime < SOUND_COOLDOWN) return false;
    lastSoundTime = now;
    return true;
  }

  function playAlertSound(type) {
    if (!canPlaySound()) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === "alarm") {
        osc.type = "sawtooth";
        for (let i = 0; i < 6; i++) {
          osc.frequency.linearRampToValueAtTime(i % 2 === 0 ? 500 : 900, ctx.currentTime + i * 0.5);
        }
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 2.5);
        osc.start(); osc.stop(ctx.currentTime + 2.5);
      } else {
        osc.type = "sine";
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
        osc.start(); osc.stop(ctx.currentTime + 1.5);
      }
    } catch (e) {}
  }

  function playReleaseSound() {
    if (!canPlaySound()) return;
    try {
      const audio = new Audio("/release-sound.mp3");
      audio.volume = 0.5;
      audio.play().catch(() => {});
    } catch (e) {}
  }
  function sendNotification(data, type) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const cities = data.cities.map((c) => c.name);
    if (!isHomeCityMatch(cities)) return;

    try {
      new Notification(type === "alarm" ? "🚨 צבע אדום!" : "⚠️ התרעה", {
        body: cities.join(", "),
        icon: "/icon-192.png",
        tag: "rocket-alert-" + Date.now(),
        renotify: true,
        requireInteraction: true,
        vibrate: [500, 200, 500],
      });
    } catch (e) {}
  }

  async function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    try {
      const perm = await Notification.requestPermission();
      updateNotifStatus(perm);
      if (perm === "denied") {
        alert("ההתראות חסומות.\n\nלחץ על 🔒 ליד הכתובת → Notifications → Allow → רענן");
      }
    } catch (e) {}
  }

  function updateNotifStatus(perm) {
    const $btn = $("btn-enable-notif");
    if (perm === "granted") {
      $notifStatus.textContent = "מופעל ✓";
      $notifStatus.style.color = "var(--accent-green)";
      $btn.textContent = "מופעל"; $btn.disabled = true; $btn.style.opacity = "0.5";
    } else if (perm === "denied") {
      $notifStatus.textContent = "נחסם — אפס בהגדרות הדפדפן";
      $notifStatus.style.color = "var(--accent-amber)";
    } else {
      $notifStatus.textContent = "לא מופעל";
    }
  }

  // ══════════════════════════════════════════════
  // CONNECTION
  // ══════════════════════════════════════════════
  function initSocket() {
    socket = io({ reconnection: true, reconnectionDelay: 1000, transports: ["websocket", "polling"] });
    socket.on("connect", () => { showConn("מחובר", "connected"); setTimeout(hideConn, 2500); });
    socket.on("disconnect", () => showConn("מנותק...", "disconnected"));
    socket.on("alert", handleAlert);
    socket.on("release", handleRelease);

    // Reconnect when tab becomes visible again (phone sleep, tab switch)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (!socket.connected) {
          console.log("[WS] Tab visible — reconnecting...");
          socket.connect();
        }
        // Always fetch latest state when returning
        fetchLastAlert();
      }
    });
  }

  function showConn(text, cls) { $connText.textContent = text; $connIndicator.className = `visible ${cls}`; }
  function hideConn() { $connIndicator.classList.remove("visible"); }

  // ══════════════════════════════════════════════
  // SETTINGS
  // ══════════════════════════════════════════════
  function openSettings() { $settingsPanel.className = "panel-visible"; }
  function closeSettings() { $settingsPanel.className = "panel-hidden"; }

  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      const config = await res.json();

      // null = never set → use default. "" = explicitly chose "no home city"
      const saved = localStorage.getItem("homeCity");
      if (saved === null) {
        homeCity = config.defaultCity;
      } else {
        homeCity = saved; // can be "" which means "all cities"
      }

      $selectCity.innerHTML = '<option value="">ללא עיר בית (כל הארץ)</option>';
      (config.cityList || []).forEach((city) => {
        const opt = document.createElement("option");
        opt.value = city; opt.textContent = city;
        if (city === homeCity) opt.selected = true;
        $selectCity.appendChild(opt);
      });

      console.log(`[CONFIG] Home city: "${homeCity || "(הכל)"}""`);
    } catch (e) {}

    isMuted = localStorage.getItem("muted") === "true";
    $("toggle-mute").checked = isMuted;
    if ("Notification" in window) updateNotifStatus(Notification.permission);
  }

  async function fetchLastAlert() {
    try {
      const res = await fetch("/api/last-alert");
      const data = await res.json();
      if (Array.isArray(data)) {
        // New format: array of alerts grouped by type
        data.forEach((alert) => { if (alert && alert.cities) handleAlert(alert); });
      } else if (data && data.cities) {
        // Legacy format
        handleAlert(data);
      }
    } catch (e) {}
  }

  // ══════════════════════════════════════════════
  // TEST
  // ══════════════════════════════════════════════
  function triggerTestAlert() {
    // גל 1: ירי רקטות — צפון (0s)
    handleAlert({
      id: "test-1", cat: "1", type: "alarm", title: "ירי רקטות וטילים",
      cities: [
        { name: "קריית שמונה", coords: { lat: 33.2082, lng: 35.5704 } },
        { name: "נהריה", coords: { lat: 33.0048, lng: 35.0963 } },
        { name: "צפת", coords: { lat: 32.9658, lng: 35.4983 } },
        { name: "כרמיאל", coords: { lat: 32.9186, lng: 35.3043 } },
        { name: "עכו", coords: { lat: 32.928, lng: 35.0764 } },
        { name: "מעלות תרשיחא", coords: { lat: 33.0167, lng: 35.2718 } },
      ],
    });

    // גל 2: כטב"מ — חיפה והקריות (3s)
    setTimeout(() => {
      handleAlert({
        id: "test-2", cat: "2", type: "alarm", title: "חדירת כלי טיס עוין",
        cities: [
          { name: "חיפה", coords: { lat: 32.794, lng: 34.9896 } },
          { name: "טירת כרמל", coords: { lat: 32.7601, lng: 34.9718 } },
          { name: "נשר", coords: { lat: 32.7714, lng: 35.0396 } },
          { name: "קריית אתא", coords: { lat: 32.8046, lng: 35.1068 } },
          { name: "קריית ביאליק", coords: { lat: 32.8319, lng: 35.0851 } },
          { name: "קריית מוצקין", coords: { lat: 32.8391, lng: 35.0729 } },
        ],
      });
    }, 3000);

    // גל 3: ירי רקטות — מרכז (6s)
    setTimeout(() => {
      handleAlert({
        id: "test-3", cat: "1", type: "alarm", title: "ירי רקטות וטילים",
        cities: [
          { name: "חדרה", coords: { lat: 32.4341, lng: 34.9196 } },
          { name: "נתניה", coords: { lat: 32.3215, lng: 34.8532 } },
          { name: "הרצליה", coords: { lat: 32.1629, lng: 34.8441 } },
          { name: "רעננה", coords: { lat: 32.1836, lng: 34.8708 } },
          { name: "כפר סבא", coords: { lat: 32.1751, lng: 34.9066 } },
          { name: "הוד השרון", coords: { lat: 32.1500, lng: 34.8900 } },
          { name: "פתח תקווה", coords: { lat: 32.0841, lng: 34.8878 } },
        ],
      });
    }, 6000);

    // גל 4: warning — דרום (9s)
    setTimeout(() => {
      handleAlert({
        id: "test-4", cat: "4", type: "warning", title: "חשש לירי בדקות הקרובות",
        cities: [
          { name: "אשדוד", coords: { lat: 31.8, lng: 34.65 } },
          { name: "אשקלון", coords: { lat: 31.6688, lng: 34.5743 } },
          { name: "באר שבע", coords: { lat: 31.253, lng: 34.7915 } },
          { name: "שדרות", coords: { lat: 31.5262, lng: 34.595 } },
          { name: "נתיבות", coords: { lat: 31.4204, lng: 34.5888 } },
        ],
      });
    }, 9000);

    // שחרור צפון (15s)
    setTimeout(() => {
      handleRelease({
        cities: [
          { name: "קריית שמונה", coords: { lat: 33.2082, lng: 35.5704 } },
          { name: "נהריה", coords: { lat: 33.0048, lng: 35.0963 } },
          { name: "צפת", coords: { lat: 32.9658, lng: 35.4983 } },
          { name: "כרמיאל", coords: { lat: 32.9186, lng: 35.3043 } },
          { name: "עכו", coords: { lat: 32.928, lng: 35.0764 } },
          { name: "מעלות תרשיחא", coords: { lat: 33.0167, lng: 35.2718 } },
        ],
      });
    }, 15000);

    // שחרור הכל (22s)
    setTimeout(() => {
      handleRelease({
        cities: [
          { name: "חיפה", coords: { lat: 32.794, lng: 34.9896 } },
          { name: "טירת כרמל", coords: { lat: 32.7601, lng: 34.9718 } },
          { name: "נשר", coords: { lat: 32.7714, lng: 35.0396 } },
          { name: "קריית אתא", coords: { lat: 32.8046, lng: 35.1068 } },
          { name: "קריית ביאליק", coords: { lat: 32.8319, lng: 35.0851 } },
          { name: "קריית מוצקין", coords: { lat: 32.8391, lng: 35.0729 } },
          { name: "חדרה", coords: { lat: 32.4341, lng: 34.9196 } },
          { name: "נתניה", coords: { lat: 32.3215, lng: 34.8532 } },
          { name: "הרצליה", coords: { lat: 32.1629, lng: 34.8441 } },
          { name: "רעננה", coords: { lat: 32.1836, lng: 34.8708 } },
          { name: "כפר סבא", coords: { lat: 32.1751, lng: 34.9066 } },
          { name: "הוד השרון", coords: { lat: 32.1500, lng: 34.8900 } },
          { name: "פתח תקווה", coords: { lat: 32.0841, lng: 34.8878 } },
          { name: "אשדוד", coords: { lat: 31.8, lng: 34.65 } },
          { name: "אשקלון", coords: { lat: 31.6688, lng: 34.5743 } },
          { name: "באר שבע", coords: { lat: 31.253, lng: 34.7915 } },
          { name: "שדרות", coords: { lat: 31.5262, lng: 34.595 } },
          { name: "נתיבות", coords: { lat: 31.4204, lng: 34.5888 } },
        ],
      });
    }, 22000);
  }

  // ══════════════════════════════════════════════
  // EVENTS & BOOT
  // ══════════════════════════════════════════════
  function bindEvents() {
    $("btn-settings").addEventListener("click", openSettings);
    $("btn-close-settings").addEventListener("click", closeSettings);
    document.querySelector(".panel-backdrop").addEventListener("click", closeSettings);

    $toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setAlertsListOpen(alertsListCollapsed);
    });

    $("btn-enable-notif").addEventListener("click", requestNotificationPermission);
    $("btn-test-alert").addEventListener("click", triggerTestAlert);

    $selectCity.addEventListener("change", (e) => {
      homeCity = e.target.value;
      localStorage.setItem("homeCity", homeCity);
    });

    $("toggle-mute").addEventListener("change", (e) => {
      isMuted = e.target.checked;
      localStorage.setItem("muted", isMuted);
    });

    $("btn-theme").addEventListener("click", () => {
      applyTheme(!isDarkMode);
    });
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  async function init() {
    initMap();
    initSocket();
    bindEvents();
    await loadConfig();
    await loadGeoJSON();
    registerServiceWorker();
    fetchLastAlert();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
