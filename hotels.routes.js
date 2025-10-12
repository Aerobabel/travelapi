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
  // hostname: process.env.AMADEUS_HOSTNAME || 'test', // set to 'production' in env for live
});

// ---------------------------
// Helpers
// ---------------------------
const nightsBetween = (a, b) => {
  if (!a || !b) return 0;
  const A = new Date(a);
  const B = new Date(b);
  return Math.max(0, Math.round((B - A) / 86400000));
};

// Basic fallback image if the API doesn't provide media (Self-Service Hotel APIs don't include images)
const fallbackImg = (seed = "hotel") =>
  `https://images.unsplash.com/photo-1551776235-dde6d4829808?q=80&w=1200&auto=format&fit=crop&sig=${encodeURIComponent(
    seed
  )}`;

// Map Amadeus hotel offer → your frontend Hotel card
const mapOfferToHotelCard = (offerItem) => {
  const hotel = offerItem.hotel || {};
  const firstOffer = (offerItem.offers && offerItem.offers[0]) || {};
  const priceTotal = Number(firstOffer.price?.total ?? firstOffer.price?.base ?? 0);

  return {
    id: hotel.hotelId || String(Math.random()),
    title: hotel.name || "Hotel",
    price: priceTotal || 0, // total stay price when dates provided; otherwise 0 (front-end still renders)
    rating: hotel.rating ? Number(hotel.rating) : 0,
    tags: [], // Amadeus doesn't expose marketing tags in Self-Service; keep empty
    distance:
      hotel.distance?.value && hotel.distance?.unit
        ? `${hotel.distance.value} ${hotel.distance.unit.toLowerCase()} from center`
        : "—",
    perks: ["Free Wi-Fi", "No hidden fees"], // simple defaults; enrich per policy if desired
    img: fallbackImg(hotel.name),
    city: hotel.cityCode || "",
  };
};

// Map Amadeus room offer → your frontend Room card
const mapOfferToRoom = (offer, nights) => {
  const desc = offer.room?.description?.text || "";
  const type = offer.room?.typeEstimated || {};
  const beds =
    type.beds && type.bedType
      ? `${type.beds} ${String(type.bedType).toLowerCase()} bed${type.beds > 1 ? "s" : ""}`
      : desc || "Room";

  // Amadeus price.total is for the whole stay; convert to per-night for your UI
  const total = Number(offer.price?.total || 0);
  const perNight = nights > 0 ? Math.round(total / nights) : total;

  const tags = [];
  if (offer.policies?.cancellations?.length) tags.push("Free cancellation");
  if (offer.boardType) tags.push(offer.boardType); // e.g., "BREAKFAST"

  const perks = ["No hidden fees"];
  if (offer.room?.typeEstimated?.category) perks.push(offer.room.typeEstimated.category);
  if (offer.room?.type) perks.push(offer.room.type);

  return {
    id: offer.id || Math.random().toString(36).slice(2),
    name: offer.room?.name || "Room",
    bed: beds,
    img: fallbackImg(offer.room?.name || "room"),
    price: perNight, // per night (your UI expects this)
    tags,
    perks,
  };
};

// Resolve a free-text city to IATA city code via Amadeus Locations API
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
      // radius: 25, radiusUnit: 'KM', // optional filters
      // 'page[limit]': 200,
    });
    return (r?.data || []).map((h) => h.hotelId);
  } catch (e) {
    console.error("listHotelIdsByCity error", e?.response?.data || e);
    return [];
  }
}

