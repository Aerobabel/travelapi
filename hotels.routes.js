// hotels.routes.js
import { Router } from "express";
import Amadeus from "amadeus";

const router = Router();

// ---------------------------
// Amadeus client
// ---------------------------
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  // hostname: process.env.AMADEUS_HOSTNAME || 'test', // set 'production' in env for live
});

// ---------------------------
// Unsplash helpers (real photos)
// ---------------------------
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || "";
const UNSPLASH_ENDPOINT = "https://api.unsplash.com/search/photos";

const imgCache = new Map(); // simple in-memory cache to avoid hitting rate limits
const IMG_CACHE_MAX = 1000;
function setCache(key, val) {
  if (imgCache.size > IMG_CACHE_MAX) {
    // delete first inserted key (naive LRU-ish)
    const first = imgCache.keys().next().value;
    if (first) imgCache.delete(first);
  }
  imgCache.set(key, val);
}
async function fetchUnsplashImage(query, { fallbackSeed = "hotel" } = {}) {
  const key = query.trim().toLowerCase();
  if (imgCache.has(key)) return imgCache.get(key);

  if (!UNSPLASH_ACCESS_KEY) {
    const f = fallbackImg(fallbackSeed);
    setCache(key, f);
    return f;
  }

  try {
    const url = new URL(UNSPLASH_ENDPOINT);
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", "1");
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("content_filter", "high");
    url.searchParams.set("client_id", UNSPLASH_ACCESS_KEY);

    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`Unsplash ${r.status}`);
    const json = await r.json();
    const hit = json?.results?.[0];
    const chosen =
      hit?.urls?.regular ||
      hit?.urls?.full ||
      hit?.urls?.raw ||
      fallbackImg(fallbackSeed);

    setCache(key, chosen);
    return chosen;
  } catch (e) {
    console.error("unsplash error", e?.message || e);
    const f = fallbackImg(fallbackSeed);
    setCache(key, f);
    return f;
  }
}

// ---------------------------
// General Helpers
// ---------------------------
const nightsBetween = (a, b) => {
  if (!a || !b) return 0;
  const A = new Date(a);
  const B = new Date(b);
  return Math.max(0, Math.round((B - A) / 86400000));
};

const fallbackImg = (seed = "hotel") =>
  `https://images.unsplash.com/photo-1551776235-dde6d4829808?q=80&w=1200&auto=format&fit=crop&sig=${encodeURIComponent(
    seed
  )}`;

// Map Amadeus hotel offer → your frontend Hotel card (image injected later)
const mapOfferToHotelCard = (offerItem) => {
  const hotel = offerItem.hotel || {};
  const firstOffer = (offerItem.offers && offerItem.offers[0]) || {};
  const priceTotal = Number(firstOffer.price?.total ?? firstOffer.price?.base ?? 0);

  return {
    id: hotel.hotelId || String(Math.random()),
    title: hotel.name || "Hotel",
    price: priceTotal || 0,
    rating: hotel.rating ? Number(hotel.rating) : 0,
    tags: [],
    distance:
      hotel.distance?.value && hotel.distance?.unit
        ? `${hotel.distance.value} ${hotel.distance.unit.toLowerCase()} from center`
        : "—",
    perks: ["Free Wi-Fi", "No hidden fees"],
    img: fallbackImg(hotel.name), // replaced asynchronously with Unsplash
    city: hotel.cityCode || "",
  };
};

// Map Amadeus room offer → your frontend Room card (image injected later)
const mapOfferToRoom = (offer, nights) => {
  const desc = offer.room?.description?.text || "";
  const type = offer.room?.typeEstimated || {};
  const beds =
    type.beds && type.bedType
      ? `${type.beds} ${String(type.bedType).toLowerCase()} bed${type.beds > 1 ? "s" : ""}`
      : desc || "Room";

  const total = Number(offer.price?.total || 0);
  const perNight = nights > 0 ? Math.round(total / nights) : total;

  const tags = [];
  if (offer.policies?.cancellations?.length) tags.push("Free cancellation");
  if (offer.boardType) tags.push(offer.boardType);

  const perks = ["No hidden fees"];
  if (offer.room?.typeEstimated?.category) perks.push(offer.room.typeEstimated.category);
  if (offer.room?.type) perks.push(offer.room.type);

  return {
    id: offer.id || Math.random().toString(36).slice(2),
    name: offer.room?.name || "Room",
    bed: beds,
    img: fallbackImg(offer.room?.name || "room"), // replaced asynchronously with Unsplash
    price: perNight,
    tags,
    perks,
  };
};

