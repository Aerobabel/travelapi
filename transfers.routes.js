// transfers.routes.js
import { Router } from "express";
import Amadeus from "amadeus";

const router = Router();

const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  hostname: process.env.AMADEUS_HOSTNAME || "production",
});

/* ------------------------------ In-memory data ------------------------------ */
const AIRLINES = [
  { code: "TK", name: "Turkish Airlines", price: 431 },
  { code: "W6", name: "Wizz Air", price: 219 },
  { code: "BA", name: "British Airways", price: 508 },
  { code: "LH", name: "Lufthansa", price: 474 },
  { code: "QR", name: "Qatar Airways", price: 690 },
];

const AIRPORTS = [
  { code: "LHR", name: "Heathrow Airport" },
  { code: "LGW", name: "Gatwick Airport" },
  { code: "STN", name: "Stansted Airport" },
  { code: "LCY", name: "London City Airport" },
  { code: "SVO", name: "Sheremetyevo International Airport" },
  { code: "IST", name: "Istanbul Airport" },
  { code: "LTN", name: "Luton Airport" },
  { code: "FRA", name: "Frankfurt Airport" },
  { code: "CDG", name: "Charles de Gaulle Airport" },
  { code: "OTP", name: "Henri Coandă Intl (Bucharest)" },
  { code: "AMS", name: "Amsterdam Schiphol" },
];

const FLIGHTS = [
  { no: "TK413", airline: "Turkish Airlines", from: "IST", to: "LHR", time: "08:15" },
  { no: "TK414", airline: "Turkish Airlines", from: "IST", to: "LHR", time: "09:05" },
  { no: "TK419", airline: "Turkish Airlines", from: "IST", to: "LHR", time: "14:40" },
  { no: "BA789", airline: "British Airways", from: "LHR", to: "AMS", time: "11:20" },
  { no: "LH123", airline: "Lufthansa", from: "FRA", to: "LHR", time: "13:40" },
  { no: "W61450", airline: "Wizz Air", from: "OTP", to: "LTN", time: "18:55" },
];

const SERVICE_CLASSES = [
  { key: "eco",  name: "Economy", base: 85,  per_km: 1.3, eta_min: 18, speed_kmh: 45, img: "https://images.unsplash.com/photo-1525609004556-c46c7d6cf023?w=600&q=60" },
  { key: "comf", name: "Comfort", base: 200, per_km: 1.8, eta_min: 30, speed_kmh: 50, img: "https://images.unsplash.com/photo-1549924231-f129b911e442?w=600&q=60" },
  { key: "prem", name: "Premium", base: 300, per_km: 2.1, eta_min: 20, speed_kmh: 55, img: "https://images.unsplash.com/photo-1549921296-3a6b3e63c31f?w=600&q=60" },
  { key: "biz",  name: "Business",base: 800, per_km: 3.2, eta_min: 10, speed_kmh: 60, img: "https://images.unsplash.com/photo-1592194996308-7b43878e84a6?w=600&q=60" },
];

const VENDORS = [
  { id: "v1", name: "B18 Limited",     rating: 9.5, reviews: 542, features: { instant: true, freeWait: true, guaranteed: true  } },
  { id: "v2", name: "Gotour Ride",     rating: 9.5, reviews: 542, features: { instant: true, freeWait: true, guaranteed: false } },
  { id: "v3", name: "Olimo",           rating: 8.9, reviews: 2001,features: { instant: true, freeWait: true, guaranteed: false } },
  { id: "v4", name: "SZN Limited",     rating: 9.4, reviews: 380, features: { instant: true, freeWait: true, guaranteed: true  } },
  { id: "v5", name: "Tokie 19 Transfer",rating: 9.0, reviews: 121, features: { instant: true, freeWait: true, guaranteed: false } },
];

