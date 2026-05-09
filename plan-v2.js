import {
  chooseRouteMode,
  estimateRouteLeg,
  formatDistance,
  formatDuration,
} from "./maps.provider.js";

const CITY_CENTERS = {
  amsterdam: { latitude: 52.3676, longitude: 4.9041 },
  athens: { latitude: 37.9838, longitude: 23.7275 },
  barcelona: { latitude: 41.3851, longitude: 2.1734 },
  berlin: { latitude: 52.52, longitude: 13.405 },
  dubai: { latitude: 25.2048, longitude: 55.2708 },
  istanbul: { latitude: 41.0082, longitude: 28.9784 },
  kyoto: { latitude: 35.0116, longitude: 135.7681 },
  lisbon: { latitude: 38.7223, longitude: -9.1393 },
  london: { latitude: 51.5072, longitude: -0.1276 },
  madrid: { latitude: 40.4168, longitude: -3.7038 },
  milan: { latitude: 45.4642, longitude: 9.19 },
  moscow: { latitude: 55.7558, longitude: 37.6173 },
  "new york": { latitude: 40.7128, longitude: -74.006 },
  paris: { latitude: 48.8566, longitude: 2.3522 },
  prague: { latitude: 50.0755, longitude: 14.4378 },
  rome: { latitude: 41.9028, longitude: 12.4964 },
  santorini: { latitude: 36.3932, longitude: 25.4615 },
  singapore: { latitude: 1.3521, longitude: 103.8198 },
  tokyo: { latitude: 35.6762, longitude: 139.6503 },
  venice: { latitude: 45.4408, longitude: 12.3155 },
};

const clean = (value) => String(value || "").trim();

const normalizeText = (value = "") =>
  clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const hasCoordinates = (item = {}) =>
  toNumber(item.latitude) !== null && toNumber(item.longitude) !== null;

const getCoordinates = (item = {}) => {
  const latitude = toNumber(item.latitude);
  const longitude = toNumber(item.longitude);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
};

const setCoordinates = (item, coords, source) => {
  if (!coords) return false;
  const latitude = toNumber(coords.latitude);
  const longitude = toNumber(coords.longitude);
  if (latitude === null || longitude === null) return false;
  item.latitude = latitude;
  item.longitude = longitude;
  item.coordinateSource = source || coords.provider || "unknown";
  return true;
};

const tokenize = (value = "") =>
  normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 3);

const stableId = (...parts) =>
  parts
    .map((part) => normalizeText(part).replace(/\s+/g, "-"))
    .filter(Boolean)
    .join("-")
    .slice(0, 80);

const parseDurationMinutes = (value, type = "activity") => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(10, Math.round(value));
  const text = normalizeText(value);
  if (!text) {
    if (type === "food") return 75;
    if (type === "travel") return 60;
    if (type === "stay") return 45;
    return 120;
  }

  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)/);
  const minMatch = text.match(/(\d+)\s*(?:m|min|mins|minute|minutes)/);
  const numeric = text.match(/^(\d+(?:\.\d+)?)$/);

  const hours = hourMatch ? Number(hourMatch[1]) : 0;
  const minutes = minMatch ? Number(minMatch[1]) : 0;
  if (hours || minutes) return Math.max(10, Math.round(hours * 60 + minutes));
  if (numeric) return Math.max(10, Math.round(Number(numeric[1])));
  return type === "food" ? 75 : type === "travel" ? 60 : 120;
};

const buildMemoryPlaces = ({ activities = [], restaurants = [], hotels = [] } = {}) => {
  const rows = [];

  for (const item of activities || []) {
    rows.push({
      kind: "activity",
      title: clean(item.title),
      provider: clean(item.provider),
      details: clean(item.description),
      latitude: item.latitude,
      longitude: item.longitude,
      booking_url: item.booking_url,
      rating: item.rating,
      source: item.source || "activity_search",
    });
  }

  for (const item of restaurants || []) {
    rows.push({
      kind: "food",
      title: clean(item.title),
      provider: clean(item.provider || item.title),
      details: clean(item.address || item.type),
      latitude: item.latitude,
      longitude: item.longitude,
      booking_url: item.booking_url,
      rating: item.rating,
      address: item.address,
      price: item.price,
      source: "restaurant_search",
    });
  }

  for (const item of hotels || []) {
    rows.push({
      kind: "stay",
      title: clean(item.name || item.title),
      provider: clean(item.name || item.provider),
      details: clean(item.city),
      latitude: item.latitude,
      longitude: item.longitude,
      booking_url: item.booking_url,
      rating: item.rating,
      source: "hotel_search",
    });
  }

  return rows.filter((row) => row.title || row.provider);
};

