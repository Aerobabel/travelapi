// flights.routes.js
import express from "express";
import Amadeus from "amadeus";

const router = express.Router();

// --- Amadeus client ---
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_API_KEY || process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_API_SECRET || process.env.AMADEUS_CLIENT_SECRET,
  host: process.env.AMADEUS_HOST || "test", // "test" | "production"
});

/* -------------------------------- Helpers -------------------------------- */

const pickIata = (label) => {
  if (!label) return null;
  // "City, CODE" → CODE;  "(CODE)" → CODE; "CODE" → CODE
  const m1 = /\(([A-Z]{3})\)/i.exec(label);
  if (m1) return m1[1].toUpperCase();
  const parts = String(label).split(",").map((s) => s.trim());
  const last = parts[parts.length - 1];
  if (/^[A-Za-z]{3}$/.test(last)) return last.toUpperCase();
  if (/^[A-Za-z]{3}$/.test(label)) return label.toUpperCase();
  return null;
};

const fmtHHMM = (iso) => {
  try {
    const d = new Date(iso);
    const h = `${d.getHours()}`.padStart(2, "0");
    const m = `${d.getMinutes()}`.padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return "";
  }
};

const durationToPretty = (dur) => {
  // "PT3H45M" → "3h 45m"
  if (!dur) return "";
  const h = /(\d+)H/.exec(dur)?.[1];
  const m = /(\d+)M/.exec(dur)?.[1];
  return `${h ? `${h}h` : ""}${h && m ? " " : ""}${m ? `${m}m` : ""}`.trim();
};

const mapOfferToCard = (offer) => {
  try {
    const it = offer.itineraries?.[0];
    const last = offer.itineraries?.[offer.itineraries.length - 1];
    const seg0 = it?.segments?.[0];
    const segL = last?.segments?.[last.segments.length - 1];

    const depart = fmtHHMM(seg0?.departure?.at);
    const arrive = fmtHHMM(segL?.arrival?.at);

    const airportFrom = seg0?.departure?.iataCode;
    const airportTo = segL?.arrival?.iataCode;

    // Simple airline label: first segment marketing carrier
    const airline =
      seg0?.carrierCode ||
      offer.validatingAirlineCodes?.[0] ||
      "Airline";

    // Duration (total) and quick stop label
    const totalDur = durationToPretty(it?.duration);
    const stops = (it?.segments?.length || 1) - 1;
    const stopLabel = stops === 0 ? "Direct" : (stops === 1 ? "1 stop" : `${stops} stops`);

    // Price
    const price = Math.round(Number(offer.price?.grandTotal || offer.price?.total || 0));

    return {
      id: offer.id,
      airline,
      depart,
      arrive,
      airportFrom,
      airportTo,
      duration: `${totalDur} / ${stopLabel}`,
      price,
      _raw: offer, // keep for repricing
    };
  } catch (e) {
    return { id: offer.id || Math.random().toString(36).slice(2), airline: "Airline", depart: "", arrive: "", airportFrom: "", airportTo: "", duration: "", price: 0, _raw: offer };
  }
};

/* --------------------------------- Routes --------------------------------- */

/**
 * GET /airports?q=par
 * Uses Locations API (CITY + AIRPORT) for typeahead.
 */
router.get("/airports", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json([]);

    const { data } = await amadeus.referenceData.locations.get({
      keyword: q,
      subType: "AIRPORT,CITY",
      "page[limit]": 10,
      sort: "analytics.travelers.score", // better results on test env
    });

    const rows = (data || []).map((r) => ({
      city: r.address?.cityName || r.name || r.iataCode,
      code: r.iataCode,
      country: r.address?.countryName || r.address?.countryCode || "",
      subType: r.subType,
    }));
    res.json(rows);
  } catch (err) {
    console.error("airports error", err?.description || err);
    res.status(500).json({ error: "Failed to fetch airports" });
  }
});

/**
 * POST /flights/search
 * body: { from, to, departDate, returnDate?, tripType, passengers, travelClass, currencyCode }
 * Builds proper v2 Flight Offers Search payload with originDestinations.
 */
