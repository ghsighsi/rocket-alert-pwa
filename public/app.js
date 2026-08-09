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

  // ── Custom polygons: { triggerCity → [{ displayName, coordinates }] } ──
  // כשמגיעה התרעה/שחרור לעיר ה-trigger, הפוליגון המותאם מופעל גם הוא
  const CUSTOM_POLYGONS = {
    "איירפורט סיטי": [
      {
        displayName: 'נתב"ג',
        coordinates: [
          [34.90071766961756, 32.020178252273865],
          [34.85422519379509, 32.01293123374492],
          [34.85466387692151, 32.01063751324706],
          [34.86080561486318, 32.00952146655804],
          [34.86811991034128, 31.99482970569079],
          [34.87725650496637, 31.99712332732787],
          [34.882884619135154, 31.994706078662404],
          [34.89128952142502, 31.98714416750518],
          [34.899838185956185, 31.987208502817396],
          [34.902542005295004, 31.98596883919295],
          [34.9051704272058, 31.996567448059224],
          [34.900863777018856, 32.02024014664627],
          [34.90071766961756, 32.020178252273865],
        ],
      },
    ],
  };

  // Build lookup: displayName → GeoJSON feature (used by findGeoFeature)
  const customPolygonFeatures = {};
  Object.values(CUSTOM_POLYGONS).forEach((polyList) => {
    polyList.forEach((poly) => {
      const ring = [...poly.coordinates, poly.coordinates[0]]; // close the ring
      customPolygonFeatures[poly.displayName] = {
        type: "Feature",
        properties: { _displayName: poly.displayName },
        geometry: { type: "Polygon", coordinates: [ring] },
      };
    });
  });

  // ── State ──
  let map, socket;
  let activeZones = {};     // { cityName: { layer, pinMarker, timeoutId, type } }
  let releaseZones = {};    // { cityName: { layer, pinMarker, timeoutId } }
  let homeCity = "";
  let isMuted = false;
  let locationEnabled = false;
  let locationWatchId = null;
  let currentLocationCity = null;
  let cityCoordsList = {}; // { cityName: [lat, lng] } — נטען מ-/api/city-coords
  let locationMarker = null; // Leaflet marker for current position
  let alertsListCollapsed = false;
  let isDarkMode = false;   // Light by default (tzevaadom-style)
  let darkTileLayer = null;
  let lightTileLayer = null;

  // ── Sub-area grouping ──
  // Sub-areas (e.g. "תל אביב - מרכז העיר") are always dots.
  // When >50% of a parent city's sub-areas are active → draw the parent city polygon.
  let citySubAreaTotals = {}; // { parentCity: totalCount } — built from /api/config
  let citySubAreaNames = {};  // { parentCity: [subAreaName, ...] } — for direct-parent expansion
  let subAreaGroups = {};     // { parentCity: Set<activeSubAreaName> }
  let subAreaPolygons = {};   // { parentCity: { layer, type } } — parent polygon when threshold met

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

    // ── Manual aliases: GeoJSON name → common API name ──
    // When the GeoJSON uses a longer official name but the API sends a shorter one
    const GEO_ALIASES = {
      "תל אביב יפו": "תל אביב",
      "באר שבע":     "באר שבע",   // already exact, no-op safety
      "פתח תקווה":   "פתח תקוה",  // spelling variant
    };
    Object.entries(GEO_ALIASES).forEach(([geoName, apiName]) => {
      const geoKey = normalizeName(geoName);
      const aliasKey = normalizeName(apiName);
      if (geoIndex[geoKey] && !geoIndex[aliasKey]) {
        geoIndex[aliasKey] = geoIndex[geoKey];
      }
    });

    console.log(`[GEO] Indexed ${Object.keys(geoIndex).length} city names`);
  }

  // ── Sub-area helpers ──────────────────────────────────────
  // "תל אביב - מרכז העיר" → "תל אביב", otherwise null
  function extractParentCity(cityName) {
    const idx = cityName.indexOf(" - ");
    if (idx > 0) return cityName.substring(0, idx).trim();
    return null;
  }

  // True if this city is a sub-area of a known parent (from citySubAreaTotals)
  function isSubArea(cityName) {
    const parent = extractParentCity(cityName);
    return parent !== null && (citySubAreaTotals[parent] || 0) > 0;
  }

  // True if this sub-area name refers to a commercial/industrial zone
  // (excluded from dot-expansion when a direct parent-city alert arrives)
  const COMMERCIAL_KEYWORDS = [
    "אזור תעשייה", "אזור תעשיה", "תעשייה", "תעשיה",
    "אזור מסחרי", "מסחרי", "אזור עסקים", "עסקים",
    "בית מלאכה", "מלאכה", "אזור תעסוקה", "תעסוקה",
    "בתי מלאכה",
  ];
  function isCommercialSubArea(cityName) {
    const idx = cityName.indexOf(" - ");
    if (idx < 0) return false;
    const subPart = cityName.substring(idx + 3); // החלק אחרי " - "
    return COMMERCIAL_KEYWORDS.some((kw) => subPart.includes(kw));
  }

  // Draw just the parent city polygon (without a dot)
  function drawParentPolygon(parentCity, type) {
    const style = COLORS[type] || COLORS.alarm;
    const geoFeature = findGeoFeature(parentCity);
    if (!geoFeature || !geoFeature.geometry) return null;
    // Verify the found feature actually matches this parent city name —
    // prevent forward-prefix match from stealing a different city's polygon
    // e.g. "מודיעין" must not get "מודיעין מכבים רעות" polygon
    const featureName = normalizeName(geoFeature.properties._displayName || "");
    const parentNorm = normalizeName(parentCity);
    if (featureName && featureName !== parentNorm && !featureName.startsWith(parentNorm + " ") && !parentNorm.startsWith(featureName + " ")) return null;
    try {
      return L.geoJSON(geoFeature, {
        style: { color: style.stroke, fillColor: style.fill, fillOpacity: style.fillOpacity, weight: 2 },
      }).addTo(map);
    } catch (e) { return null; }
  }

  // Show/hide the parent polygon based on how many sub-areas are active (>2/3 threshold)
  function updateParentPolygon(parentCity) {
    const active = subAreaGroups[parentCity];
    const total = citySubAreaTotals[parentCity] || 0;
    const activeCount = active ? active.size : 0;
    const shouldShow = total > 0 && activeCount >= total * 2 / 3;

    // Determine type by majority — alarm only if MORE THAN HALF of active sub-areas are alarm
    let dominantType = "warning";
    if (active) {
      let alarmCount = 0;
      active.forEach((name) => {
        if (activeZones[name] && activeZones[name].type === "alarm") alarmCount++;
      });
      if (alarmCount > activeCount / 2) dominantType = "alarm";
    }

    const existing = subAreaPolygons[parentCity];

    if (shouldShow) {
      if (!existing || existing.type !== dominantType) {
        if (existing && existing.layer) map.removeLayer(existing.layer);
        const layer = drawParentPolygon(parentCity, dominantType);
        if (layer) subAreaPolygons[parentCity] = { layer, type: dominantType };
        else delete subAreaPolygons[parentCity];
      }
    } else {
      if (existing && existing.layer) map.removeLayer(existing.layer);
      delete subAreaPolygons[parentCity];
    }
  }

  // Returns center {lat, lng, radius} of a custom polygon by displayName
  function customPolyCenter(displayName) {
    const poly = Object.values(CUSTOM_POLYGONS).flat().find((p) => p.displayName === displayName);
    if (!poly) return null;
    const coords = poly.coordinates;
    const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    return { lat, lng, radius: 3000 };
  }

  function findGeoFeature(cityName) {
    // Check custom polygon features first
    if (customPolygonFeatures[cityName]) return customPolygonFeatures[cityName];

    const key = normalizeName(cityName);

    // 1. Exact match
    if (geoIndex[key]) return geoIndex[key];

    // 2. Aliases built at index time handle "תל אביב" → "תל אביב יפו" etc.
    //    No forward-prefix match here — it caused false positives like
    //    "מודיעין" stealing "מודיעין מכבים רעות" polygon.

    // 3. Prefix matching — ONLY for real sub-areas that contain " - " in original name
    //    e.g. "תל אביב - מרכז העיר" → try "תל אביב יפו", "תל אביב"
    //    Regular multi-word cities like "באר שבע" / "קריית שמונה" → steps 1-2 only
    if (!cityName.includes(" - ")) return null;

    const parts = key.split(" ");
    for (let len = parts.length - 1; len >= 1; len--) {
      const prefix = parts.slice(0, len).join(" ");
      if (prefix.length < 3) continue;

      // Direct prefix match
      if (geoIndex[prefix]) return geoIndex[prefix];

      // Try prefix + suffix ("תל אביב" → "תל אביב יפו")
      const geoKeys = Object.keys(geoIndex);
      for (const gk of geoKeys) {
        if (gk.startsWith(prefix + " ") || gk === prefix) {
          return geoIndex[gk];
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

    // Commercial/industrial sub-areas → dot only, never a polygon
    if (isCommercialSubArea(cityObj.name)) {
      return { layer: null, pinMarker: createPinMarker(latlng, type) };
    }

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

    // Always draw a dot — even when a polygon exists (so cities with polygons still show a center pin)
    pinMarker = createPinMarker(latlng, type);

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

    // Always draw a dot (even when polygon exists)
    pinMarker = createPinMarker(latlng, "release");

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

      const parent = extractParentCity(cityObj.name);
      const isSub = parent && (citySubAreaTotals[parent] || 0) > 0;

      // ── Direct parent-city expansion ──
      // כשה-API שולח "ירושלים" ישירות (לא sub-area) ויש לה sub-areas ידועים —
      // הרחב אותה לכל ה-sub-areas עם נקודות, ותן ל-50% threshold לצייר את הפוליגון
      if (!isSub && citySubAreaNames[cityObj.name] && citySubAreaNames[cityObj.name].length > 0) {
        const subCoords = cityObj.coords; // כל ה-sub-areas יקבלו נקודה בקואורדינטות של העיר האם
        citySubAreaNames[cityObj.name].forEach((subName) => {
          if (activeZones[subName]) return; // כבר פעיל
          const pinMarker = subCoords && subCoords.lat && subCoords.lng
            ? createPinMarker([subCoords.lat, subCoords.lng], type)
            : null;
          activeZones[subName] = { layer: null, pinMarker, timeoutId: null, type };
          if (!subAreaGroups[cityObj.name]) subAreaGroups[cityObj.name] = new Set();
          subAreaGroups[cityObj.name].add(subName);
        });
        updateParentPolygon(cityObj.name);
        newCount++;
        return; // אל תצייר את העיר האם ישירות
      }

      let layer = null, pinMarker = null;
      if (isSub) {
        // Sub-areas → always a dot, never a polygon
        if (cityObj.coords && cityObj.coords.lat && cityObj.coords.lng) {
          pinMarker = createPinMarker([cityObj.coords.lat, cityObj.coords.lng], type);
        }
        if (!subAreaGroups[parent]) subAreaGroups[parent] = new Set();
        subAreaGroups[parent].add(cityObj.name);
      } else {
        ({ layer, pinMarker } = drawZone(cityObj, type));
      }

      activeZones[cityObj.name] = { layer, pinMarker, timeoutId: null, type };
      newCount++;

      // Update parent city polygon if this is a sub-area
      if (isSub) updateParentPolygon(parent);

      // Draw linked custom polygons (e.g. נתב"ג when כפר טרומן fires)
      // Custom polygons are manually curated — skip distance check, always draw directly
      (CUSTOM_POLYGONS[cityObj.name] || []).forEach((poly) => {
        const existingCustom = activeZones[poly.displayName];
        // Skip only if already shown at same or higher severity (alarm beats warning)
        if (existingCustom && !(existingCustom.type === "warning" && type === "alarm")) return;
        // Remove old layer if upgrading warning → alarm
        if (existingCustom) {
          if (existingCustom.layer) map.removeLayer(existingCustom.layer);
          if (existingCustom.pinMarker) map.removeLayer(existingCustom.pinMarker);
        }
        const style = COLORS[type] || COLORS.alarm;
        const geoFeature = customPolygonFeatures[poly.displayName];
        let cl = null, cp = null;
        if (geoFeature) {
          try {
            cl = L.geoJSON(geoFeature, {
              style: { color: style.stroke, fillColor: style.fill, fillOpacity: style.fillOpacity, weight: 2 },
            }).addTo(map);
          } catch (e) { cl = null; }
        }
        const center = customPolyCenter(poly.displayName);
        if (center) cp = createPinMarker([center.lat, center.lng], type);
        activeZones[poly.displayName] = { layer: cl, pinMarker: cp, timeoutId: null, type, isCustom: true };
      });
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

  // Shared helper: check if any city name matches homeCity (or current location)
  function isHomeCityMatch(cityNames) {
    const effective = locationEnabled && currentLocationCity ? currentLocationCity : homeCity;
    if (!effective) return true;
    const homeNorm = normalizeName(effective);
    const homeWords = homeNorm.split(" ");
    const match = cityNames.some((c) => {
      const cityNorm = normalizeName(c);
      if (cityNorm === homeNorm) return true;
      if (cityNorm.startsWith(homeNorm + " ") || homeNorm.startsWith(cityNorm + " ")) return true;
      const cityWords = cityNorm.split(" ");
      if (homeWords[0].length >= 4 && homeWords[0] === cityWords[0]) return true;
      if (homeWords.length >= 2 && cityWords.length >= 2 &&
          homeWords[0] === cityWords[0] && homeWords[1] === cityWords[1]) return true;
      return false;
    });
    return match;
  }

  function handleRelease(data) {
    let releasedCount = 0;
    const releasedNames = [];

    if (data && data.cities && data.cities.length > 0) {
      data.cities.forEach((city) => {
        const name = typeof city === "string" ? city : city.name;
        const releaseCoords = city.coords || null;

        // ── Direct parent-city release expansion ──
        // כשמגיע שחרור על "ירושלים" ישיר — שחרר את כל ה-sub-areas שלה
        if (!activeZones[name] && citySubAreaNames[name] && subAreaGroups[name]) {
          citySubAreaNames[name].forEach((subName) => {
            if (!activeZones[subName]) return;
            const zone = activeZones[subName];
            let coords = releaseCoords;
            if (!coords && zone.pinMarker) {
              const ll = zone.pinMarker.getLatLng();
              coords = { lat: ll.lat, lng: ll.lng };
            }
            removeZone(subName);
            subAreaGroups[name] && subAreaGroups[name].delete(subName);
            if (coords) drawReleaseZone(subName, coords);
            releasedNames.push(subName);
            releasedCount++;
          });
          if (subAreaGroups[name] && subAreaGroups[name].size === 0) delete subAreaGroups[name];
          updateParentPolygon(name);
          return;
        }

        const zone = activeZones[name];
        if (!zone) return;

        let coords = city.coords || null;
        if (zone.pinMarker) {
          const ll = zone.pinMarker.getLatLng();
          coords = coords || { lat: ll.lat, lng: ll.lng };
        }

        removeZone(name);

        // Update sub-area group for parent polygon tracking
        const parent = extractParentCity(name);
        if (parent && subAreaGroups[parent]) {
          subAreaGroups[parent].delete(name);
          if (subAreaGroups[parent].size === 0) delete subAreaGroups[parent];
        }
        if (parent) updateParentPolygon(parent);

        if (coords) drawReleaseZone(name, coords);
        releasedNames.push(name);
        releasedCount++;

        // Release linked custom polygons (e.g. נתב"ג when כפר טרומן is released)
        (CUSTOM_POLYGONS[name] || []).forEach((poly) => {
          if (!activeZones[poly.displayName]) return;
          removeZone(poly.displayName);
          const center = customPolyCenter(poly.displayName);
          if (center) drawReleaseZone(poly.displayName, center);
        });
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
      // Clear all parent polygons
      Object.values(subAreaPolygons).forEach((p) => { if (p.layer) map.removeLayer(p.layer); });
      subAreaPolygons = {};
      subAreaGroups = {};
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

    // מיקום נוכחי — מופיע בראש הרשימה כשמיקום פעיל
    if (locationEnabled && currentLocationCity) {
      const locEl = document.createElement("div");
      locEl.className = "location-indicator";
      locEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg><span>מיקום נוכחי: ${sanitizeName(currentLocationCity)}</span>`;
      $alertsContent.appendChild(locEl);
    }

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
      $alertsContent.innerHTML += '<div class="alerts-empty-msg">אין התראות פעילות</div>';
    }

    if (alertsListCollapsed) {
      $alertsBody.style.display = "none";
    }
  }

  function sanitizeName(name) {
    return name.replace(/\u05F3/g, "'").replace(/\u05F4/g, '"');
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
        <div class="alert-item-info"><div class="alert-item-name">${sanitizeName(name)}</div></div>`;
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
    let isFirstConnect = true;
    socket.on("connect", () => {
      showConn("מחובר", "connected");
      setTimeout(hideConn, 2500);
      // On reconnect (not first load) — always sync state from server
      if (!isFirstConnect) {
        fetchLastAlert();
      }
      isFirstConnect = false;
    });
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
        opt.value = city;
        // Replace Hebrew geresh ׳ (U+05F3) and gershayim ״ (U+05F4) with ASCII equivalents
        opt.textContent = city.replace(/\u05F3/g, "'").replace(/\u05F4/g, '"');
        if (city === homeCity) opt.selected = true;
        $selectCity.appendChild(opt);
      });

      // Build sub-area totals + name lists so we know when >2/3 threshold is reached
      // and can expand a direct parent-city alert into its sub-areas
      citySubAreaTotals = {};
      citySubAreaNames = {};
      (config.cityList || []).forEach((city) => {
        const parent = extractParentCity(city);
        if (parent) {
          citySubAreaTotals[parent] = (citySubAreaTotals[parent] || 0) + 1;
          // Exclude commercial/industrial sub-areas from expansion list —
          // אזור תעשייה, אזור מסחרי וכו' לא מציגים כנקודות בפיצוץ ישיר של עיר האם
          if (!isCommercialSubArea(city)) {
            if (!citySubAreaNames[parent]) citySubAreaNames[parent] = [];
            citySubAreaNames[parent].push(city);
          }
        }
      });
      console.log(`[CONFIG] Sub-area parents: ${Object.keys(citySubAreaTotals).length} cities`);

      // טען קואורדינטות ערים לחישוב מיקום קרוב
      try {
        const cRes = await fetch("/api/city-coords");
        if (cRes.ok) {
          cityCoordsList = await cRes.json();
          console.log(`[LOC] Loaded ${Object.keys(cityCoordsList).length} city coords`);
        }
      } catch (e) {}

      console.log(`[CONFIG] Home city: "${homeCity || "(הכל)"}""`);
    } catch (e) {}

    isMuted = localStorage.getItem("muted") === "true";
    $("toggle-mute").checked = isMuted;
    if ("Notification" in window) updateNotifStatus(Notification.permission);

    // שחזר מצב מיקום
    if (localStorage.getItem("locationEnabled") === "true") {
      startLocationWatch();
    } else {
      updateLocationStatus("off");
    }
  }

  async function fetchLastAlert() {
    try {
      const res = await fetch("/api/last-alert");
      const data = await res.json();

      // Build set of city names the server considers active
      const serverActive = new Set();
      const alerts = Array.isArray(data) ? data : (data && data.cities ? [data] : []);
      alerts.forEach((alert) => {
        if (alert && alert.cities) {
          alert.cities.forEach((c) => serverActive.add(c.name || c));
        }
      });

      // Remove zones that are no longer active on the server
      Object.keys(activeZones).forEach((name) => {
        if (!serverActive.has(name) && !activeZones[name].isCustom) {
          removeZone(name);
          // Clean up sub-area groups
          const parent = extractParentCity(name);
          if (parent && subAreaGroups[parent]) {
            subAreaGroups[parent].delete(name);
            if (subAreaGroups[parent].size === 0) delete subAreaGroups[parent];
            updateParentPolygon(parent);
          }
        }
      });

      // Add any new active cities from server
      alerts.forEach((alert) => { if (alert && alert.cities) handleAlert(alert); });
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

    // גל 5: warning — מודיעין (12s)
    setTimeout(() => {
      handleAlert({
        id: "test-5", cat: "4", type: "warning", title: "חשש לירי בדקות הקרובות",
        cities: [
          { name: "מודיעין - מכבים רעות", coords: { lat: 31.8969, lng: 35.0104 } },
        ],
      });
    }, 12000);

    // גל 6: אזעקה — כפר טרומן (ונתב"ג) (15s)
    setTimeout(() => {
      handleAlert({
        id: "test-6", cat: "1", type: "alarm", title: "ירי רקטות וטילים",
        cities: [
          { name: "כפר טרומן", coords: { lat: 31.979345020271253, lng: 34.92480720924149 } },
        ],
      });
    }, 15000);

    // שחרור צפון (21s)
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
    }, 21000);

    // שחרור הכל (28s)
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
          { name: "מודיעין - מכבים רעות", coords: { lat: 31.8969, lng: 35.0104 } },
          { name: "כפר טרומן", coords: { lat: 31.979345020271253, lng: 34.92480720924149 } },
        ],
      });
    }, 28000);
  }

  // ══════════════════════════════════════════════
  // LOCATION
  // ══════════════════════════════════════════════
  function findNearestCity(lat, lng) {
    let nearest = null;
    let minDist = Infinity;
    Object.entries(cityCoordsList).forEach(([name, coords]) => {
      // Skip sub-areas for nearest-city calculation
      if (name.includes(" - ")) return;
      const d = distanceBetween(lat, lng, coords[0], coords[1]);
      if (d < minDist) { minDist = d; nearest = name; }
    });
    return nearest;
  }

  function updateLocationStatus(state, cityName) {
    const $status = $("location-status");
    const $btn = $("btn-enable-location");
    const $cityGroup = $("setting-group-city");
    if (state === "active") {
      $status.textContent = cityName ? `פעיל — ${sanitizeName(cityName)}` : "מאתר...";
      $status.style.color = "var(--accent-green, #22c55e)";
      $btn.textContent = "כבה";
      if ($cityGroup) { $cityGroup.style.opacity = "0.4"; $cityGroup.style.pointerEvents = "none"; }
    } else if (state === "denied") {
      $status.textContent = "נחסם — אפס בהגדרות הדפדפן";
      $status.style.color = "var(--accent-amber, #f59e0b)";
      $btn.textContent = "הפעל";
      if ($cityGroup) { $cityGroup.style.opacity = "1"; $cityGroup.style.pointerEvents = ""; }
    } else {
      $status.textContent = "לא מופעל";
      $status.style.color = "";
      $btn.textContent = "הפעל";
      if ($cityGroup) { $cityGroup.style.opacity = "1"; $cityGroup.style.pointerEvents = ""; }
    }
  }

  function startLocationWatch() {
    if (!("geolocation" in navigator)) {
      updateLocationStatus("denied");
      return;
    }
    locationEnabled = true;
    localStorage.setItem("locationEnabled", "true");
    updateLocationStatus("active", null);

    // משתמש ב-getCurrentPosition עם interval במקום watchPosition
    // כדי לא לתפוס את ה-GPS ברציפות ולאפשר לאפליקציות אחרות (וויז וכו') לפעול
    function doLocationPoll() {
      if (!locationEnabled) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!locationEnabled) return;
          const { latitude: lat, longitude: lng } = pos.coords;

          // Update blue dot on map
          if (!locationMarker) {
            const icon = L.divIcon({
              className: "",
              html: '<div class="location-dot"></div>',
              iconSize: [16, 16],
              iconAnchor: [8, 8],
            });
            locationMarker = L.marker([lat, lng], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
          } else {
            locationMarker.setLatLng([lat, lng]);
          }

          const nearest = findNearestCity(lat, lng);
          if (nearest !== currentLocationCity) {
            currentLocationCity = nearest;
            updateAlertsList();
          }
          updateLocationStatus("active", nearest);
        },
        (err) => {
          console.warn("[LOC] Error:", err.message);
          if (err.code === 1) { // PERMISSION_DENIED
            stopLocationWatch();
            updateLocationStatus("denied");
          }
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
      );
    }

    // בצע polling כל 30 שניות — מספיק לזהות עיר, לא תופס GPS ברציפות
    doLocationPoll();
    locationWatchId = setInterval(doLocationPoll, 30000);
  }

  function stopLocationWatch() {
    locationEnabled = false;
    currentLocationCity = null;
    localStorage.removeItem("locationEnabled");
    if (locationWatchId !== null) {
      clearInterval(locationWatchId);
      locationWatchId = null;
    }
    if (locationMarker) {
      map.removeLayer(locationMarker);
      locationMarker = null;
    }
    updateLocationStatus("off");
    updateAlertsList();
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
    $("btn-enable-location").addEventListener("click", () => {
      if (locationEnabled) stopLocationWatch();
      else startLocationWatch();
    });
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

    // Periodic sync — every 30s quietly re-fetch server state
    // without clearing the map, just adds any missing active cities
    setInterval(fetchLastAlert, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