// ---------------------------
// SHOWCASE (simple, dynamic sample using Paris offers as “nearby/lux” demo)
// ---------------------------
async function getShowcase() {
  // A tiny dynamic showcase seeded from PAR. Uses hotelIds (v3 requirement).
  try {
    const today = new Date();
    const checkIn = new Date(today);
    checkIn.setDate(checkIn.getDate() + 14);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);

    const hotelIds = (await listHotelIdsByCity("PAR")).slice(0, 50);
    if (!hotelIds.length) throw new Error("No hotels found for PAR");

    const r = await amadeus.shopping.hotelOffersSearch.get({
      hotelIds: hotelIds.join(","),
      adults: 1,
      checkInDate: checkIn.toISOString().slice(0, 10),
      checkOutDate: checkOut.toISOString().slice(0, 10),
      sort: "PRICE",
      "page[limit]": 12,
      currencyCode: "USD",
    });

    const offers = r?.data || [];
    const nearby = offers.slice(0, 6).map((o, i) => ({
      id: `n${i + 1}`,
      title: o.hotel?.name || "Hotel",
      img: fallbackImg(o.hotel?.name),
      price: Number(o.offers?.[0]?.price?.total || 0),
      nights: "1 day, 1 guest",
      distance:
        o.hotel?.distance?.value && o.hotel?.distance?.unit
          ? `${o.hotel.distance.value} ${o.hotel.distance.unit.toLowerCase()} from the center of the city`
          : "—",
      score: (o.hotel?.rating || "9.0").toString(),
      scoreText: "Excellent",
      badge: "Guest Favourite",
    }));

    const lux = offers.slice(0, 3).map((o, i) => ({
      id: `l${i + 1}`,
      title: o.hotel?.name || "Luxury Hotel",
      city: `Paris, France`,
      img: fallbackImg(`${o.hotel?.name}-lux`),
    }));

    return { nearby, luxury: lux };
  } catch {
    // Silent fallback to a tiny static set if Amadeus fails
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

// Typeahead destinations (Amadeus Locations API)
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
    // Dedup by city name
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

// Showcase sections (built from Amadeus best-effort; falls back silently)
router.get("/showcase", async (_req, res) => {
  const payload = await getShowcase();
  res.json(payload);
});

// Hotels search (Amadeus Hotel Offers Search v3 requires hotelIds)
// Query: destination (free text city), checkIn, checkOut, sort
router.get("/hotels", async (req, res) => {
  const { destination = "", checkIn, checkOut, sort = "Recommended" } = req.query;

  try {
    const cityCode =
      (await resolveCityCode(String(destination))) ||
      (String(destination).length === 3 ? String(destination).toUpperCase() : null);

    if (!cityCode) return res.json({ hotels: [] });

    // v3 requires hotelIds: list hotels by city → get their IDs
    const hotelIds = (await listHotelIdsByCity(cityCode)).slice(0, 200);
    if (!hotelIds.length) return res.json({ hotels: [] });

    const params = {
      hotelIds: hotelIds.join(","),
      adults: 1,
      currencyCode: "USD",
      "page[limit]": 200,
    };

    if (checkIn) params.checkInDate = String(checkIn);
    if (checkOut) params.checkOutDate = String(checkOut);
    if (sort === "Cheapest") params.sort = "PRICE"; // server-side price sort

    const r = await amadeus.shopping.hotelOffersSearch.get(params);
    let items = r?.data || [];

    // Map to your card model
    let hotels = items.map(mapOfferToHotelCard);

    // Additional sorts that Amadeus doesn't provide server-side
    switch (sort) {
      case "Higher rating":
        hotels = hotels.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        break;
      case "Newest listings":
        // No "createdAt" in Self-Service; randomize to avoid bias
        hotels = hotels.sort(() => Math.random() - 0.5);
        break;
      case "Closest to city center":
        hotels = hotels.sort((a, b) => {
          const km = (s) => {
            const m = /([0-9.]+)\s*([a-z]+)/i.exec(s || "");
            return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
          };
          return km(a.distance) - km(b.distance);
        });
        break;
      default:
        // Recommended → leave as-is
        break;
    }

    res.json({ hotels });
  } catch (e) {
    console.error("hotels error", e?.response?.data || e);
    res.json({ hotels: [] });
  }
});

// Rooms by hotel and dates (Amadeus Hotel Offers by Hotel)
router.get("/hotels/:id/rooms", async (req, res) => {
  const { id } = req.params;
  const { checkIn, checkOut } = req.query;

  const nights = Math.max(1, nightsBetween(checkIn, checkOut));

  try {
    const params = {
      hotelIds: id, // v3 requires hotelIds
      "page[limit]": 20,
      currencyCode: "USD",
    };
    if (checkIn) params.checkInDate = String(checkIn);
    if (checkOut) params.checkOutDate = String(checkOut);

    const r = await amadeus.shopping.hotelOffersSearch.get(params);
    const items = r?.data?.[0]?.offers || []; // response groups by hotel
    const rooms = items.map((offer) => mapOfferToRoom(offer, nights));

    res.json({ nights, rooms });
  } catch (e) {
    console.error("rooms error", e?.response?.data || e);
    res.json({ nights, rooms: [] });
  }
});

export default router;