router.post("/flights/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departDate,
      returnDate = null,
      tripType = "oneway",
      passengers = { adults: 1, children: 0, infants: 0 },
      travelClass = "ECONOMY",
      currencyCode = "USD",
      // optional: max, nonStop, etc.
    } = req.body || {};

    const origin = pickIata(from);
    const destination = pickIata(to);

    if (!origin || !destination) {
      return res.status(400).json({ error: "Invalid origin or destination. Use IATA like 'Istanbul, IST'." });
    }
    if (!departDate) {
      return res.status(400).json({ error: "Missing departDate (YYYY-MM-DD)." });
    }

    // Build travelers
    const travelers = [];
    let id = 1;
    for (let i = 0; i < (passengers.adults || 0); i++) travelers.push({ id: `${id++}`, travelerType: "ADULT" });
    for (let i = 0; i < (passengers.children || 0); i++) travelers.push({ id: `${id++}`, travelerType: "CHILD" });
    for (let i = 0; i < (passengers.infants || 0); i++) travelers.push({ id: `${id++}`, travelerType: "HELD_INFANT" });
    if (travelers.length === 0) travelers.push({ id: "1", travelerType: "ADULT" });

    // originDestinations with IDs we can reference in cabinRestrictions
    const originDestinations = [
      {
        id: "1",
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDateTimeRange: { date: departDate },
      },
    ];

    if (tripType === "round" && returnDate) {
      originDestinations.push({
        id: "2",
        originLocationCode: destination,
        destinationLocationCode: origin,
        departureDateTimeRange: { date: returnDate },
      });
    }

    // Flight Offers Search payload (v2)
    const payload = {
      currencyCode,
      originDestinations,
      travelers,
      sources: ["GDS"],
      searchCriteria: {
        maxFlightOffers: 50,
        flightFilters: {
          cabinRestrictions: [
            {
              cabin: String(travelClass || "ECONOMY").toUpperCase(),
              coverage: "MOST_SEGMENTS",
              originDestinationIds: originDestinations.map((o) => o.id),
            },
          ],
        },
      },
    };

    // Call the API (SDK v8+)
    const rsp = await amadeus.shopping.flightOffersSearch.post(JSON.stringify(payload));
    const offers = Array.isArray(rsp.data) ? rsp.data : [];

    const mapped = offers.map(mapOfferToCard);
    res.json({ offers: mapped, raw: offers });
  } catch (err) {
    console.error("flights search error", err);
    const status = err?.response?.statusCode || 500;
    res.status(status).json({
      error: "Flight search failed",
      description: err?.description || err?.message || "Unknown error",
      details: err?.response?.result || undefined,
    });
  }
});

/**
 * GET /flights/date-prices?origin=IST&destination=LAX&from=2025-10-10&to=2025-10-25&currencyCode=USD
 * Uses Flight Dates API for a calendar-like min-price series.
 */
router.get("/flights/date-prices", async (req, res) => {
  try {
    const origin = (req.query.origin || "").toString().toUpperCase();
    const destination = (req.query.destination || "").toString().toUpperCase();
    const from = (req.query.from || "").toString();
    const to = (req.query.to || "").toString();
    const currencyCode = (req.query.currencyCode || "USD").toString();

    if (!origin || !destination || !from || !to) {
      return res.status(400).json({ error: "origin, destination, from, to are required (YYYY-MM-DD)." });
    }

    // Amadeus Flight Dates (calendar) – legacy v1 endpoint via SDK
    const { data } = await amadeus.shopping.flightDates.get({
      origin,
      destination,
      departureDate: `${from}--${to}`, // range
      oneWay: true,
      currencyCode,
    });

    // Map to simple rows: { date, price }
    const rows = (data || []).map((d) => ({
      date: d.departureDate,
      price: Number(d.price?.total || d.price?.grandTotal || 0),
    }));

    res.json({ rows });
  } catch (err) {
    console.error("date-prices error", err);
    res.status(500).json({ error: "Failed to fetch date prices" });
  }
});

/**
 * POST /flights/price
 * body: { offer } – reprices/validates a selected Flight Offer
 */
router.post("/flights/price", async (req, res) => {
  try {
    const offer = req.body?.offer;
    if (!offer) return res.status(400).json({ error: "Missing offer to price." });

    const payload = { data: { type: "flight-offers-pricing", flightOffers: [offer] } };
    const rsp = await amadeus.shopping.flightOffers.pricing.post(JSON.stringify(payload));

    res.json({ priced: rsp.result || rsp.data || rsp });
  } catch (err) {
    console.error("flights price error", err);
    const status = err?.response?.statusCode || 500;
    res.status(status).json({
      error: "Repricing failed",
      description: err?.description || err?.message || "Unknown error",
      details: err?.response?.result || undefined,
    });
  }
});

export default router;
