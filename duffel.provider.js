const DUFFEL_API_BASE = process.env.DUFFEL_API_BASE || "https://api.duffel.com";
const DUFFEL_VERSION = process.env.DUFFEL_VERSION || "v2";
const DUFFEL_SUPPLIER_TIMEOUT_MS = Number(process.env.DUFFEL_SUPPLIER_TIMEOUT_MS || 15000);
const DUFFEL_MAX_CONNECTIONS = Number(process.env.DUFFEL_MAX_CONNECTIONS ?? 2);

const providerPrice = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const timePart = (iso) => String(iso || "").slice(11, 16);

const airportCode = (place = {}) =>
  place.iata_code ||
  place.iata_city_code ||
  place.iata_country_code ||
  "";

export const parseIsoDurationToMinutes = (iso) => {
  if (!iso || typeof iso !== "string") return null;
  const days = iso.match(/P(\d+)D/);
  const hours = iso.match(/(\d+)H/);
  const minutes = iso.match(/(\d+)M/);
  const d = days ? parseInt(days[1], 10) : 0;
  const h = hours ? parseInt(hours[1], 10) : 0;
  const m = minutes ? parseInt(minutes[1], 10) : 0;
  return d * 1440 + h * 60 + m;
};

export const formatIsoDuration = (iso) => {
  const mins = parseIsoDurationToMinutes(iso);
  if (!mins) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
};

export const mapDuffelCabinClass = (travelClass = "ECONOMY") => {
  const cabin = String(travelClass || "").toUpperCase();
  if (cabin.includes("FIRST")) return "first";
  if (cabin.includes("BUSINESS")) return "business";
  if (cabin.includes("PREMIUM")) return "premium_economy";
  return "economy";
};

export const buildDuffelPassengers = (passengers = {}) => {
  const adults = Math.max(1, Math.floor(Number(passengers.adults ?? passengers.adult ?? 1) || 1));
  const children = Math.max(0, Math.floor(Number(passengers.children ?? passengers.child ?? 0) || 0));
  const infants = Math.max(0, Math.floor(Number(passengers.infants ?? passengers.infant ?? 0) || 0));

  return [
    ...Array.from({ length: adults }, () => ({ type: "adult" })),
    ...Array.from({ length: children }, () => ({ type: "child" })),
    ...Array.from({ length: infants }, () => ({ type: "infant_without_seat" })),
  ];
};

export const buildDuffelSlices = (originDestinations = []) =>
  originDestinations
    .map((od) => ({
      origin: od?.originLocationCode,
      destination: od?.destinationLocationCode,
      departure_date: od?.departureDateTimeRange?.date,
    }))
    .filter((slice) => slice.origin && slice.destination && slice.departure_date);

const getDuffelToken = () =>
  process.env.DUFFEL_ACCESS_TOKEN ||
  process.env.DUFFEL_API_KEY ||
  "";

const duffelHeaders = () => ({
  Accept: "application/json",
  "Accept-Encoding": "gzip",
  "Content-Type": "application/json",
  "Duffel-Version": DUFFEL_VERSION,
  Authorization: `Bearer ${getDuffelToken()}`,
});

const readDuffelJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

const duffelErrorMessage = (body) => {
  const errors = body?.errors || body?.data?.errors || [];
  const first = Array.isArray(errors) ? errors[0] : null;
  return first?.message || first?.title || body?.message || "Duffel request failed";
};

const requestDuffel = async (path, options = {}) => {
  const token = getDuffelToken();
  if (!token) {
    const err = new Error("Duffel access token is not configured");
    err.code = "DUFFEL_MISSING_TOKEN";
    throw err;
  }

  const url = new URL(path, DUFFEL_API_BASE);
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: duffelHeaders(),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await readDuffelJson(response);

  if (!response.ok) {
    const err = new Error(duffelErrorMessage(body));
    err.status = response.status;
    err.body = body;
    err.requestId = response.headers.get("x-request-id");
    throw err;
  }

  return {
    body,
    requestId: response.headers.get("x-request-id"),
  };
};

const normalizeDuffelSegment = (segment = {}) => {
  const marketingCarrier = segment.marketing_carrier || {};
  const operatingCarrier = segment.operating_carrier || {};
  const carrier = operatingCarrier.iata_code ? operatingCarrier : marketingCarrier;
  const carrierCode = carrier.iata_code || marketingCarrier.iata_code || "";

  return {
    departure: {
      iataCode: airportCode(segment.origin),
      at: segment.departing_at || "",
    },
    arrival: {
      iataCode: airportCode(segment.destination),
      at: segment.arriving_at || "",
    },
    carrierCode,
    carrierName: carrier.name || marketingCarrier.name || "",
    number:
      segment.marketing_carrier_flight_number ||
      segment.operating_carrier_flight_number ||
      "",
    aircraft: {
      code: segment.aircraft?.iata_code || segment.aircraft?.name || "",
    },
    duration: segment.duration || "",
  };
};

const maxLayoverMinutes = (segments = []) => {
  let max = 0;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const arrival = new Date(segments[i]?.arrival?.at || 0);
    const departure = new Date(segments[i + 1]?.departure?.at || 0);
    const diff = (departure - arrival) / 60000;
    if (Number.isFinite(diff) && diff > max) max = diff;
  }
  return max;
};

const hasOvernightLayover = (segments = []) =>
  segments.some((segment, index) => {
    if (index >= segments.length - 1) return false;
    const arrival = new Date(segment?.arrival?.at || 0);
    const departure = new Date(segments[index + 1]?.departure?.at || 0);
    if (Number.isNaN(arrival.getTime()) || Number.isNaN(departure.getTime())) return false;
    return arrival.toDateString() !== departure.toDateString();
  });

