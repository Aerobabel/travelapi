// flights.routes.js
import { Router } from "express";
import Amadeus from "amadeus";

const router = Router();

const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  // hostname: process.env.AMADEUS_HOSTNAME || 'test'
});

// ---------------------------
// Helpers
// ---------------------------
function parseISOTimeToHHMM(iso) {
  try {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return "";
  }
}

function parseISODurationToLabel(iso = "") {
  // e.g. "PT3H55M" -> "3h 55m"
  const mH = /(\d+)H/.exec(iso);
  const mM = /(\d+)M/.exec(iso);
  const h = mH ? Number(mH[1]) : 0;
  const m = mM ? Number(mM[1]) : 0;
  if (!h && !m) return "";
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

function extractIATACode(input = "") {
  // Accept "City, CODE" OR "CODE" OR "City (CODE)"
  const s = String(input).trim();
  const mParen = /\(([A-Z]{3})\)/i.exec(s);
  if (mParen) return mParen[1].toUpperCase();
  const parts = s.split(",").map(t => t.trim());
  const last = parts[parts.length - 1] || s;
  if (/^[A-Za-z]{3}$/.test(last)) return last.toUpperCase();
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  return null;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

async function getAirlineNames(codes = []) {
  // Small cache to avoid repeated lookups
  if (!globalThis.__airlineCache) globalThis.__airlineCache = new Map();
  const cache = globalThis.__airlineCache;

  const need = codes.filter(c => !cache.has(c));
  if (need.length) {
    try {
      const r = await amadeus.referenceData.airlines.get({
        airlineCodes: need.join(","),
      });
      (r?.data || []).forEach(a => {
        if (a.iataCode) cache.set(a.iataCode, a.businessName || a.commonName || a.officialName || a.iataCode);
      });
    } catch {
      // best-effort: if lookup fails, fill with code itself
      need.forEach(c => cache.set(c, c));
    }
  }

  const out = {};
  codes.forEach(c => { out[c] = cache.get(c) || c; });
  return out;
}

// Map a single Amadeus Flight Offer → the compact card your UI expects
async function mapOfferToCard(offer) {
  try {
    const itin = offer?.itineraries?.[0];
    if (!itin) return null;

    const firstSeg = itin.segments?.[0];
    const lastSeg  = itin.segments?.[itin.segments.length - 1];
    if (!firstSeg || !lastSeg) return null;

    const departISO = firstSeg.departure?.at;
    const arriveISO = lastSeg.arrival?.at;

    const depart = parseISOTimeToHHMM(departISO);
    const arrive = parseISOTimeToHHMM(arriveISO);

    const airportFrom = firstSeg.departure?.iataCode || "";
    const airportTo   = lastSeg.arrival?.iataCode || "";

    const duration = parseISODurationToLabel(itin.duration || "");
    const stops = Math.max(0, (itin.segments?.length || 1) - 1);

    // carrier
    const carriers = uniq((itin.segments || []).map(s => s.carrierCode).filter(Boolean));
    const namesMap = await getAirlineNames(carriers);
    const mainAirline = namesMap[carriers[0]] || carriers[0] || "";

    // price
    const price = Number(offer.price?.grandTotal || offer.price?.total || 0);

    return {
      id: offer.id,
      airline: mainAirline,
      depart,
      arrive,
      from: airportFrom, // optional used in details header
      to: airportTo,     // optional used in details header
      airportFrom,
      airportTo,
      duration: `${duration} / ${stops === 0 ? "Direct" : stops === 1 ? "1 stop" : `${stops} stops`}`,
      price: Math.round(price),
      _raw: offer, // keep raw if you want to reprice later
    };
  } catch {
    return null;
  }
}

// ---------------------------
// ROUTES
// ---------------------------

// Airport/City typeahead
// GET /airports?q=par
router.get("/airports", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const r = await amadeus.referenceData.locations.get({
      keyword: q,
      subType: "CITY,AIRPORT",
      "page[limit]": 8,
    });
    const out = (r?.data || []).map(x => ({
      city: x.address?.cityName || x.name || x.detailedName || x.iataCode || "",
      code: x.iataCode || "",
      country: x.address?.countryName || x.address?.countryCode || "",
    })).filter(x => x.code);
    res.json(out);
  } catch (e) {
    console.error("airports error", e?.response?.data || e);
    res.json([]);
  }
});

