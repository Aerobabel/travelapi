const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PLACE_CACHE_SIZE = 500;

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const coordinateFrom = (place = {}) => {
  const latitude = toNumber(place.latitude ?? place.lat);
  const longitude = toNumber(place.longitude ?? place.lng ?? place.lon);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
};

const haversineMeters = (from, to) => {
  const a = coordinateFrom(from);
  const b = coordinateFrom(to);
  if (!a || !b) return 0;

  const r = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * r * Math.asin(Math.sqrt(h)));
};

const normalizeMode = (mode = "driving") => {
  const clean = String(mode || "").toLowerCase();
  if (["walk", "walking", "foot"].includes(clean)) return "walking";
  if (["transit", "public", "metro", "bus", "train"].includes(clean)) return "transit";
  if (["taxi", "car", "drive", "driving"].includes(clean)) return "driving";
  return "driving";
};

const estimatedSpeedMetersPerSecond = (mode) => {
  if (mode === "walking") return 1.25;
  if (mode === "transit") return 6.2;
  return 8.3;
};

export const chooseRouteMode = (from, to) => {
  const meters = haversineMeters(from, to);
  if (meters > 0 && meters <= 1400) return "walking";
  if (meters > 0 && meters <= 8500) return "transit";
  return "driving";
};

export const estimateRouteLeg = ({ from, to, mode = "driving" }) => {
  const normalizedMode = normalizeMode(mode);
  const distanceMeters = haversineMeters(from, to);
  const durationSeconds = Math.max(
    60,
    Math.round(distanceMeters / estimatedSpeedMetersPerSecond(normalizedMode))
  );

  return {
    provider: "heuristic",
    mode: normalizedMode,
    distanceMeters,
    durationSeconds,
    distanceText: formatDistance(distanceMeters),
    durationText: formatDuration(durationSeconds),
    geometry: {
      type: "LineString",
      coordinates: [
        [Number(from.longitude), Number(from.latitude)],
        [Number(to.longitude), Number(to.latitude)],
      ],
    },
    confidence: distanceMeters > 0 ? "estimated" : "missing_coordinates",
  };
};

export const formatDistance = (meters = 0) => {
  const n = Math.max(0, Number(meters) || 0);
  if (n < 1000) return `${Math.round(n)} m`;
  return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} km`;
};

export const formatDuration = (seconds = 0) => {
  const minutes = Math.max(1, Math.round((Number(seconds) || 0) / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

const fetchJsonWithTimeout = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Maps provider returned ${res.status}: ${body.slice(0, 160)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const placeCache = new Map();

const setPlaceCache = (key, value) => {
  if (!key) return;
  if (placeCache.size >= MAX_PLACE_CACHE_SIZE) {
    const first = placeCache.keys().next().value;
    placeCache.delete(first);
  }
  placeCache.set(key, value);
};

const googlePhotoUrl = ({ reference, key, maxWidth = 960 }) => {
  if (!reference || !key) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/place/photo");
  url.searchParams.set("maxwidth", String(maxWidth));
  url.searchParams.set("photo_reference", reference);
  url.searchParams.set("key", key);
  return url.toString();
};

const pickNeighborhood = (addressComponents = []) => {
  const preferredTypes = [
    "neighborhood",
    "sublocality",
    "sublocality_level_1",
    "locality",
  ];
  for (const type of preferredTypes) {
    const hit = addressComponents.find((part) => (part.types || []).includes(type));
    if (hit?.long_name) return hit.long_name;
  }
  return null;
};

const normalizeGooglePlace = (raw = {}, key = "") => {
  const loc = raw.geometry?.location || {};
  const latitude = toNumber(loc.lat);
  const longitude = toNumber(loc.lng);
  const photoRef = raw.photos?.[0]?.photo_reference;
  const weekdayText =
    raw.current_opening_hours?.weekday_text ||
    raw.opening_hours?.weekday_text ||
    [];

  return {
    provider: "google_places",
    placeId: raw.place_id || null,
    name: raw.name || null,
    address: raw.formatted_address || raw.vicinity || null,
    latitude,
    longitude,
    rating: toNumber(raw.rating),
    userRatingsTotal: toNumber(raw.user_ratings_total),
    priceLevel: toNumber(raw.price_level),
    businessStatus: raw.business_status || null,
    types: raw.types || [],
    openingHours: Array.isArray(weekdayText) ? weekdayText : [],
    openNow:
      raw.current_opening_hours?.open_now ??
      raw.opening_hours?.open_now ??
      null,
    website: raw.website || null,
    googleMapsUrl: raw.url || (raw.place_id ? `https://www.google.com/maps/place/?q=place_id:${raw.place_id}` : null),
    editorialSummary: raw.editorial_summary?.overview || null,
    neighborhood: pickNeighborhood(raw.address_components || []),
    photoUrl: googlePhotoUrl({ reference: photoRef, key }),
    confidence: raw.place_id ? "provider" : "search_result",
  };
};

