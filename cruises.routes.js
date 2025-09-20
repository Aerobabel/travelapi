// cruises.routes.js (mock, no database)
// Exposes endpoints for destinations, ports, lines, recommended and search.

import { Router } from "express";

const router = Router();

/* ------------------------------ Mock Data ------------------------------ */

const DESTINATIONS = [
  { slug: "bahamas", name: "Bahamas" },
  { slug: "caribbean-e", name: "Caribbean - Eastern" },
  { slug: "caribbean-s", name: "Caribbean - Southern" },
  { slug: "caribbean-w", name: "Caribbean - Western" },
  { slug: "alaska", name: "Alaska" },
  { slug: "antarctic", name: "Antarctic Cruises" },
  { slug: "nile", name: "Nile River" },
];

const PORTS = [
  { code: "BCN", name: "Barcelona" },
  { code: "ATH", name: "Athens / Piraeus" },
  { code: "AKL", name: "Auckland" },
  { code: "BAL", name: "Balboa / Panama" },
  { code: "BWI", name: "Baltimore" },
  { code: "BOS", name: "Boston" },
  { code: "ANU", name: "Antigua" },
  { code: "AUA", name: "Aruba" },
];

const LINES = [
  { id: "carnival", name: "Carnival Cruise Line", logo: "https://upload.wikimedia.org/wikipedia/commons/5/54/Carnival_Cruise_Line_Logo.svg" },
  { id: "msc", name: "MSC Cruises", logo: "https://upload.wikimedia.org/wikipedia/commons/f/f5/MSC_Cruises_logo.svg" },
  { id: "disney", name: "Disney Cruise Line", logo: "https://upload.wikimedia.org/wikipedia/en/b/b3/Disney_Cruise_Line_logo.svg" },
  { id: "viking", name: "Viking Ocean Cruises", logo: "https://upload.wikimedia.org/wikipedia/commons/5/5e/Viking_Cruises_logo.svg" },
  { id: "seabourn", name: "Seabourn", logo: "https://upload.wikimedia.org/wikipedia/commons/f/f2/Seabourn_Cruise_Line_logo.svg" },
];

const IMG1 = "https://images.unsplash.com/photo-1501117716987-c8e8da3a1808?q=80&w=1600&auto=format&fit=crop";
const IMG2 = "https://images.unsplash.com/photo-1501555088652-021faa106b9b?q=80&w=1600&auto=format&fit=crop";
const IMG3 = "https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=1600&auto=format&fit=crop";

let _id = 1000;
const uid = () => String(_id++);

// small pool of mock cruises
const CRUISES = [
  {
    id: uid(),
    title: "Bahamas Getaway",
    line_id: "carnival",
    destination_slug: "bahamas",
    port_code: "BCN",
    depart_date: "2025-11-15",
    nights: 6,
    city: "Nassau, Bahamas",
    rating: 9.6,
    reviews: 26522,
    price: 3000,
    old_price: 3469,
    class_name: "Premium",
    img: IMG1,
    perks: { pickup: true, wifi: true, shore: true, custom: false, dining: true },
  },
  {
    id: uid(),
    title: "Eastern Caribbean Discovery",
    line_id: "msc",
    destination_slug: "caribbean-e",
    port_code: "ATH",
    depart_date: "2025-12-02",
    nights: 7,
    city: "San Juan, Puerto Rico",
    rating: 9.0,
    reviews: 8500,
    price: 3450,
    old_price: null,
    class_name: "Luxury",
    img: IMG2,
    perks: { pickup: false, wifi: true, shore: true, custom: true, dining: true },
  },
  {
    id: uid(),
    title: "Caribbean Fun Voyage",
    line_id: "disney",
    destination_slug: "caribbean-w",
    port_code: "BOS",
    depart_date: "2025-09-10",
    nights: 8,
    city: "Key West, USA",
    rating: 8.8,
    reviews: 30000,
    price: 2500,
    old_price: null,
    class_name: "Standard",
    img: IMG3,
    perks: { pickup: false, wifi: true, shore: false, custom: false, dining: false },
  },
  {
    id: uid(),
    title: "Alaskan Fjords",
    line_id: "viking",
    destination_slug: "alaska",
    port_code: "BWI",
    depart_date: "2025-08-21",
    nights: 10,
    city: "Juneau, USA",
    rating: 9.2,
    reviews: 11200,
    price: 5200,
    old_price: 5600,
    class_name: "Luxury",
    img: IMG1,
    perks: { pickup: true, wifi: true, shore: true, custom: true, dining: true },
  },
  {
    id: uid(),
    title: "Nile Treasures",
    line_id: "seabourn",
    destination_slug: "nile",
    port_code: "AKL",
    depart_date: "2025-10-05",
    nights: 5,
    city: "Luxor, Egypt",
    rating: 9.1,
    reviews: 7400,
    price: 4100,
    old_price: null,
    class_name: "Premium",
    img: IMG2,
    perks: { pickup: true, wifi: false, shore: true, custom: false, dining: true },
  },
];

/* ------------------------------- Helpers ------------------------------- */

const tagsFromPerks = (p = {}) => {
  const t = [];
  if (p.pickup) t.push("Hotel pickup");
  if (p.wifi) t.push("Wi-Fi onboard");
  if (p.shore) t.push("Shore excursions");
  if (p.custom) t.push("Custom itinerary");
  if (p.dining) t.push("Fine dining");
  return t;
};

