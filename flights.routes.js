// flights.routes.js
import { Router } from "express";
import Amadeus from "amadeus";

const router = Router();

/* ----------------------------- Amadeus client ---------------------------- */

const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID || process.env.AMADEUS_API_KEY,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET || process.env.AMADEUS_API_SECRET,
  // ✅ SDK expects `hostname: 'test' | 'production'`. Do NOT use `host`.
  hostname: process.env.AMADEUS_HOSTNAME === "production" ? "production" : "test",
});

/* -------------------------------- Helpers -------------------------------- */

const safe = (v, d = "") => (v === undefined || v === null ? d : v);

// “Istanbul, IST” → “IST”  |  “IST” → “IST”
function pickIATACode(label = "") {
  const trimmed = String(label).trim();
  if (!trimmed) return "";
  // If it looks like "PAR, CDG" or "Istanbul, IST"
  const parts = trimmed.split(/[,()\s]+/).filter(Boolean);
  // try to find a 3-letter uppercase token
  const token = parts.find((p) => /^[A-Z]{3}$/.test(p));
  if (token) return token;
  // fall back to last chunk uppercased if it is 3 long
  const last = parts[parts.length - 1]?.toUpperCase?.() || "";
  return /^[A-Z]{3}$/.test(last) ? last : trimmed.slice(0, 3).toUpperCase();
}

function parseISODuration(dur = "") {
  // "PT3H45M" → "3h 45m"
  const mH = /(\d+)H/.exec(dur);
  const mM = /(\d+)M/.exec(dur);
  const h = mH ? Number(mH[1]) : 0;
  const m = mM ? Number(mM[1]) : 0;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return dur || "";
}

function hhmm(iso) {
  // "2025-10-15T07:20:00" → "07:20"
  if (!iso || typeof iso !== "string") return "—";
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : "—";
}

// Map cabin label from UI to Amadeus enum
function cabinFromUI(label = "") {
  const s = String(label).toLowerCase();
  if (s.includes("first")) return "FIRST";
  if (s.includes("business")) return "BUSINESS";
  if (s.includes("prem")) return "PREMIUM_ECONOMY";
  if (s.includes("econ")) return "ECONOMY";
  // UI default said “1st Class”; treat as FIRST
  if (s.includes("1st")) return "FIRST";
  return "ECONOMY";
}

// Build originDestinations for one-way / round / multi
function buildOriginDestinations(payload) {
  const { tripType, from, to, departDate, returnDate, legs = [] } = payload || {};
  const out = [];
  if (tripType === "multi" && Array.isArray(legs) && legs.length) {
    legs.forEach((leg, i) => {
      const origin = pickIATACode(leg.from);
      const destination = pickIATACode(leg.to);
      if (origin && destination && leg.date) {
        out.push({
          id: String(i + 1),
          originLocationCode: origin,
          destinationLocationCode: destination,
          departureDateTimeRange: { date: String(leg.date) },
        });
      }
    });
    return out;
  }

  // one-way
  const o = pickIATACode(from);
  const d = pickIATACode(to);
  if (o && d && departDate) {
    out.push({
      id: "1",
      originLocationCode: o,
      destinationLocationCode: d,
      departureDateTimeRange: { date: String(departDate) },
    });
  }

  // round-trip second slice
  if (tripType === "round" && o && d && returnDate) {
    out.push({
      id: "2",
      originLocationCode: d,
      destinationLocationCode: o,
      departureDateTimeRange: { date: String(returnDate) },
    });
  }

  return out;
}

// Travelers array from counts
function buildTravelers({ passengers } = {}) {
  const p = passengers || { adults: 1, children: 0, infants: 0 };
  const trav = [];
  let id = 1;
  for (let i = 0; i < (p.adults || 0); i++) trav.push({ id: String(id++), travelerType: "ADULT" });
  for (let i = 0; i < (p.children || 0); i++) trav.push({ id: String(id++), travelerType: "CHILD" });
  for (let i = 0; i < (p.infants || 0); i++) trav.push({ id: String(id++), travelerType: "HELD_INFANT" });
  if (!trav.length) trav.push({ id: "1", travelerType: "ADULT" });
  return trav;
}

