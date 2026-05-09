// activities.routes.js
import express from "express";
import Amadeus from "amadeus";

const router = express.Router();

const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  hostname: process.env.AMADEUS_HOSTNAME || "production",
});

const FALLBACK_COVER =
  "https://images.unsplash.com/photo-1522098543979-ffc7f79d7f6b?q=80&w=1470&auto=format&fit=crop";

const KNOWN_CITIES = [
  { name: "Paris", label: "Paris, France", iataCode: "PAR", countryCode: "FR", latitude: 48.85341, longitude: 2.3488 },
  { name: "Rome", label: "Rome, Italy", iataCode: "ROM", countryCode: "IT", latitude: 41.90278, longitude: 12.49637 },
  { name: "Amsterdam", label: "Amsterdam, Netherlands", iataCode: "AMS", countryCode: "NL", latitude: 52.3676, longitude: 4.9041 },
  { name: "London", label: "London, United Kingdom", iataCode: "LON", countryCode: "GB", latitude: 51.50722, longitude: -0.1275 },
  { name: "Prague", label: "Prague, Czechia", iataCode: "PRG", countryCode: "CZ", latitude: 50.07554, longitude: 14.4378 },
  { name: "Barcelona", label: "Barcelona, Spain", iataCode: "BCN", countryCode: "ES", latitude: 41.38879, longitude: 2.15899 },
  { name: "Vienna", label: "Vienna, Austria", iataCode: "VIE", countryCode: "AT", latitude: 48.20849, longitude: 16.37208 },
  { name: "Istanbul", label: "Istanbul, Turkiye", iataCode: "IST", countryCode: "TR", latitude: 41.01384, longitude: 28.94966 },
  { name: "New York", label: "New York, United States", iataCode: "NYC", countryCode: "US", latitude: 40.71278, longitude: -74.006 },
  { name: "Dubai", label: "Dubai, United Arab Emirates", iataCode: "DXB", countryCode: "AE", latitude: 25.20485, longitude: 55.27078 },
];

const alias = (path) => [path, `/api${path}`];
const sourceConfidence = (source, note, confidence = "high") => ({ source, confidence, note });

function cleanKeyword(value) {
  const first = String(value || "").split(",")[0].trim();
  return first.replace(/[^a-z0-9 ]/gi, "").slice(0, 10);
}

function cityLabel(city) {
  const country = city?.address?.countryCode || city?.countryCode || "";
  return country ? `${city.name}, ${country}` : city.name;
}

function normalizeCity(city) {
  if (!city) return null;
  const latitude = Number(city.geoCode?.latitude ?? city.latitude);
  const longitude = Number(city.geoCode?.longitude ?? city.longitude);
  return {
    name: city.name,
    label: city.label || cityLabel(city),
    iataCode: city.iataCode,
    countryCode: city.address?.countryCode || city.countryCode,
    latitude,
    longitude,
  };
}

function localCityMatches(query, limit = 8) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  return KNOWN_CITIES.filter((city) => city.label.toLowerCase().includes(q) || city.name.toLowerCase().includes(q)).slice(0, limit);
}

async function searchCities(query, limit = 8) {
  const keyword = cleanKeyword(query);
  if (keyword.length < 3) return localCityMatches(query, limit);

  try {
    const response = await amadeus.referenceData.locations.cities.get({
      keyword,
      max: limit,
    });
    const cities = (response?.data || []).map(normalizeCity).filter(Boolean);
    const merged = [...cities, ...localCityMatches(query, limit)];
    const seen = new Set();
    return merged.filter((city) => {
      const key = `${city.name}-${city.countryCode || ""}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
  } catch (error) {
    console.warn("Amadeus city search failed", error?.description || error?.message || error);
    return localCityMatches(query, limit);
  }
}

async function resolveCity(location) {
  const matches = await searchCities(location, 1);
  return matches[0] || KNOWN_CITIES[0];
}

function parseAmount(value) {
  if (typeof value === "number") return value;
  const amount = parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeActivity(activity, city) {
  const price = activity?.price || {};
  const amount = parseAmount(price.amount);
  const rating = Number(activity?.rating);
  return {
    id: activity?.id || `${city?.iataCode || "city"}-${activity?.name || Math.random()}`,
    title: activity?.name || "Destination experience",
    city: city?.label || city?.name || "Destination",
    badge: rating >= 4.7 ? "Top Rated" : "Activity",
    tag: activity?.type || "Tours & Activities",
    rating: Number.isFinite(rating) && rating > 0 ? Number(rating.toFixed(1)) : 4.7,
    reviews: Number(activity?.reviews || activity?.reviewCount || 0),
    price: amount,
    currency: price.currencyCode || "USD",
    length: "Activity",
    cover: activity?.pictures?.[0] || FALLBACK_COVER,
    description: activity?.shortDescription || activity?.description || "Book this destination experience with a local activity provider.",
    bookingLink: activity?.bookingLink || null,
    geoCode: activity?.geoCode || null,
    sourceConfidence: sourceConfidence("amadeus_destination_experiences", "Live Amadeus Tours and Activities response."),
  };
}

router.get(alias("/activities/cities"), async (req, res, next) => {
  try {
    const q = String(req.query.q || req.query.query || "").trim();
    const max = Math.max(1, Math.min(Number(req.query.max || 8), 20));
    const cities = await searchCities(q, max);
    res.json({ cities });
  } catch (error) {
    next(error);
  }
});

router.get(alias("/activities"), async (req, res, next) => {
  try {
    const location = String(req.query.location || req.query.city || "Paris").trim();
    const radius = Math.max(1, Math.min(Number(req.query.radius || 20), 100));
    const city = await resolveCity(location);

    try {
      const response = await amadeus.shopping.activities.get({
        latitude: city.latitude,
        longitude: city.longitude,
        radius,
      });
      const experiences = (response?.data || [])
        .map((activity) => normalizeActivity(activity, city))
        .filter((activity) => activity.title)
        .slice(0, 40);
      res.json({ location: city, source: "amadeus", experiences });
    } catch (error) {
      console.warn("Amadeus activities failed", error?.description || error?.message || error);
      res.json({
        location: city,
        source: "fallback",
        experiences: [],
        sourceConfidence: sourceConfidence(
          "amadeus_destination_experiences",
          "Amadeus request failed or returned no usable activities.",
          "low"
        ),
      });
    }
  } catch (error) {
    next(error);
  }
});

export default router;
