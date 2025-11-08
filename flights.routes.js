// flights.routes.js
import express from 'express';
import Amadeus from 'amadeus';

const router = express.Router();

// Amadeus client (uses sandbox by default; set AMADEUS_HOSTNAME=production for live)
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  hostname: process.env.AMADEUS_HOSTNAME || 'production', // 'test' | 'production'
});

/* ------------------------- helpers ------------------------- */

const getCode = (label) => {
  if (!label) return null;
  const s = String(label).trim();
  const m = /\(([A-Za-z]{3})\)/.exec(s);
  if (m) return m[1].toUpperCase();
  const parts = s.split(',').map(t => t.trim());
  const last = parts[parts.length - 1] || s;
  if (/^[A-Za-z]{3}$/i.test(last)) return last.toUpperCase();
  if (/^[A-Za-z]{3}$/i.test(s)) return s.toUpperCase();
  return null;
};

const normalizeOffer = (fo) => {
  const price = Number(fo?.price?.grandTotal || fo?.price?.total || 0);
  const it = fo?.itineraries?.[0];
  const seg0 = it?.segments?.[0];
  const segLast = it?.segments?.[it?.segments?.length - 1];

  const departISO = seg0?.departure?.at || '';
  const arriveISO = segLast?.arrival?.at || '';
  const depart = departISO.slice(11, 16);
  const arrive = arriveISO.slice(11, 16);

  const carrier = seg0?.carrierCode || fo?.validatingAirlineCodes?.[0] || '';
  const airportFrom = seg0?.departure?.iataCode || '';
  const airportTo = segLast?.arrival?.iataCode || '';
  const duration = (it?.duration || '').replace('PT', '').toLowerCase();

  return {
    id: fo?.id || `${airportFrom}-${airportTo}-${depart}`,
    price: Math.round(price),
    airline: carrier,
    duration,
    depart,
    arrive,
    airportFrom,
    airportTo,
    _raw: fo,
  };
};

/* ------------------------- routes ------------------------- */

// Airports autocomplete
router.get('/airports', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json([]);

    const { data } = await amadeus.referenceData.locations.get({
      keyword: q,
      subType: 'AIRPORT',
      'page[limit]': 12,
    });

    const rows = (data || [])
      .map(x => ({
        city: x?.address?.cityName || x?.iataCode || '',
        code: x?.iataCode || '',
        country: x?.address?.countryName || x?.address?.countryCode || '',
      }))
      .filter(r => r.code);

    res.json(rows);
  } catch (err) {
    console.error('airports error', err);
    res.json([]);
  }
});

// Flight search (one-way / round / multi)
router.post('/flights/search', async (req, res) => {
  try {
    const {
      from,
      to,
      departDate,
      returnDate,
      tripType = 'oneway', // 'oneway' | 'round' | 'multi'
      passengers = { adults: 1, children: 0, infants: 0 },
      travelClass = 'ECONOMY',
      currencyCode = 'USD',
      legs = [],
    } = req.body || {};

    // Build originDestinations
    const originDestinations = [];
    const pushLeg = (originLabel, destLabel, dateStr, idStr) => {
      const origin = getCode(originLabel);
      const dest = getCode(destLabel);
      if (!origin || !dest || !dateStr) return;
      originDestinations.push({
        id: idStr,
        originLocationCode: origin,
        destinationLocationCode: dest,
        departureDateTimeRange: { date: dateStr },
      });
    };

    if (tripType === 'multi') {
      (Array.isArray(legs) ? legs : []).forEach((l, i) =>
        pushLeg(l.from, l.to, l.date, String(i + 1))
      );
    } else {
      pushLeg(from, to, departDate, '1');
      if (tripType === 'round' && returnDate) pushLeg(to, from, returnDate, '2');
    }

    if (!originDestinations.length) {
      return res
        .status(400)
        .json({ error: 'Missing/invalid originDestinations (origin, destination, and date are required).' });
    }

    // Travelers
    let travelerId = 1;
    const travelers = [];
    const addTrav = (n, type) => {
      for (let i = 0; i < (Number(n) || 0); i++)
        travelers.push({ id: String(travelerId++), travelerType: type });
    };
    addTrav(passengers.adults ?? 1, 'ADULT');
    addTrav(passengers.children ?? 0, 'CHILD');
    addTrav(passengers.infants ?? 0, 'HELD_INFANT');

    // Cabin restriction applies across provided originDestinationIds
    const cabin = (travelClass || 'ECONOMY').toUpperCase();
    const originDestinationIds = originDestinations.map(o => o.id);

    const payload = {
      currencyCode,
      originDestinations,
      travelers: travelers.length ? travelers : [{ id: '1', travelerType: 'ADULT' }],
      sources: ['GDS'],
      searchCriteria: {
        flightFilters: {
          cabinRestrictions: [
            { cabin, coverage: 'MOST_SEGMENTS', originDestinationIds },
          ],
        },
      },
    };

    // CRITICAL: Amadeus SDK .post() requires a STRING body
    const { data } = await amadeus.shopping.flightOffersSearch.post(JSON.stringify(payload));
    const offers = (data || []).map(normalizeOffer);

    res.json({ offers });
  } catch (err) {
    console.error('flights search error', err);
    const api = err?.response?.result;
    if (api?.errors) return res.status(400).json(api);
    res.status(500).json({ error: 'Internal error', detail: err?.message || String(err) });
  }
});

// Cheapest-date price rows
router.get('/flights/date-prices', async (req, res) => {
  try {
    const origin = getCode(req.query.origin);
    const destination = getCode(req.query.destination);
    const from = (req.query.from || '').toString().slice(0, 10);
    const to = (req.query.to || '').toString().slice(0, 10);
    const currencyCode = (req.query.currencyCode || 'USD').toString();

    if (!origin || !destination || !from || !to) {
      return res.json({ rows: [] });
    }

    const { data } = await amadeus.shopping.flightDates.get({
      origin,
      destination,
      departureDate: `${from},${to}`,
      currencyCode,
    });

    const rows = (data || []).map(d => ({
      date: d?.departureDate,
      price: Number(d?.price?.total || 0),
    }));

    res.json({ rows });
  } catch (err) {
    console.error('date-prices error', err);
    res.json({ rows: [] });
  }
});

// Price/validate an offer
router.post('/flights/price', async (req, res) => {
  try {
    const offer = req.body?.offer;
    if (!offer) return res.status(400).json({ error: 'Missing offer' });

    const payload = {
      data: {
        type: 'flight-offers-pricing',
        flightOffers: [offer],
      },
    };

    const priced = await amadeus.shopping.flightOffers.pricing.post(JSON.stringify(payload));
    res.json({ priced: priced?.result || priced });
  } catch (err) {
    console.error('price error', err);
    const api = err?.response?.result;
    if (api?.errors) return res.status(400).json(api);
    res.status(500).json({ error: 'Internal error', detail: err?.message || String(err) });
  }
});

export default router;