const normalizeCruise = (r) => {
  const line = LINES.find((l) => String(l.id) === String(r.line_id));
  return {
    id: r.id,
    title: r.title || (line?.name ?? "Cruise"),
    line: line?.name ?? "",
    logo: line?.logo ?? "",
    destination: r.destination_slug,
    port: r.port_code,
    departDate: r.depart_date,
    nights: Number(r.nights || 0),
    city: r.city || "",
    rating: Number(r.rating || 0),
    reviews: Number(r.reviews || 0),
    price: Number(r.price || 0),
    oldPrice: r.old_price ? Number(r.old_price) : null,
    className: r.class_name || null,
    img: r.img || IMG3,
    perks: r.perks || {},
    badges: r.old_price ? ["Limited offer"] : [],
    days: `${Number(r.nights || 0)} days · 1 guest`,
    daysTxt: `${Number(r.nights || 0)} nights · 2 guests`,
    tags: tagsFromPerks(r.perks || {}),
  };
};

const applyFiltersAndSort = (items, filters = {}, sort = "rec") => {
  let list = [...items];

  // price
  if (filters.price && Array.isArray(filters.price)) {
    const [min, max] = filters.price;
    list = list.filter((c) => c.price >= min && c.price <= max);
  }

  // classes
  if (filters.classes?.length) {
    const set = new Set(filters.classes.map((s) => s.toLowerCase()));
    list = list.filter((c) => set.has(String(c.className || "").toLowerCase()));
  }

  // duration buckets
  if (filters.duration?.length) {
    list = list.filter((c) => {
      const d = Number(c.nights || 0);
      return filters.duration.some((bucket) => {
        if (bucket === "22+") return d >= 22;
        const [a, b] = bucket.split("-").map(Number);
        return d >= a && d <= b;
      });
    });
  }

  // perks
  if (filters.perks) {
    const want = filters.perks;
    list = list.filter((c) => {
      const p = c.perks || {};
      return (!want.pickup || p.pickup) &&
             (!want.wifi || p.wifi) &&
             (!want.shore || p.shore) &&
             (!want.custom || p.custom) &&
             (!want.dining || p.dining);
    });
  }

  // sort
  switch (sort) {
    case "cheap": list.sort((a, b) => a.price - b.price); break;
    case "fast":  list.sort((a, b) => (a.nights || 0) - (b.nights || 0)); break;
    case "early": list.sort((a, b) => String(a.departDate || "").localeCompare(String(b.departDate || ""))); break;
    default:      list.sort((a, b) => (b.rating || 0) - (a.rating || 0)); // rec
  }

  return list;
};

/* -------------------------------- Routes -------------------------------- */

router.get("/cruises/destinations", (_req, res) => {
  res.json({ destinations: DESTINATIONS });
});

router.get("/cruises/ports", (_req, res) => {
  res.json({ ports: PORTS });
});

router.get("/cruises/lines", (_req, res) => {
  res.json({ lines: LINES });
});

// recommended (top by rating)
router.get("/cruises/recommended", (_req, res) => {
  const list = [...CRUISES].sort((a, b) => b.rating - a.rating).slice(0, 6).map(normalizeCruise);
  res.json({ cruises: list });
});

/**
 * POST /cruises/search
 * Body:
 * { destinations:[slug], ports:[code], date?: "YYYY-MM-DD", lines:[lineId],
 *   filters:{ classes:[], price:[min,max], duration:[], perks:{} },
 *   sort:"rec"|"cheap"|"fast"|"early" }
 */
router.post("/cruises/search", (req, res) => {
  const {
    destinations = [],
    ports = [],
    date = null,
    lines = [],
    filters = { classes: [], price: [2000, 10000], duration: [], perks: {} },
    sort = "rec",
  } = req.body || {};

  let base = CRUISES.filter((c) => {
    const okDest = !destinations?.length || destinations.includes(c.destination_slug);
    const okPort = !ports?.length || ports.includes(c.port_code);
    const okDate = !date || c.depart_date === date; // change to >= if needed
    const okLine = !lines?.length || lines.map(String).includes(String(c.line_id));
    return okDest && okPort && okDate && okLine;
  }).map(normalizeCruise);

  const offers = applyFiltersAndSort(base, filters, sort);

  const summary = {
    where:
      (destinations?.length ? `${destinations.length} destination(s)` : "All destinations") +
      (ports?.length ? ` · ${ports.length} port(s)` : ""),
    when: date || "Any date",
    lines: lines?.length || 0,
    total: offers.length,
    filters,
  };

  res.json({ summary, cruises: offers });
});

// Optional: pretend booking endpoint (stores in memory)
const BOOKINGS = [];
router.post("/cruises/book", (req, res) => {
  const { cruiseId, contact } = req.body || {};
  if (!cruiseId || !contact?.name || !contact?.email) {
    return res.status(400).json({ error: "Missing cruiseId or contact.name/email" });
  }
  const id = uid();
  const rec = { id, status: "confirmed", created_at: new Date().toISOString(), cruiseId, contact };
  BOOKINGS.unshift(rec);
  res.json({ booking: rec });
});

export default router;
