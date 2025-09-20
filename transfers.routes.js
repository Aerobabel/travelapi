// transfers.routes.js
import { Router } from "express";

const router = Router();

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
const tagsFromFeatures = (f = {}) => {
  const t = [];
  if (f.instant) t.push("Instant confirmation");
  if (f.freeWait) t.push("Free waiting time");
  if (f.guaranteed) t.push("Guaranteed car model");
  return t;
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
    res.json({ flights });
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

    const protoOffers = vendors.map((v, i) => {
      const durationMin = durationFor({ distanceKm, scMeta });
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
    };

    res.json({ summary, offers: sorted });
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
    res.json({ from, to, serviceClass: scMeta?.name || "Premium", distanceKm, durationMin, price, currency: "USD" });
  } catch (e) { next(e); }
});

export default router;