async function googlePlaceDetails({ placeId, key, timeoutMs }) {
  if (!placeId) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set(
    "fields",
    [
      "place_id",
      "name",
      "formatted_address",
      "address_components",
      "geometry",
      "rating",
      "user_ratings_total",
      "price_level",
      "opening_hours",
      "current_opening_hours",
      "website",
      "url",
      "photos",
      "business_status",
      "types",
      "editorial_summary",
    ].join(",")
  );
  url.searchParams.set("key", key);

  const payload = await fetchJsonWithTimeout(url.toString(), { timeoutMs });
  if (payload?.status && payload.status !== "OK") {
    throw new Error(`Google place details ${payload.status}: ${payload.error_message || ""}`.trim());
  }
  return normalizeGooglePlace(payload?.result || {}, key);
}

async function googleTextSearchPlace({ query, key, timeoutMs }) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", query);
  url.searchParams.set("key", key);

  const payload = await fetchJsonWithTimeout(url.toString(), { timeoutMs });
  if (payload?.status && !["OK", "ZERO_RESULTS"].includes(payload.status)) {
    throw new Error(`Google text search ${payload.status}: ${payload.error_message || ""}`.trim());
  }

  const first = payload?.results?.[0];
  if (!first) return null;
  if (first.place_id) {
    const detailed = await googlePlaceDetails({ placeId: first.place_id, key, timeoutMs });
    if (detailed) return detailed;
  }
  return normalizeGooglePlace(first, key);
}

async function googleTextSearchPlaces({ query, key, timeoutMs, limit = 8, type = "" }) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", query);
  if (type) url.searchParams.set("type", type);
  url.searchParams.set("key", key);

  const payload = await fetchJsonWithTimeout(url.toString(), { timeoutMs });
  if (payload?.status && !["OK", "ZERO_RESULTS"].includes(payload.status)) {
    throw new Error(`Google text search ${payload.status}: ${payload.error_message || ""}`.trim());
  }

  const rows = Array.isArray(payload?.results) ? payload.results.slice(0, limit) : [];
  const normalized = await Promise.all(
    rows.map(async (row) => {
      if (row.place_id) {
        const detailed = await googlePlaceDetails({ placeId: row.place_id, key, timeoutMs });
        if (detailed) return detailed;
      }
      return normalizeGooglePlace(row, key);
    })
  );
  return normalized.filter(Boolean);
}

const googleMode = (mode) => {
  const normalized = normalizeMode(mode);
  if (normalized === "walking") return "walking";
  if (normalized === "transit") return "transit";
  return "driving";
};

const mapboxProfile = (mode) => {
  const normalized = normalizeMode(mode);
  if (normalized === "walking") return "walking";
  if (normalized === "transit") return "driving-traffic";
  return "driving-traffic";
};

async function geocodeWithGoogle({ query, key, timeoutMs }) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", query);
  url.searchParams.set("key", key);

  const payload = await fetchJsonWithTimeout(url.toString(), { timeoutMs });
  const first = payload?.results?.[0];
  const loc = first?.geometry?.location;
  const latitude = toNumber(loc?.lat);
  const longitude = toNumber(loc?.lng);
  if (latitude === null || longitude === null) return null;

  return {
    provider: "google",
    latitude,
    longitude,
    placeId: first.place_id || null,
    address: first.formatted_address || null,
    types: first.types || [],
    confidence: "provider",
  };
}

async function geocodeWithMapbox({ query, token, timeoutMs }) {
  const encoded = encodeURIComponent(query);
  const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("limit", "1");
  url.searchParams.set("language", "en");

  const payload = await fetchJsonWithTimeout(url.toString(), { timeoutMs });
  const first = payload?.features?.[0];
  const center = first?.center;
  const longitude = toNumber(center?.[0]);
  const latitude = toNumber(center?.[1]);
  if (latitude === null || longitude === null) return null;

  return {
    provider: "mapbox",
    latitude,
    longitude,
    placeId: first.id || null,
    address: first.place_name || null,
    types: first.place_type || [],
    confidence: "provider",
  };
}