const TRANSFER_DESTINATIONS = [
  {
    keys: ["paris", "eiffel", "louvre"],
    addressLine: "Avenue Anatole France, 5",
    cityName: "Paris",
    zipCode: "75007",
    countryCode: "FR",
    name: "Eiffel Tower",
    geoCode: "48.859466,2.2976965",
  },
  {
    keys: ["london", "westminster", "heathrow", "kings cross", "king's cross"],
    addressLine: "Westminster Bridge Road",
    cityName: "London",
    zipCode: "SE1 7PB",
    countryCode: "GB",
    name: "Westminster",
    geoCode: "51.500729,-0.124625",
  },
  {
    keys: ["amsterdam", "schiphol"],
    addressLine: "Museumstraat 1",
    cityName: "Amsterdam",
    zipCode: "1071 XX",
    countryCode: "NL",
    name: "Rijksmuseum",
    geoCode: "52.359998,4.885219",
  },
  {
    keys: ["istanbul", "sultanahmet"],
    addressLine: "Sultan Ahmet",
    cityName: "Istanbul",
    zipCode: "34122",
    countryCode: "TR",
    name: "Sultanahmet",
    geoCode: "41.00824,28.97836",
  },
  {
    keys: ["rome", "fiumicino", "colosseum"],
    addressLine: "Piazza del Colosseo",
    cityName: "Rome",
    zipCode: "00184",
    countryCode: "IT",
    name: "Colosseum",
    geoCode: "41.89021,12.49223",
  },
  {
    keys: ["barcelona", "sagrada"],
    addressLine: "Carrer de Mallorca, 401",
    cityName: "Barcelona",
    zipCode: "08013",
    countryCode: "ES",
    name: "Sagrada Familia",
    geoCode: "41.40363,2.17436",
  },
  {
    keys: ["dubai", "burj"],
    addressLine: "1 Sheikh Mohammed bin Rashid Boulevard",
    cityName: "Dubai",
    zipCode: "00000",
    countryCode: "AE",
    name: "Downtown Dubai",
    geoCode: "25.197197,55.274376",
  },
  {
    keys: ["new york", "manhattan", "jfk"],
    addressLine: "Times Square",
    cityName: "New York",
    zipCode: "10036",
    countryCode: "US",
    name: "Times Square",
    geoCode: "40.758896,-73.98513",
  },
  {
    keys: ["moscow", "svo", "sheremetyevo"],
    addressLine: "Red Square",
    cityName: "Moscow",
    zipCode: "109012",
    countryCode: "RU",
    name: "Red Square",
    geoCode: "55.75393,37.620795",
  },
];

const AIRPORT_CITY_DESTINATION = {
  CDG: "paris",
  LHR: "london",
  LGW: "london",
  STN: "london",
  LTN: "london",
  LCY: "london",
  AMS: "amsterdam",
  IST: "istanbul",
  FCO: "rome",
  BCN: "barcelona",
  DXB: "dubai",
  JFK: "new york",
  SVO: "moscow",
};

