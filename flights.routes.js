// flights.routes.js
import express from 'express';
import Amadeus from 'amadeus';
import {
  mergeFlightOffers,
  refreshDuffelOffer,
  searchDuffelOffers,
} from './duffel.provider.js';

const router = express.Router();
const PRICE_HISTORY_LIMIT = 600;
const flightPriceHistory = [];

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

const toPriceNumber = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

const getDaysUntil = (dateStr) => {
  if (!dateStr) return null;
  const date = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.ceil((date - today) / 86400000);
};

const buildPriceHistoryKey = (originDestinations = [], currencyCode = 'USD') => {
  const route = originDestinations
    .map((leg) => [
      leg.originLocationCode,
      leg.destinationLocationCode,
      leg.departureDateTimeRange?.date,
    ].filter(Boolean).join('-'))
    .filter(Boolean)
    .join('|');
  return `${String(currencyCode || 'USD').toUpperCase()}::${route}`;
};

const percentileForPrice = (values = [], price) => {
  const clean = values
    .map(toPriceNumber)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const amount = toPriceNumber(price);
  if (!amount || clean.length < 2) return 50;
  const firstAtOrAbove = clean.findIndex((value) => value >= amount);
  const rank = firstAtOrAbove === -1 ? clean.length - 1 : firstAtOrAbove;
  return Math.max(0, Math.min(100, Math.round((rank / (clean.length - 1)) * 100)));
};

const medianPrice = (values = []) => {
  const clean = values
    .map(toPriceNumber)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
};

const computePriceSignal = ({ key, originDestinations, offer, comparisonPrices }) => {
  const price = toPriceNumber(offer?.price);
  if (!price) return null;

  const historyPrices = flightPriceHistory
    .filter((row) => row.key === key)
    .map((row) => row.price);
  const prices = [...historyPrices, ...comparisonPrices].filter((value) => toPriceNumber(value) !== null);
  const index = percentileForPrice(prices, price);
  const daysUntil = getDaysUntil(originDestinations?.[0]?.departureDateTimeRange?.date);
  const min = Math.min(...prices, price);
  const max = Math.max(...prices, price);
  const median = medianPrice(prices) || price;

  let action = 'WATCH';
  let actionLabel = 'Watch';
  let reason = 'Comparable with current route prices';
  if (daysUntil !== null && daysUntil <= 10) {
    action = 'BUY';
    actionLabel = 'Buy now';
    reason = 'Trip is close, repricing risk is higher';
  } else if (index <= 30) {
    action = 'BUY';
    actionLabel = 'Buy now';
    reason = 'Price is in the cheap range for this search';
  } else if (index >= 75 && (daysUntil === null || daysUntil > 21)) {
    action = 'WAIT';
    actionLabel = 'Wait';
    reason = 'Price is high and dates are not urgent';
  }

  const label = index <= 30 ? 'Cheap' : index >= 70 ? 'High' : 'Fair';
  const confidence = prices.length >= 12 ? 'high' : prices.length >= 5 ? 'medium' : 'low';

  return {
    index,
    label,
    action,
    actionLabel,
    confidence,
    reason,
    sampleCount: prices.length,
    historyCount: historyPrices.length,
    daysUntil,
    min,
    median: Math.round(median * 100) / 100,
    max,
  };
};

const enrichOffersWithPriceSignals = (offers = [], originDestinations = [], currencyCode = 'USD') => {
  const key = buildPriceHistoryKey(originDestinations, currencyCode);
  const comparisonPrices = offers.map((offer) => offer.price);
  return offers.map((offer) => ({
    ...offer,
    priceSignal: computePriceSignal({ key, originDestinations, offer, comparisonPrices }),
  }));
};

const rememberFlightPrices = (offers = [], originDestinations = [], currencyCode = 'USD') => {
  const key = buildPriceHistoryKey(originDestinations, currencyCode);
  if (!key.includes('-')) return;
  const searchedAt = new Date().toISOString();
  offers.forEach((offer) => {
    const price = toPriceNumber(offer?.price);
    if (!price) return;
    flightPriceHistory.push({
      key,
      price,
      currency: String(offer.currency || currencyCode || 'USD').toUpperCase(),
      provider: offer.provider || offer.source || 'unknown',
      offerId: offer.id || '',
      searchedAt,
    });
  });
  if (flightPriceHistory.length > PRICE_HISTORY_LIMIT) {
    flightPriceHistory.splice(0, flightPriceHistory.length - PRICE_HISTORY_LIMIT);
  }
};