// Map one Amadeus flight offer → your frontend card shape
function mapOfferToCard(offer, dicts) {
  const carriers = dicts?.carriers || {};
  const itin = offer?.itineraries?.[0];
  const priceTotal = Number(offer?.price?.total || 0);

  const segments = itin?.segments || [];
  const first = segments[0];
  const last = segments[segments.length - 1] || first;

  const departTime = hhmm(first?.departure?.at);
  const arriveTime = hhmm(last?.arrival?.at);

  const carrierCode = first?.carrierCode || "";
  const airline = carriers[carrierCode] || carrierCode || "Airline";

  const stops = Math.max(0, segments.length - 1);
  const duration = `${parseISODuration(itin?.duration || "")} / ${stops === 0 ? "Direct" : stops === 1 ? "One layover" : `${stops} stops`}`;

  return {
    id: offer?.id || Math.random().toString(36).slice(2),
    airline,
    depart: departTime,
    arrive: arriveTime,
    from: first?.departure?.iataCode || "",
    to: last?.arrival?.iataCode || "",
    airportFrom: first?.departure?.iataCode || "",
    airportTo: last?.arrival?.iataCode || "",
    duration,
    price: priceTotal,
  };
}

/* ----------------------------- Airports search --------------------------- */
/**
 * GET /airports?q=par
 * Returns: [{ city, code, country }]
 */
router.get("/airports", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);

  try {
    const r = await amadeus.referenceData.locations.get({
      keyword: q,
      subType: "AIRPORT,CITY",
      "page[limit]": 10,
    });

    const rows = (r?.data || []).map((x) => {
      // Prefer airport IATA; for city, fallback to its iataCode
      const code = x.iataCode || x.address?.cityCode || "";
      const city = x.address?.cityName || x.name || x.detailedName || x?.iataCode || q;
      const country = x.address?.countryName || x.address?.countryCode || "";
      return { city, code, country };
    });

    // Dedupe by code
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      if (!row.code) continue;
      if (seen.has(row.code)) continue;
      seen.add(row.code);
      out.push(row);
    }

    res.json(out);
  } catch (e) {
    console.error("airports error", e);
    res.status(200).json([]); // graceful empty
  }
});

/* --------------------------- Flight offers search ------------------------ */
/**
 * POST /flights/search
 * Body example (one-way):
 * {
 *   "tripType":"oneway",
 *   "from":"Istanbul, IST",
 *   "to":"Paris, CDG",
 *   "departDate":"2025-10-17",
 *   "passengers":{"adults":1,"children":0,"infants":0},
 *   "filters":{"onboard":"Economy"}   // optional; supports "1st Class", "Business", etc.
 * }
 *
 * Round-trip adds "returnDate".
 *
 * Multi-city:
 * { "tripType":"multi", "legs":[{ "from":"IST", "to":"CDG", "date":"2025-10-17" }, ... ],
 *   "passengers":{"adults":1} }
 */
router.post("/flights/search", async (req, res) => {
  try {
    const body = req.body || {};
    const originDestinations = buildOriginDestinations(body);

    if (!originDestinations.length) {
      return res.status(200).json({ offers: [] });
    }

    const travelers = buildTravelers(body);
    const cabin = cabinFromUI(body?.filters?.onboard || "");

    // Restrict cabin across all built originDestination IDs
    const cabinRestriction = {
      cabin,
      coverage: "MOST_SEGMENTS",
      originDestinationIds: originDestinations.map((x) => x.id),
    };

    const payload = {
      currencyCode: "USD",
      sources: ["GDS"],
      originDestinations,
      travelers,
      searchCriteria: {
        // You can wire your UI filters into these sections later as needed
        flightFilters: {
          cabinRestrictions: [cabinRestriction],
          // Example: maxFlightOffers: 50 (SDK does pagination server-side; leave default)
        },
        // oneWayCombinations: { enabled: true } // useful when searching creative combos
      },
    };

    const r = await amadeus.shopping.flightOffersSearch.post(payload);

    const offers = (r?.data || []).map((o) => mapOfferToCard(o, r?.result?.dictionaries));

    // Basic sort: cheapest first (your UI can re-sort client-side)
    offers.sort((a, b) => (a.price || 0) - (b.price || 0));

    res.json({ offers });
  } catch (e) {
    // Common mistakes: wrong hostname, invalid date, bad IATA, etc.
    const raw = e?.response?.body || e?.description || e?.message || e;
    console.error("flights search error", e);
    res.status(200).json({ offers: [] }); // keep UI happy even on API issues
  }
});

export default router;