/* --------------------------------- helpers --------------------------------- */
const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
const addMinutes = (hhmm, mins) => {
  const [h, m] = (hhmm || "12:00").split(":").map(Number);
  const t = h * 60 + m + (mins || 0);
  const H = ((Math.floor(t / 60) % 24) + 24) % 24;
  const M = ((t % 60) + 60) % 60;
  return `${pad(H)}:${pad(M)}`;
};
const estimateDistanceKm = (from, to) => {
  if (!from || !to) return 35;
  const seed = (from.length * 7 + to.length * 11) % 40;
  return 15 + seed;
};
const extractAirportCode = (value) => {
  const s = String(value || "").trim();
  const exact = AIRPORTS.find((airport) => {
    const needle = s.toLowerCase();
    return needle.includes(airport.code.toLowerCase()) || needle.includes(airport.name.toLowerCase());
  });
  if (exact) return exact.code;
  const match = s.match(/\b[A-Za-z]{3}\b/);
  return match ? match[0].toUpperCase() : null;
};
const tagsFromFeatures = (f = {}) => {
  const t = [];
  if (f.instant) t.push("Instant confirmation");
  if (f.freeWait) t.push("Free waiting time");
  if (f.guaranteed) t.push("Guaranteed car model");
  return t;
};
const parseIsoDurationToMinutes = (iso) => {
  if (!iso || typeof iso !== "string") return null;
  const h = iso.match(/(\d+)H/);
  const m = iso.match(/(\d+)M/);
  const hours = h ? parseInt(h[1], 10) : 0;
  const mins = m ? parseInt(m[1], 10) : 0;
  const total = hours * 60 + mins;
  return total > 0 ? total : null;
};
const formatRideDuration = (mins) => {
  if (!mins || mins < 60) return `${mins || 30} mins ride`;
  return `${Math.floor(mins / 60)} hr ${mins % 60 ? `${mins % 60} mins` : ""} ride`.replace("  ride", " ride");
};
const totalPassengers = (passengers = {}) => Math.max(
  1,
  Number(passengers.adult || 0) +
    Number(passengers.child || 0) +
    Number(passengers.toddler || 0) +
    Number(passengers.infant || 0)
);
const passengerCharacteristics = (passengers = {}) => {
  const rows = [];
  const adults = Math.max(1, Number(passengers.adult || 1));
  const children = Number(passengers.child || 0) + Number(passengers.toddler || 0) + Number(passengers.infant || 0);
  for (let i = 0; i < adults; i += 1) rows.push({ passengerTypeCode: "ADT", age: 30 });
  for (let i = 0; i < children; i += 1) rows.push({ passengerTypeCode: "CHD", age: 8 });
  return rows;
};
const normalizeSearchDate = (dateStr) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const parsed = dateStr ? new Date(`${dateStr}T00:00:00`) : null;
  const date = parsed && !Number.isNaN(parsed.getTime()) && parsed >= today
    ? parsed
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const normalizeSearchTime = (value) => (/^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : "12:10");
const findDestination = (to, startLocationCode) => {
  const text = String(to || "").toLowerCase();
  const byText = TRANSFER_DESTINATIONS.find((destination) => destination.keys.some((key) => text.includes(key)));
  if (byText) return byText;
  const fallbackKey = AIRPORT_CITY_DESTINATION[startLocationCode] || "paris";
  return TRANSFER_DESTINATIONS.find((destination) => destination.keys.includes(fallbackKey)) || TRANSFER_DESTINATIONS[0];
};
const moneyValue = (value) => {
  const n = parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const applyFilters = (offers, filters) => {
  if (!filters) return offers;
  let list = offers.filter(o => o.price >= filters.price[0] && o.price <= filters.price[1]);
  if (filters.freeWait)   list = list.filter(o => o.features?.freeWait);
  if (filters.instant)    list = list.filter(o => o.features?.instant);
  if (filters.guaranteed) list = list.filter(o => o.features?.guaranteed);
  return list;
};
const sortOffers = (offers, sortKey) => {
  const copy = [...offers];
  switch (sortKey) {
    case "cheap": return copy.sort((a, b) => a.price - b.price);
    case "fast":  return copy.sort((a, b) => a.durationMin - b.durationMin);
    case "early": return copy.sort((a, b) => (a.pickupAt || "").localeCompare(b.pickupAt || ""));
    default:      return copy;
  }
};
function priceFor({ passengers, distanceKm, features, scMeta }) {
  const base = Number(scMeta?.base || 300);
  const perKm = Number(scMeta?.per_km || 2.1);
  let price = base + perKm * (distanceKm || 35);
  const bags = passengers?.bags ?? 0;
  price += Math.max(0, bags) * 5;
  const childCount = (passengers?.booster||0)+(passengers?.child||0)+(passengers?.toddler||0)+(passengers?.infant||0);
  const needsSeats = childCount > 0 && !passengers?.childSeat;
  if (needsSeats) price += childCount * 10;
  if (features?.guaranteed) price *= 1.05;
  return Math.round(price);
}
function durationFor({ distanceKm, scMeta }) {
  const speedKmh = Number(scMeta?.speed_kmh || 50);
  const mins = Math.ceil((distanceKm / speedKmh) * 60);
  return Math.max(18, Math.min(mins, 90));
}

async function buildAmadeusTransferRequest({
  mode,
  from,
  to,
  pickup,
  flight,
  pickupTime,
  passengers,
}) {
  const flightNo = flight?.no || flight?.number || flight?.id || "";
  const [flightMatch] = mode === "flight" && flightNo ? await fetchFlights(String(flightNo)) : [];
  const startLocationCode = flightMatch?.to || extractAirportCode(from) || "CDG";
  const destination = findDestination(to, startLocationCode);
  const startDate = normalizeSearchDate(mode === "pickup" ? pickup?.date : flight?.departureDate);
  const startTime = normalizeSearchTime(pickupTime || pickup?.time || flightMatch?.time);

  return {
    startLocationCode,
    endAddressLine: destination.addressLine,
    endCityName: destination.cityName,
    endZipCode: destination.zipCode,
    endCountryCode: destination.countryCode,
    endName: to || destination.name,
    endGeoCode: destination.geoCode,
    transferType: "PRIVATE",
    startDateTime: `${startDate}T${startTime}:00`,
    passengers: totalPassengers(passengers),
    passengerCharacteristics: passengerCharacteristics(passengers),
  };
}

function normalizeAmadeusTransfer(offer, context) {
  const quotation = offer?.quotation || offer?.converted || {};
  const price = moneyValue(quotation.monetaryAmount || quotation.total?.monetaryAmount);
  const durationMin =
    parseIsoDurationToMinutes(offer?.duration) ||
    parseIsoDurationToMinutes(offer?.stopOvers?.[0]?.duration) ||
    context.durationMin ||
    35;
  const pickupAt = (offer?.start?.dateTime || context.startDateTime || "").slice(11, 16) || context.pickupTime;
  const provider = offer?.serviceProvider || {};
  const vehicle = offer?.vehicle || {};
  const vehicleLabel = vehicle.description || vehicle.code || "Private transfer";
  const features = {
    instant: true,
    freeWait: true,
    guaranteed: Boolean(vehicle.description || vehicle.code),
  };
  const tags = [
    "Instant confirmation",
    "Free waiting time",
    vehicle.seats?.[0]?.count ? `${vehicle.seats[0].count} seats` : null,
    vehicle.baggages?.[0]?.count ? `${vehicle.baggages[0].count} bags` : null,
  ].filter(Boolean);

  return {
    id: offer?.id || `amadeus-${provider.code || "provider"}-${pickupAt}`,
    vendor: provider.name || "Amadeus transfer partner",
    price: Math.round(price || context.estimatedPrice || 0),
    currency: quotation.currencyCode || "USD",
    klass: vehicleLabel,
    dur: formatRideDuration(durationMin),
    durationMin,
    tags,
    features,
    rating: 9.2,
    reviews: 120,
    pickup: offer?.start?.locationCode || context.from,
    pickupAt,
    freeWaitEnds: addMinutes(pickupAt, 60),
    dropAt: addMinutes(pickupAt, durationMin),
    to: offer?.end?.name || context.to,
    providerCode: provider.code,
    termsUrl: provider.termsUrl,
    comfort: [
      { ok: true, t: "Instant confirmation" },
      { ok: true, t: "Free waiting time" },
      { ok: Boolean(provider.contacts?.phoneNumber || provider.contacts?.email), t: "Provider contact available" },
      { ok: Boolean(vehicle.seats?.length), t: "Vehicle capacity listed" },
    ],
    sourceConfidence: modeledConfidence(
      "amadeus_transfer_search",
      "Live Amadeus Transfer Search response."
    ),
  };
}

async function searchAmadeusTransfers(params) {
  if (!params.to) return [];
  try {
    const payload = await buildAmadeusTransferRequest(params);
    const response = await amadeus.shopping.transferOffers.post(payload);
    return (response?.data || [])
      .map((offer) => normalizeAmadeusTransfer(offer, {
        from: params.from,
        to: params.to,
        pickupTime: params.pickupTime,
        startDateTime: payload.startDateTime,
        durationMin: params.durationMin,
        estimatedPrice: params.estimatedPrice,
      }))
      .filter((offer) => offer.price > 0);
  } catch (error) {
    console.warn("Amadeus transfer search failed", error?.description || error?.message || error);
    return [];
  }
}
const modeledConfidence = (source, note) => ({
  source,
  confidence: "medium",
  note,
});

/* ------------------------------- helpers: fetch ------------------------------ */
const fetchAirlines = async () => AIRLINES;
const fetchAirports = async () => AIRPORTS;
const fetchServiceClass = async (key) => SERVICE_CLASSES.find(s => s.key === key) || null;
const fetchServiceClasses = async () => SERVICE_CLASSES;
const fetchVendors = async () => VENDORS;

const fetchFlights = async (queryOrNull, extra = {}) => {
  const query = (queryOrNull || "").toLowerCase().trim();
  const origin = (extra.origin || "").toUpperCase().trim();
  const filterAirlines = Array.isArray(extra.airlines) ? extra.airlines.map(s => s.toUpperCase()) : [];
  let rows = FLIGHTS;
  if (query) rows = rows.filter(f => f.no.toLowerCase().includes(query));
  if (origin) rows = rows.filter(f => f.from === origin);
  if (filterAirlines.length) {
    rows = rows.filter(f => {
      const code = AIRLINES.find(a => a.name === f.airline)?.code || "";
      return filterAirlines.includes(code);
    });
  }
  return rows.slice(0, 100);
};

/* ----------------------------- path alias helper ---------------------------- */
// mount the same handler for both /transfers/* and /api/transfers/*
const alias = (path) => [path, `/api${path}`];

/* ---------------------------------- routes ---------------------------------- */
router.get(alias("/transfers/airlines"), async (_req, res, next) => {
  try { res.json({ airlines: await fetchAirlines() }); } catch (e) { next(e); }
});
router.get(alias("/transfers/airports"), async (_req, res, next) => {
  try { res.json({ airports: await fetchAirports() }); } catch (e) { next(e); }
});
router.get(alias("/transfers/classes"), async (_req, res, next) => {
  try { res.json({ classes: await fetchServiceClasses() }); } catch (e) { next(e); }
});

// Accept ?query=, ?no=, ?number=, ?q=  (+ optional ?origin=, ?airlines=AA,BA)
router.get(alias("/transfers/flights"), async (req, res, next) => {
  try {
    const q = String(
      req.query.query ?? req.query.no ?? req.query.number ?? req.query.q ?? ""
    ).trim();
    const origin = String(req.query.origin || "").trim();
    const airlines = String(req.query.airlines || "").trim();
    const flights = await fetchFlights(q || null, {
      origin,
      airlines: airlines ? airlines.split(",").map(s => s.trim()) : [],
    });
    res.json({
      flights: flights.map((flight) => ({
        ...flight,
        sourceConfidence: modeledConfidence(
          "mock_flight_reference",
          "Transfer flight references are a small static helper list."
        ),
      })),
    });
  } catch (e) { next(e); }
});

// Search
router.post(alias("/transfers/search"), async (req, res, next) => {
  try {
    const {
      mode = "pickup",
      from = "SVO Airport, Terminal D",
      to = "",
      pickup,
      flight,
      passengers = { adult: 1, booster: 0, child: 0, toddler: 0, infant: 0, bags: 1, childSeat: false },
      serviceClass = "prem",
      filters = { price: [85, 900], freeWait: true, instant: true, guaranteed: true },
      sort = "rec",
      distanceKm: distanceOverride,
    } = req.body || {};

    let pickupTime = pickup?.time || "12:10";
    let pickupDate = pickup?.date || null;

    const flightNo = flight?.no || flight?.number || flight?.id || "";
    if (mode === "flight" && flightNo) {
      const [match] = await fetchFlights(String(flightNo));
      if (match?.time) pickupTime = addMinutes(match.time, 30);
      pickupDate = flight?.departureDate || pickupDate;
    }

    const [vendors, scMeta] = await Promise.all([fetchVendors(), fetchServiceClass(serviceClass)]);
    const scName = scMeta?.name || "Premium";
    const distanceKm = typeof distanceOverride === "number" ? distanceOverride : estimateDistanceKm(from, to);

    const baseDurationMin = durationFor({ distanceKm, scMeta });
    const estimatedPrice = priceFor({
      passengers,
      distanceKm,
      features: { guaranteed: true },
      scMeta,
    });
    const liveSummary = {
      route: from && to ? `${from.split(",")[0]} -> ${to.split(",")[0]}` : "Route",
      when: mode === "pickup"
        ? (pickupDate ? `${pickupDate}, ${pickupTime}` : `Pick-up at ${pickupTime}`)
        : (pickupDate || "Departure date not set"),
      distanceKm,
      serviceClass,
      passengers,
      sourceConfidence: modeledConfidence(
        "amadeus_transfer_search",
        "Offers are returned by Amadeus Transfer Search when available."
      ),
    };
    const amadeusOffers = await searchAmadeusTransfers({
      mode,
      from,
      to,
      pickup,
      flight,
      pickupTime,
      passengers,
      durationMin: baseDurationMin,
      estimatedPrice,
    });

    if (amadeusOffers.length) {
      const filteredAmadeus = applyFilters(amadeusOffers, filters);
      const visibleAmadeus = filteredAmadeus.length ? filteredAmadeus : amadeusOffers;
      res.json({ summary: liveSummary, offers: sortOffers(visibleAmadeus, sort), source: "amadeus" });
      return;
    }

    const protoOffers = vendors.map((v, i) => {
      const durationMin = baseDurationMin;
      const price = priceFor({ passengers, distanceKm, features: v.features, scMeta });
      const durTxt = durationMin < 60
        ? `${durationMin} mins ride`
        : `${Math.floor(durationMin / 60)} hr ${durationMin % 60 || ""} ride`.replace(" 0 ride", " ride");

      return {
        id: `o${i + 1}`,
        vendor: v.name,
        price,
        klass: scName,
        dur: durTxt,
        durationMin,
        tags: tagsFromFeatures(v.features),
        features: v.features,
        rating: v.rating,
        reviews: v.reviews,
        pickup: from.includes("Airport") ? from.split(",")[0] : from,
        pickupAt: pickupTime,
        freeWaitEnds: addMinutes(pickupTime, 60),
        dropAt: addMinutes(pickupTime, durationMin),
        to,
        sourceConfidence: modeledConfidence(
          "estimated_transfer_pricing",
          "Transfer price and duration are modeled until a live transfer supplier is connected."
        ),
      };
    });

    const filtered = applyFilters(protoOffers, filters);
    const sorted = sortOffers(filtered, sort);

    const summary = {
      route: from && to ? `${from.split(",")[0]} → ${to.split(",")[0]}` : "Route",
      when: mode === "pickup"
        ? (pickupDate ? `${pickupDate}, ${pickupTime}` : `Pick-up at ${pickupTime}`)
        : (pickupDate || "Departure date not set"),
      distanceKm,
      serviceClass,
      passengers,
      sourceConfidence: modeledConfidence(
        "estimated_transfer_pricing",
        "Offers are generated from local vendor profiles and distance estimates."
      ),
    };

    res.json({ summary, offers: sorted, source: "mock" });
  } catch (e) { next(e); }
});

// Quote
router.post(alias("/transfers/quote"), async (req, res, next) => {
  try {
    const { from, to, passengers, serviceClass = "prem", distanceKm: distanceOverride } = req.body || {};
    const scMeta = await fetchServiceClass(serviceClass);
    const distanceKm = typeof distanceOverride === "number" ? distanceOverride : estimateDistanceKm(from, to);
    const price = priceFor({ passengers, distanceKm, features: { guaranteed: true }, scMeta });
    const durationMin = durationFor({ distanceKm, scMeta });
    res.json({
      from,
      to,
      serviceClass: scMeta?.name || "Premium",
      distanceKm,
      durationMin,
      price,
      currency: "USD",
      sourceConfidence: modeledConfidence(
        "estimated_transfer_pricing",
        "Quote is an estimate until a live transfer supplier is connected."
      ),
    });
  } catch (e) { next(e); }
});

export default router;