const scoreMemoryMatch = (event, memoryPlace) => {
  const eventText = normalizeText([event.title, event.provider, event.details].filter(Boolean).join(" "));
  const placeText = normalizeText([memoryPlace.title, memoryPlace.provider, memoryPlace.details].filter(Boolean).join(" "));
  if (!eventText || !placeText) return 0;

  let score = 0;
  if (eventText.includes(normalizeText(memoryPlace.title)) && memoryPlace.title) score += 6;
  if (eventText.includes(normalizeText(memoryPlace.provider)) && memoryPlace.provider) score += 3;
  if (memoryPlace.kind === event.type) score += 2;

  const eventTokens = new Set(tokenize(eventText));
  for (const token of tokenize(placeText)) {
    if (eventTokens.has(token)) score += 1;
  }
  return score;
};

const findMemoryMatch = (event, memoryPlaces) => {
  let best = null;
  let bestScore = 0;
  for (const place of memoryPlaces) {
    const score = scoreMemoryMatch(event, place);
    if (score > bestScore) {
      best = place;
      bestScore = score;
    }
  }
  return bestScore >= 4 ? { ...best, score: bestScore } : null;
};

const applyMemoryPlace = (event, match) => {
  if (!match) return;
  if (!event.provider && match.provider) event.provider = match.provider;
  if (!event.details && match.details) event.details = match.details;
  if (!event.booking_url && match.booking_url) event.booking_url = match.booking_url;
  if (!event.rating && match.rating) event.rating = match.rating;
  if (!event.address && match.address) event.address = match.address;
  if (!event.price && match.price) event.price = match.price;
  if (!hasCoordinates(event) && hasCoordinates(match)) {
    setCoordinates(event, match, match.source || "memory");
  }
  event.placeMatch = {
    source: match.source || "memory",
    score: match.score,
    title: match.title || match.provider || null,
  };
};

const cityFallback = (plan) => {
  const names = [
    ...(Array.isArray(plan?.cities) ? plan.cities : []),
    plan?.location,
    plan?.country,
  ]
    .map(normalizeText)
    .filter(Boolean);

  for (const name of names) {
    if (CITY_CENTERS[name]) return { ...CITY_CENTERS[name], provider: "city_fallback" };
    const direct = Object.entries(CITY_CENTERS).find(([city]) => name.includes(city));
    if (direct) return { ...direct[1], provider: "city_fallback" };
  }
  return null;
};

const buildGeocodeQuery = (event, plan) =>
  [
    event.title,
    event.provider,
    event.address,
    plan.location,
    plan.country,
  ]
    .filter(Boolean)
    .join(", ");

const calcBounds = (points = []) => {
  const coords = points.map(getCoordinates).filter(Boolean);
  if (coords.length === 0) return null;

  const lats = coords.map((p) => p.latitude);
  const lngs = coords.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  return {
    southWest: { latitude: minLat, longitude: minLng },
    northEast: { latitude: maxLat, longitude: maxLng },
    center: {
      latitude: Number(((minLat + maxLat) / 2).toFixed(6)),
      longitude: Number(((minLng + maxLng) / 2).toFixed(6)),
    },
    latitudeDelta: Number(Math.max(0.01, (maxLat - minLat) * 1.35).toFixed(6)),
    longitudeDelta: Number(Math.max(0.01, (maxLng - minLng) * 1.35).toFixed(6)),
  };
};

const buildRouteSummary = (legs = []) => {
  if (!legs.length) return "Single-place day";
  const distance = legs.reduce((sum, leg) => sum + (Number(leg.distanceMeters) || 0), 0);
  const duration = legs.reduce((sum, leg) => sum + (Number(leg.durationSeconds) || 0), 0);
  const modes = [...new Set(legs.map((leg) => leg.mode).filter(Boolean))];
  return `${formatDistance(distance)} between stops, about ${formatDuration(duration)} total by ${modes.join(" + ") || "route"}`;
};