// Search flight offers
// POST /flights/search
// Body: { from, to, departDate, returnDate?, tripType, passengers:{adults,children,infants}, travelClass?, currencyCode? }
router.post("/flights/search", async (req, res) => {
  try {
    const {
      from, to, departDate, returnDate,
      tripType = "oneway",
      passengers = { adults: 1, children: 0, infants: 0 },
      travelClass = "ECONOMY",
      currencyCode = "USD",
    } = req.body || {};

    // normalize codes
    const origin = extractIATACode(from);
    const destination = extractIATACode(to);

    if (!origin || !destination || !departDate) {
      return res.status(400).json({ error: "from, to and departDate are required" });
    }

    // slices
    const slices = [{ origin, destination, departureDate: String(departDate) }];
    if (tripType === "round" && returnDate) {
      slices.push({ origin: destination, destination: origin, departureDate: String(returnDate) });
    }

    // travelers
    const travelers = [];
    for (let i = 0; i < (passengers.adults || 0); i++) {
      travelers.push({ id: String(travelers.length + 1), travelerType: "ADULT" });
    }
    for (let i = 0; i < (passengers.children || 0); i++) {
      travelers.push({ id: String(travelers.length + 1), travelerType: "CHILD" });
    }
    for (let i = 0; i < (passengers.infants || 0); i++) {
      // Self-Service supports HELD_INFANT (on lap). SEATED_INFANT not generally supported in browse flow.
      travelers.push({ id: String(travelers.length + 1), travelerType: "HELD_INFANT" });
    }
    if (!travelers.length) travelers.push({ id: "1", travelerType: "ADULT" });

    const body = {
      currencyCode,
      travelers,
      sources: ["GDS"],
      searchCriteria: {
        flightFilters: {
          cabinRestrictions: [{
            cabin: String(travelClass || "ECONOMY").toUpperCase(),
            coverage: "MOST_SEGMENTS",
            originDestinationIds: ["1"]
          }]
        }
      },
      // add slices after so "originDestinationIds" references are valid
    };
    body.slices = slices.map((s, i) => ({ ...s, id: String(i + 1) }));

    const r = await amadeus.shopping.flightOffersSearch.post(JSON.stringify(body));
    const raw = r?.data || [];
    // Map to your card model (in parallel for airline lookups)
    const cards = (await Promise.all(raw.map(mapOfferToCard))).filter(Boolean);

    res.json({ offers: cards });
  } catch (e) {
    console.error("flights search error", e?.response?.data || e);
    res.json({ offers: [] });
  }
});

// Cheapest prices by date (for your price chart)
// GET /flights/date-prices?origin=IST&destination=CDG&from=2025-12-01&to=2025-12-31&currencyCode=USD
router.get("/flights/date-prices", async (req, res) => {
  const origin = extractIATACode(req.query.origin);
  const destination = extractIATACode(req.query.destination);
  const startDate = String(req.query.from || "").trim();
  const endDate = String(req.query.to || "").trim();
  const currencyCode = String(req.query.currencyCode || "USD");

  if (!origin || !destination || !startDate || !endDate) {
    return res.status(400).json({ error: "origin, destination, from, to are required" });
  }

  try {
    const r = await amadeus.shopping.flightDates.get({
      origin,
      destination,
      departureDate: `${startDate},${endDate}`,
      currencyCode,
    });
    const rows = (r?.data || []).map(x => ({
      date: x.departureDate,
      price: Number(x.price?.total || 0)
    })).filter(x => x.date && x.price > 0);

    res.json({ rows });
  } catch (e) {
    console.error("date-prices error", e?.response?.data || e);
    res.json({ rows: [] });
  }
});

// Optional: reprice an offer before checkout
// POST /flights/price  { offer }  -> returns validated/priced offer
router.post("/flights/price", async (req, res) => {
  try {
    const offer = req.body?.offer;
    if (!offer) return res.status(400).json({ error: "offer required" });

    const r = await amadeus.shopping.flightOffers.pricing.post(JSON.stringify({
      data: {
        type: "flight-offers-pricing",
        flightOffers: [offer],
      }
    }));
    res.json({ priced: r?.data || {} });
  } catch (e) {
    console.error("price error", e?.response?.data || e);
    res.status(200).json({ priced: {} });
  }
});

export default router;