async function routeWithGoogle({ from, to, mode, key, timeoutMs }) {
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${from.latitude},${from.longitude}`);
  url.searchParams.set("destination", `${to.latitude},${to.longitude}`);
  url.searchParams.set("mode", googleMode(mode));
  url.searchParams.set("key", key);

  const payload = await fetchJsonWithTimeout(url.toString(), { timeoutMs });
  const route = payload?.routes?.[0];
  const leg = route?.legs?.[0];
  if (!route || !leg) return null;

  return {
    provider: "google",
    mode: normalizeMode(mode),
    distanceMeters: Number(leg.distance?.value) || 0,
    durationSeconds: Number(leg.duration?.value) || 0,
    distanceText: leg.distance?.text || "",
    durationText: leg.duration?.text || "",
    encodedPolyline: route.overview_polyline?.points || null,
    geometry: {
      type: "LineString",
      coordinates: [
        [Number(from.longitude), Number(from.latitude)],
        [Number(to.longitude), Number(to.latitude)],
      ],
    },
    confidence: "provider",
  };
}

async function routeWithMapbox({ from, to, mode, token, timeoutMs }) {
  const profile = mapboxProfile(mode);
  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");

  const payload = await fetchJsonWithTimeout(url.toString(), { timeoutMs });
  const route = payload?.routes?.[0];
  if (!route) return null;

  return {
    provider: "mapbox",
    mode: normalizeMode(mode),
    distanceMeters: Math.round(Number(route.distance) || 0),
    durationSeconds: Math.round(Number(route.duration) || 0),
    distanceText: formatDistance(route.distance),
    durationText: formatDuration(route.duration),
    geometry: route.geometry || {
      type: "LineString",
      coordinates: [
        [Number(from.longitude), Number(from.latitude)],
        [Number(to.longitude), Number(to.latitude)],
      ],
    },
    confidence: "provider",
  };
}

export function createMapsProvider({
  env = process.env,
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const googleKey = env.GOOGLE_MAPS_API_KEY || env.GOOGLE_API_KEY || "";
  const mapboxToken = env.MAPBOX_ACCESS_TOKEN || "";
  const provider = googleKey ? "google" : mapboxToken ? "mapbox" : "heuristic";

  const safeCall = async (fn, fallback = null) => {
    try {
      return await fn();
    } catch (error) {
      logger?.warn?.("[maps]", error?.message || error);
      return fallback;
    }
  };

  return {
    provider,
    hasGeocoding: Boolean(googleKey || mapboxToken),
    hasRouting: Boolean(googleKey || mapboxToken),
    hasPlaces: Boolean(googleKey),

    async geocode(query) {
      const q = String(query || "").trim();
      if (!q) return null;
      if (googleKey) return safeCall(() => geocodeWithGoogle({ query: q, key: googleKey, timeoutMs }));
      if (mapboxToken) return safeCall(() => geocodeWithMapbox({ query: q, token: mapboxToken, timeoutMs }));
      return null;
    },

    async routeLeg({ from, to, mode }) {
      const fromCoord = coordinateFrom(from);
      const toCoord = coordinateFrom(to);
      if (!fromCoord || !toCoord) return null;
      const resolvedMode = normalizeMode(mode || chooseRouteMode(fromCoord, toCoord));

      if (googleKey) {
        const leg = await safeCall(() =>
          routeWithGoogle({ from: fromCoord, to: toCoord, mode: resolvedMode, key: googleKey, timeoutMs })
        );
        if (leg) return leg;
      }

      if (mapboxToken) {
        const leg = await safeCall(() =>
          routeWithMapbox({ from: fromCoord, to: toCoord, mode: resolvedMode, token: mapboxToken, timeoutMs })
        );
        if (leg) return leg;
      }

      return estimateRouteLeg({ from: fromCoord, to: toCoord, mode: resolvedMode });
    },

    async findPlace(query) {
      const q = String(query || "").trim();
      if (!q || !googleKey) return null;
      const cacheKey = `google:${q.toLowerCase()}`;
      if (placeCache.has(cacheKey)) return placeCache.get(cacheKey);

      const place = await safeCall(() =>
        googleTextSearchPlace({ query: q, key: googleKey, timeoutMs })
      );
      if (place) setPlaceCache(cacheKey, place);
      return place;
    },

    async findPlaces(query, { limit = 8, type = "" } = {}) {
      const q = String(query || "").trim();
      if (!q || !googleKey) return [];
      const cacheKey = `google-list:${q.toLowerCase()}:${type}:${limit}`;
      if (placeCache.has(cacheKey)) return placeCache.get(cacheKey);

      const places = await safeCall(
        () => googleTextSearchPlaces({ query: q, key: googleKey, timeoutMs, limit, type }),
        []
      );
      setPlaceCache(cacheKey, places);
      return places;
    },

    async placeDetails(placeId) {
      const id = String(placeId || "").trim();
      if (!id || !googleKey) return null;
      const cacheKey = `google-place-id:${id}`;
      if (placeCache.has(cacheKey)) return placeCache.get(cacheKey);

      const place = await safeCall(() =>
        googlePlaceDetails({ placeId: id, key: googleKey, timeoutMs })
      );
      if (place) setPlaceCache(cacheKey, place);
      return place;
    },
  };
}