export const normalizeDuffelOffer = (offer = {}) => {
  const slices = Array.isArray(offer.slices) ? offer.slices : [];
  const itineraries = slices
    .map((slice) => ({
      duration: slice.duration || "",
      segments: (slice.segments || []).map(normalizeDuffelSegment),
    }))
    .filter((itinerary) => itinerary.segments.length > 0);

  const outbound = itineraries[0];
  const segments = outbound?.segments || [];
  if (!segments.length) return null;

  const first = segments[0];
  const last = segments[segments.length - 1];
  const returnItinerary = itineraries[1];
  const returnSegments = returnItinerary?.segments || [];
  const returnFirst = returnSegments[0];
  const returnLast = returnSegments[returnSegments.length - 1];
  const firstCarrierName =
    first.carrierName ||
    offer.owner?.name ||
    offer.owner?.iata_code ||
    first.carrierCode ||
    "Airline";
  const flightNumber = [first.carrierCode, first.number].filter(Boolean).join("");
  const durationMinutes = parseIsoDurationToMinutes(outbound.duration);
  const price = providerPrice(offer.total_amount);

  return {
    id: `duffel-${offer.id}`,
    providerOfferId: offer.id,
    source: "duffel",
    provider: "Duffel",
    price,
    currency: offer.total_currency || "USD",
    airline: firstCarrierName,
    flightNumber,
    duration: formatIsoDuration(outbound.duration) || outbound.duration || "",
    depart: timePart(first.departure?.at),
    arrive: timePart(last.arrival?.at),
    departDate: String(first.departure?.at || "").slice(0, 10),
    origin: first.departure?.iataCode || "",
    destination: last.arrival?.iataCode || "",
    airportFrom: first.departure?.iataCode || "",
    airportTo: last.arrival?.iataCode || "",
    stops: Math.max(0, segments.length - 1),
    durationMinutes,
    maxLayoverMinutes: maxLayoverMinutes(segments),
    hasOvernightLayover: hasOvernightLayover(segments),
    returnDepart: returnFirst ? timePart(returnFirst.departure?.at) : null,
    returnArrive: returnLast ? timePart(returnLast.arrival?.at) : null,
    returnDuration: returnItinerary
      ? formatIsoDuration(returnItinerary.duration) || returnItinerary.duration
      : null,
    returnStops: returnItinerary ? Math.max(0, returnSegments.length - 1) : 0,
    returnDate: returnFirst ? String(returnFirst.departure?.at || "").slice(0, 10) : null,
    isRoundTrip: itineraries.length > 1,
    expiresAt: offer.expires_at || "",
    _raw: {
      provider: "duffel",
      id: offer.id,
      itineraries,
    },
  };
};

export const searchDuffelOffers = async ({
  originDestinations = [],
  passengers = {},
  travelClass = "ECONOMY",
} = {}) => {
  const slices = buildDuffelSlices(originDestinations);
  if (!slices.length) {
    return { offers: [], skipped: true, reason: "missing_slices" };
  }

  const { body, requestId } = await requestDuffel("/air/offer_requests", {
    method: "POST",
    query: {
      return_offers: "true",
      supplier_timeout: DUFFEL_SUPPLIER_TIMEOUT_MS,
    },
    body: {
      data: {
        slices,
        passengers: buildDuffelPassengers(passengers),
        cabin_class: mapDuffelCabinClass(travelClass),
        max_connections: DUFFEL_MAX_CONNECTIONS,
      },
    },
  });

  const offers = (body?.data?.offers || [])
    .map(normalizeDuffelOffer)
    .filter(Boolean);

  return {
    offers,
    requestId,
    offerRequestId: body?.data?.id,
  };
};

export const refreshDuffelOffer = async (offerId) => {
  if (!offerId) {
    const err = new Error("Missing Duffel offer id");
    err.status = 400;
    throw err;
  }

  const { body, requestId } = await requestDuffel(`/air/offers/${offerId}`, {
    query: { return_available_services: "false" },
  });
  const offer = normalizeDuffelOffer(body?.data);
  if (!offer) {
    const err = new Error("Duffel returned an invalid offer");
    err.status = 502;
    throw err;
  }
  return { offer, requestId };
};

const offerMergeKey = (offer = {}) => {
  const origin = offer.airportFrom || offer.origin || "";
  const destination = offer.airportTo || offer.destination || "";
  const airline = String(offer.airline || "").toLowerCase();
  const flightNumber = String(offer.flightNumber || "").toLowerCase();
  const depart = offer.depart || "";
  const arrive = offer.arrive || "";

  if (!origin || !destination || !depart || !arrive) {
    return `${offer.source || "provider"}:${offer.id || Math.random()}`;
  }

  return [
    origin,
    destination,
    depart,
    arrive,
    airline,
    flightNumber,
    offer.stops ?? "",
  ].join("|").toLowerCase();
};

export const mergeFlightOffers = (...groups) => {
  const merged = new Map();
  const offers = groups.flat().filter(Boolean);

  for (const offer of offers) {
    const price = Number(offer.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    const key = offerMergeKey(offer);
    const current = merged.get(key);
    if (!current || price < Number(current.price || Infinity)) {
      merged.set(key, offer);
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    const byPrice = Number(a.price || Infinity) - Number(b.price || Infinity);
    if (byPrice !== 0) return byPrice;
    return Number(a.durationMinutes || Infinity) - Number(b.durationMinutes || Infinity);
  });
};