// City keyword → IATA city code
async function resolveCityCode(keyword) {
  if (!keyword) return null;
  try {
    const res = await amadeus.referenceData.locations.get({
      keyword,
      subType: "CITY",
      "page[limit]": 5,
    });
    const first = res?.data?.find((x) => x.iataCode) || res?.data?.[0];
    return first?.iataCode || null;
  } catch {
    return null;
  }
}

// List hotelIds by city (required by v3 /shopping/hotel-offers)
async function listHotelIdsByCity(cityCode) {
  try {
    const r = await amadeus.referenceData.locations.hotels.byCity.get({
      cityCode,
      // radius: 25, radiusUnit: "KM",
    });
    return (r?.data || []).map((h) => h.hotelId);
  } catch (e) {
    console.error("listHotelIdsByCity error", e?.response?.data || e);
    return [];
  }
}

// Chunk helper to stay under URL length limits
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fetch hotel offers in chunks of hotelIds to avoid 2048-byte URL limit.
 * Returns a merged, de-duped array of v3 hotel offer items.
 */
async function fetchOffersForHotelIdsChunked(hotelIds, baseParams = {}, chunkSize = 30) {
  const chunks = chunkArray(hotelIds, chunkSize);
  const results = [];
  for (const ids of chunks) {
    try {
      const r = await amadeus.shopping.hotelOffersSearch.get({
        ...baseParams,
        hotelIds: ids.join(","),
      });
      if (Array.isArray(r?.data)) results.push(...r.data);
    } catch (e) {
      console.error("hotelOffersSearch chunk error", e?.response?.data || e);
      // continue with other chunks
    }
  }
  // de-dupe by hotelId
  const seen = new Set();
  const deduped = [];
  for (const item of results) {
    const hid = item?.hotel?.hotelId || JSON.stringify(item?.hotel || {});
    if (seen.has(hid)) continue;
    seen.add(hid);
    deduped.push(item);
  }
  return deduped;
}

// ---------------------------
// SHOWCASE (Paris demo, chunked, with Unsplash images)
// ---------------------------
async function getShowcase() {
  try {
    const today = new Date();
    const checkIn = new Date(today);
    checkIn.setDate(checkIn.getDate() + 14);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);

    const hotelIds = (await listHotelIdsByCity("PAR")).slice(0, 60);
    if (!hotelIds.length) throw new Error("No hotels for PAR");

    const items = await fetchOffersForHotelIdsChunked(
      hotelIds,
      {
        adults: 1,
        checkInDate: checkIn.toISOString().slice(0, 10),
        checkOutDate: checkOut.toISOString().slice(0, 10),
        sort: "PRICE",
        "page[limit]": 20,
        currencyCode: "USD",
      },
      25
    );

    // Build cards + fetch Unsplash images in parallel
    const nearbyRaw = items.slice(0, 6);
    const nearby = await Promise.all(
      nearbyRaw.map(async (o, i) => {
        const title = o.hotel?.name || "Hotel";
        const city = "Paris";
        const img =
          await fetchUnsplashImage(`${title} hotel ${city}`, { fallbackSeed: title }) ||
          fallbackImg(title);
        return {
          id: `n${i + 1}`,
          title,
          img,
          price: Number(o.offers?.[0]?.price?.total || 0),
          nights: "1 day, 1 guest",
          distance:
            o.hotel?.distance?.value && o.hotel?.distance?.unit
              ? `${o.hotel.distance.value} ${o.hotel.distance.unit.toLowerCase()} from the center of the city`
              : "—",
          score: (o.hotel?.rating || "9.0").toString(),
          scoreText: "Excellent",
          badge: "Guest Favourite",
        };
      })
    );

    const luxRaw = items.slice(0, 3);
    const luxury = await Promise.all(
      luxRaw.map(async (o, i) => {
        const title = o.hotel?.name || "Luxury Hotel";
        const img =
          await fetchUnsplashImage(`${title} luxury hotel Paris`, { fallbackSeed: `${title}-lux` }) ||
          fallbackImg(`${title}-lux`);
        return {
          id: `l${i + 1}`,
          title,
          city: `Paris, France`,
          img,
        };
      })
    );

    return { nearby, luxury };
  } catch {
    return {
      nearby: [
        {
          id: "n1",
          title: "Radisson Blu Hotel",
          img: fallbackImg("radisson"),
          price: 250,
          nights: "1 day, 1 guest",
          distance: "—",
          score: "9.2",
          scoreText: "Excellent",
          badge: "Guest Favourite",
        },
      ],
      luxury: [
        {
          id: "l1",
          title: "Hotel Pari Cherie",
          city: "Paris, France",
          img: fallbackImg("paris-lux"),
        },
      ],
    };
  }
}