const nearestNeighborOrder = (events = []) => {
  const withCoords = events.filter(hasCoordinates);
  if (withCoords.length <= 2) return events.map((event) => event.id);

  const remaining = withCoords.slice(1);
  const ordered = [withCoords[0]];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestMeters = Number.POSITIVE_INFINITY;
    remaining.forEach((candidate, idx) => {
      const leg = estimateRouteLeg({ from: last, to: candidate, mode: chooseRouteMode(last, candidate) });
      if (leg.distanceMeters < bestMeters) {
        bestMeters = leg.distanceMeters;
        bestIndex = idx;
      }
    });
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  return ordered.map((event) => event.id);
};

const routeDistanceForOrder = (eventsById, orderedIds = []) => {
  let meters = 0;
  for (let i = 1; i < orderedIds.length; i += 1) {
    const from = eventsById.get(orderedIds[i - 1]);
    const to = eventsById.get(orderedIds[i]);
    if (from && to && hasCoordinates(from) && hasCoordinates(to)) {
      meters += estimateRouteLeg({ from, to, mode: chooseRouteMode(from, to) }).distanceMeters;
    }
  }
  return meters;
};

async function enrichEventCoordinates(event, { plan, mapsProvider, memoryPlaces, cityCenter }) {
  const match = findMemoryMatch(event, memoryPlaces);
  applyMemoryPlace(event, match);

  if (!hasCoordinates(event) && mapsProvider?.hasGeocoding) {
    const query = buildGeocodeQuery(event, plan);
    const geocoded = await mapsProvider.geocode(query);
    if (geocoded) {
      setCoordinates(event, geocoded, geocoded.provider);
      event.placeId = event.placeId || geocoded.placeId || undefined;
      event.address = event.address || geocoded.address || undefined;
      event.placeTypes = event.placeTypes || geocoded.types || undefined;
    }
  }

  if (!hasCoordinates(event) && cityCenter && event.type !== "travel") {
    setCoordinates(event, cityCenter, cityCenter.provider);
    event.coordinateConfidence = "city_level";
  } else if (hasCoordinates(event) && !event.coordinateConfidence) {
    event.coordinateConfidence = event.coordinateSource === "city_fallback" ? "city_level" : "place_level";
  }
}

async function buildRouteLegs(day, mapsProvider) {
  const events = (day.events || []).filter(hasCoordinates);
  const legs = [];
  for (let i = 1; i < events.length; i += 1) {
    const from = events[i - 1];
    const to = events[i];
    const mode = chooseRouteMode(from, to);
    const providerLeg =
      (await mapsProvider?.routeLeg?.({ from, to, mode })) ||
      estimateRouteLeg({ from, to, mode });

    legs.push({
      id: `${from.id || `e${i}`}-to-${to.id || `e${i + 1}`}`,
      fromEventId: from.id,
      toEventId: to.id,
      mode: providerLeg.mode || mode,
      provider: providerLeg.provider || "heuristic",
      distanceMeters: providerLeg.distanceMeters || 0,
      durationSeconds: providerLeg.durationSeconds || 0,
      distanceText: providerLeg.distanceText || formatDistance(providerLeg.distanceMeters),
      durationText: providerLeg.durationText || formatDuration(providerLeg.durationSeconds),
      geometry: providerLeg.geometry || null,
      encodedPolyline: providerLeg.encodedPolyline || null,
      confidence: providerLeg.confidence || "estimated",
    });
  }
  return legs;
}

const scorePlanQuality = (plan) => {
  const days = Array.isArray(plan.itinerary) ? plan.itinerary : [];
  const events = days.flatMap((day) => (Array.isArray(day.events) ? day.events : []));
  const coordEvents = events.filter(hasCoordinates);
  const exactCoordEvents = coordEvents.filter((event) => event.coordinateConfidence !== "city_level");
  const genericProviders = events.filter((event) =>
    /^(local|hotel|restaurant|tour operator|airline|provider)?$/i.test(clean(event.provider))
  );
  const missingBookingLinks = (plan.costBreakdown || []).filter((item) => !item.booking_url);
  const routeLegCount = days.reduce(
    (sum, day) =>
      sum +
      (day.routeLegs || []).filter((leg) => Number(leg.distanceMeters) > 0).length,
    0
  );

  const coordinateCoverage = events.length ? exactCoordEvents.length / events.length : 0;
  const routeCoverage = Math.min(1, routeLegCount / Math.max(1, exactCoordEvents.length - days.length));
  const providerPenalty = events.length ? genericProviders.length / events.length : 0;
  const bookingPenalty = (plan.costBreakdown || []).length
    ? missingBookingLinks.length / plan.costBreakdown.length
    : 0;

  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        35 +
          coordinateCoverage * 35 +
          routeCoverage * 15 -
          providerPenalty * 15 -
          bookingPenalty * 10
      )
    )
  );

  const warnings = [];
  if (coordinateCoverage < 0.75) warnings.push("Some itinerary events still need exact place-level coordinates.");
  if (routeCoverage < 0.5 && coordEvents.length > days.length) warnings.push("Only part of the itinerary could be routed.");
  if (genericProviders.length) warnings.push("Some events still use generic providers.");
  if (missingBookingLinks.length) warnings.push("Some cost items do not have booking links.");

  return {
    score,
    coordinateCoverage: Number(coordinateCoverage.toFixed(2)),
    routeCoverage: Number(routeCoverage.toFixed(2)),
    missingCoordinates: events.length - exactCoordEvents.length,
    cityLevelCoordinates: coordEvents.length - exactCoordEvents.length,
    genericProviders: genericProviders.length,
    missingBookingLinks: missingBookingLinks.length,
    warnings,
  };
};