const normalizeOffer = (fo) => {
  const priceObj = fo?.price || {};
  const price = Number(priceObj.grandTotal || priceObj.total || 0);
  const currency = priceObj.currency || 'USD'; // Capture currency

  const it = fo?.itineraries?.[0];
  const segs = it?.segments || [];
  const seg0 = segs[0];
  const segLast = segs[segs.length - 1];

  const departISO = seg0?.departure?.at || '';
  const arriveISO = segLast?.arrival?.at || '';
  const depart = departISO.slice(11, 16);
  const arrive = arriveISO.slice(11, 16);

  const carrier = seg0?.carrierCode || fo?.validatingAirlineCodes?.[0] || '';
  const airportFrom = seg0?.departure?.iataCode || '';
  const airportTo = segLast?.arrival?.iataCode || '';
  const isoDuration = it?.duration || '';
  const duration = isoDuration.replace('PT', '').toLowerCase();

  const parseIsoDurationToMinutes = (iso) => {
    if (!iso || typeof iso !== 'string') return null;
    const h = iso.match(/(\d+)H/);
    const m = iso.match(/(\d+)M/);
    const hours = h ? parseInt(h[1], 10) : 0;
    const mins = m ? parseInt(m[1], 10) : 0;
    return hours * 60 + mins;
  };

  const durationMinutes = parseIsoDurationToMinutes(isoDuration);

  let maxLayoverMinutes = 0;
  let hasOvernightLayover = false;
  for (let i = 0; i < segs.length - 1; i++) {
    const a = new Date(segs[i].arrival.at);
    const d = new Date(segs[i + 1].departure.at);
    const diffMin = (d - a) / 60000;
    if (diffMin > maxLayoverMinutes) maxLayoverMinutes = diffMin;
    if (a.getDate() !== d.getDate()) hasOvernightLayover = true;
  }

  const stops = Math.max(0, segs.length - 1);

  return {
    id: fo?.id || `${airportFrom}-${airportTo}-${depart}`,
    source: 'amadeus',
    provider: 'Amadeus',
    price: price, // Return raw float (e.g. 150.50)
    currency,     // Return currency code
    airline: carrier,
    duration,
    depart,
    arrive,
    airportFrom,
    airportTo,
    stops,
    durationMinutes,
    maxLayoverMinutes,
    hasOvernightLayover,
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
    const searchCurrencyCode = String(process.env.FLIGHT_CURRENCY_CODE || currencyCode || 'USD').toUpperCase();

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
      currencyCode: searchCurrencyCode,
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

    const providerResults = await Promise.allSettled([
      amadeus.shopping.flightOffersSearch.post(JSON.stringify(payload)),
      searchDuffelOffers({ originDestinations, passengers, travelClass }),
    ]);

    let amadeusOffers = [];
    let duffelOffers = [];
    const providers = {
      amadeus: { ok: false, count: 0 },
      duffel: { ok: false, count: 0 },
    };

    if (providerResults[0].status === 'fulfilled') {
      amadeusOffers = (providerResults[0].value?.data || []).map(normalizeOffer);
      providers.amadeus = { ok: true, count: amadeusOffers.length };
    } else {
      providers.amadeus = {
        ok: false,
        count: 0,
        error: providerResults[0].reason?.response?.result?.errors?.[0]?.detail ||
          providerResults[0].reason?.message ||
          'Amadeus search failed',
      };
      console.error('amadeus flights search error', providerResults[0].reason);
    }

    if (providerResults[1].status === 'fulfilled') {
      duffelOffers = providerResults[1].value?.offers || [];
      providers.duffel = {
        ok: true,
        count: duffelOffers.length,
        offerRequestId: providerResults[1].value?.offerRequestId,
      };
    } else {
      providers.duffel = {
        ok: false,
        count: 0,
        error: providerResults[1].reason?.message || 'Duffel search failed',
      };
      if (providerResults[1].reason?.code !== 'DUFFEL_MISSING_TOKEN') {
        console.error('duffel flights search error', providerResults[1].reason);
      }
    }

    const offers = enrichOffersWithPriceSignals(
      mergeFlightOffers(amadeusOffers, duffelOffers),
      originDestinations,
      searchCurrencyCode
    );
    rememberFlightPrices(offers, originDestinations, searchCurrencyCode);

    if (!offers.length && providerResults[0].status === 'rejected' && providerResults[1].status === 'rejected') {
      const api = providerResults[0].reason?.response?.result;
      if (api?.errors) return res.status(400).json(api);
      return res.status(502).json({
        error: 'No flight provider returned offers',
        providers,
      });
    }

    res.json({
      offers,
      providers,
      priceIntel: {
        key: buildPriceHistoryKey(originDestinations, searchCurrencyCode),
        historySize: flightPriceHistory.length,
        model: 'rule_based_mvp',
      },
    });
  } catch (err) {
    console.error('flights search error', err);
    const api = err?.response?.result;
    if (api?.errors) return res.status(400).json(api);
    res.status(500).json({ error: 'Internal error', detail: err?.message || String(err) });
  }
});

// Lightweight PIE signal for a known flight price.
router.get('/flights/price-index', async (req, res) => {
  try {
    const origin = getCode(req.query.origin);
    const destination = getCode(req.query.destination);
    const departDate = String(req.query.departDate || '').slice(0, 10);
    const currencyCode = String(req.query.currencyCode || 'USD').toUpperCase();
    const price = toPriceNumber(req.query.price);

    if (!origin || !destination || !departDate || !price) {
      return res.json({ priceSignal: null });
    }

    const originDestinations = [{
      id: '1',
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDateTimeRange: { date: departDate },
    }];
    const key = buildPriceHistoryKey(originDestinations, currencyCode);
    const offer = { price, currency: currencyCode };

    res.json({
      priceSignal: computePriceSignal({
        key,
        originDestinations,
        offer,
        comparisonPrices: [price],
      }),
    });
  } catch (err) {
    console.error('price-index error', err);
    res.json({ priceSignal: null });
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
    rows.forEach((row) => {
      const price = toPriceNumber(row.price);
      if (!price || !row.date) return;
      rememberFlightPrices(
        [{ id: `date-${row.date}`, price, currency: currencyCode, provider: 'Amadeus date-prices' }],
        [{
          id: '1',
          originLocationCode: origin,
          destinationLocationCode: destination,
          departureDateTimeRange: { date: row.date },
        }],
        currencyCode
      );
    });

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

    if (offer?.provider === 'duffel') {
      const offerId = offer.id || offer.providerOfferId;
      const { offer: refreshed } = await refreshDuffelOffer(offerId);
      return res.json({
        priced: {
          data: {
            flightOffers: [
              {
                price: {
                  grandTotal: String(refreshed.price),
                  currency: refreshed.currency,
                },
              },
            ],
          },
        },
        offer: refreshed,
      });
    }

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