// ---------------------------
// ROUTES
// ---------------------------

// Typeahead destinations
router.get("/destinations", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const r = await amadeus.referenceData.locations.get({
      keyword: q,
      subType: "CITY",
      "page[limit]": 8,
    });
    const data =
      r?.data?.map((x) => ({
        name: x.name || x.detailedName || x.address?.cityName || x.iataCode || q,
        country: x.address?.countryCode || "",
      })) ?? [];
    const seen = new Set();
    const out = data.filter((d) => {
      const key = `${d.name}|${d.country}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json(out);
  } catch (e) {
    console.error("destinations error", e?.response?.data || e);
    res.json([]);
  }
});

// Showcase sections
router.get("/showcase", async (_req, res) => {
  const payload = await getShowcase();
  res.json(payload);
});

// Hotels search (chunked + Unsplash)
router.get("/hotels", async (req, res) => {
  const { destination = "", checkIn, checkOut, sort = "Recommended" } = req.query;

  try {
    const cityCode =
      (await resolveCityCode(String(destination))) ||
      (String(destination).length === 3 ? String(destination).toUpperCase() : null);

    if (!cityCode) return res.json({ hotels: [] });

    const hotelIds = (await listHotelIdsByCity(cityCode)).slice(0, 120);
    if (!hotelIds.length) return res.json({ hotels: [] });

    const baseParams = {
      adults: 1,
      currencyCode: "USD",
      "page[limit]": 50,
    };
    if (checkIn) baseParams.checkInDate = String(checkIn);
    if (checkOut) baseParams.checkOutDate = String(checkOut);

    const items = await fetchOffersForHotelIdsChunked(hotelIds, baseParams, 30);

    // Map → UI, then swap images with Unsplash (parallelized)
    let hotels = await Promise.all(
      items.map(async (it) => {
        const card = mapOfferToHotelCard(it);
        const city = it.hotel?.cityCode || cityCode;
        const img =
          await fetchUnsplashImage(`${card.title} hotel ${city}`, { fallbackSeed: card.title }) ||
          fallbackImg(card.title);
        return { ...card, img };
      })
    );

    // Sorts expected by your frontend
    switch (sort) {
      case "Cheapest":
        hotels.sort((a, b) => (a.price || 0) - (b.price || 0));
        break;
      case "Higher rating":
        hotels.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        break;
      case "Closest to city center":
        hotels.sort((a, b) => {
          const km = (s) => {
            const m = /([0-9.]+)\s*([a-z]+)/i.exec(s || "");
            return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
          };
          return km(a.distance) - km(b.distance);
        });
        break;
      case "Newest listings":
        hotels.sort(() => Math.random() - 0.5);
        break;
      default:
        break;
    }

    res.json({ hotels });
  } catch (e) {
    console.error("hotels error", e?.response?.data || e);
    res.json({ hotels: [] });
  }
});

// Rooms by hotel and dates (Unsplash “hotel room interior”)
router.get("/hotels/:id/rooms", async (req, res) => {
  const { id } = req.params;
  const { checkIn, checkOut } = req.query;

  const nights = Math.max(1, nightsBetween(checkIn, checkOut));

  try {
    const params = {
      hotelIds: id,
      "page[limit]": 20,
      currencyCode: "USD",
    };
    if (checkIn) params.checkInDate = String(checkIn);
    if (checkOut) params.checkOutDate = String(checkOut);

    const r = await amadeus.shopping.hotelOffersSearch.get(params);
    const items = r?.data?.[0]?.offers || [];
    const baseRooms = items.map((offer) => mapOfferToRoom(offer, nights));

    // Replace room images with Unsplash variants (parallel)
    const rooms = await Promise.all(
      baseRooms.map(async (room, idx) => {
        const img =
          await fetchUnsplashImage(`${room.name} hotel room interior`, { fallbackSeed: `${room.name}-${idx}` }) ||
          room.img;
        return { ...room, img };
      })
    );

    res.json({ nights, rooms });
  } catch (e) {
    console.error("rooms error", e?.response?.data || e);
    res.json({ nights, rooms: [] });
  }
});

export default router;