export async function enrichPlanV2(plan, { mapsProvider, memories = {}, logger = console } = {}) {
  if (!plan || typeof plan !== "object") return plan;

  const memoryPlaces = buildMemoryPlaces(memories);
  const cityCenter = cityFallback(plan);
  const days = Array.isArray(plan.itinerary) ? plan.itinerary : [];

  plan.schemaVersion = "plan.v2";
  plan.generatedAt = plan.generatedAt || new Date().toISOString();
  plan.enrichment = {
    version: "2026-05-09",
    mapsProvider: mapsProvider?.provider || "heuristic",
    hasProviderGeocoding: Boolean(mapsProvider?.hasGeocoding),
    hasProviderRouting: Boolean(mapsProvider?.hasRouting),
  };

  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const day = days[dayIndex];
    day.id = day.id || `day-${dayIndex + 1}`;
    day.isoDate = day.isoDate || (/^\d{4}-\d{2}-\d{2}/.test(clean(day.date)) ? clean(day.date).slice(0, 10) : undefined);
    day.events = Array.isArray(day.events) ? day.events : [];

    await Promise.all(
      day.events.map(async (event, eventIndex) => {
        event.id = event.id || stableId(day.id, event.time, event.title) || `${day.id}-event-${eventIndex + 1}`;
        event.type = event.type || "activity";
        event.time = event.time || ["09:00", "13:00", "17:00", "20:00"][eventIndex] || "10:00";
        event.duration = event.duration || (event.type === "food" ? "1h 15m" : "2h");
        event.durationMinutes = event.durationMinutes || parseDurationMinutes(event.duration, event.type);
        event.provider = event.provider || event.title || "Local provider";

        try {
          await enrichEventCoordinates(event, { plan, mapsProvider, memoryPlaces, cityCenter });
        } catch (error) {
          logger?.warn?.("[plan-v2] event enrichment failed", error?.message || error);
        }
      })
    );

    day.routeLegs = await buildRouteLegs(day, mapsProvider);
    day.mapBounds = calcBounds(day.events);
    day.routeSummary = buildRouteSummary(day.routeLegs);

    const eventsById = new Map(day.events.map((event) => [event.id, event]));
    const currentOrder = day.events.filter(hasCoordinates).map((event) => event.id);
    const recommendedOrder = nearestNeighborOrder(day.events);
    const currentMeters = routeDistanceForOrder(eventsById, currentOrder);
    const optimizedMeters = routeDistanceForOrder(eventsById, recommendedOrder);
    day.routeOptimization = {
      applied: false,
      reason: "Existing timed itinerary order preserved.",
      currentOrder,
      recommendedOrder,
      currentDistanceMeters: currentMeters,
      recommendedDistanceMeters: optimizedMeters,
      potentialSavingMeters: Math.max(0, currentMeters - optimizedMeters),
    };
  }

  const allEvents = days.flatMap((day) => day.events || []);
  plan.mapBounds = calcBounds(allEvents);
  plan.routeSummary = buildRouteSummary(days.flatMap((day) => day.routeLegs || []));
  plan.placeCount = allEvents.filter(hasCoordinates).length;
  plan.exactPlaceCount = allEvents.filter(
    (event) => hasCoordinates(event) && event.coordinateConfidence !== "city_level"
  ).length;
  plan.planQuality = scorePlanQuality(plan);

  return plan;
}
