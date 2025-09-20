// hotels.routes.js
import { Router } from "express";

const router = Router();

// --- DATA (same as your last working single-file server) ---
const DESTS = [
  { name: "Budapest", country: "Hungary" },
  { name: "Buenos Aires", country: "Argentina" },
  { name: "Bucharest", country: "Romania" },
  { name: "Buraydah", country: "Saudi Arabia" },
  { name: "Bursa", country: "Turkey" },
  { name: "Bulgaria", country: "" },
  { name: "Berlin", country: "Germany" },
  { name: "Milan", country: "Italy" },
  { name: "Manchester City", country: "UK" },
  { name: "Seychelles", country: "" },
  { name: "Cape Town", country: "South Africa" },
  { name: "Barcelona", country: "Spain" }
];

const HOTELS = [
  {
    id: "1",
    title: "Taksim The Capital Cordon Hotel",
    price: 120,
    rating: 4.8,
    tags: ["Deal", "Popular"],
    distance: "2.4 km from center",
    perks: ["Free Wi-Fi", "Breakfast", "No hidden fees"],
    img: "https://images.unsplash.com/photo-1551776235-dde6d4829808?q=80&w=1200&auto=format&fit=crop",
    city: "Istanbul"
  },
  {
    id: "2",
    title: "Ultra House",
    price: 520,
    rating: 4.6,
    tags: ["New"],
    distance: "900 m from center",
    perks: ["Pool", "Gym", "Free cancellation"],
    img: "https://images.unsplash.com/photo-1551880237-6e72491e3415?q=80&w=1200&auto=format&fit=crop",
    city: "Paris"
  },
  {
    id: "3",
    title: "Radisson Blu Hotel",
    price: 350,
    rating: 4.7,
    tags: ["Popular"],
    distance: "3.1 km from center",
    perks: ["Restaurant", "Spa", "No hidden fees"],
    img: "https://images.unsplash.com/photo-1560448075-bb4caa6c8df5?q=80&w=1200&auto=format&fit=crop",
    city: "Paris"
  }
];

const NEARBY = [
  {
    id: "n1",
    title: "Radison Blu Hotel",
    img: "https://images.unsplash.com/photo-1560448075-bb4caa6c8df5?q=80&w=1200&auto=format&fit=crop",
    price: 250,
    nights: "1 day, 1 guest",
    distance: "6.9 km from the center of the city",
    score: "9.6",
    scoreText: "Exceptional (2522 reviews)",
    badge: "Guest Favourite"
  },
  {
    id: "n2",
    title: "Club Travel Hotel",
    img: "https://images.unsplash.com/photo-1551880237-6e72491e3415?q=80&w=1200&auto=format&fit=crop",
    price: 500,
    nights: "1 day, 1 guest",
    distance: "1.9 km from the center of the city",
    score: "9.0",
    scoreText: "Excellent (1801 reviews)",
    badge: "Guest Favourite"
  }
];

const LUX = [
  {
    id: "l1",
    title: "Hotel Pari Cherie",
    city: "Paris, France",
    img: "https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?q=80&w=1200&auto=format&fit=crop"
  }
];

const nightsBetween = (a, b) => {
  if (!a || !b) return 0;
  const A = new Date(a);
  const B = new Date(b);
  return Math.max(0, Math.round((B - A) / 86400000));
};

// ---- ROUTES ----

// Typeahead destinations
router.get("/destinations", (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (!q) return res.json([]);
  res.json(DESTS.filter(d => d.name.toLowerCase().startsWith(q)));
});

// Showcase sections
router.get("/showcase", (_req, res) => {
  res.json({ nearby: NEARBY, luxury: LUX });
});

// Hotels search
router.get("/hotels", (req, res) => {
  const { destination = "", sort = "Recommended" } = req.query;
  const dest = destination.toString().trim().toLowerCase();

  let results = HOTELS.filter(h =>
    dest ? (h.city || "").toLowerCase().includes(dest) : true
  );

  switch (sort) {
    case "Cheapest":
      results = [...results].sort((a, b) => a.price - b.price);
      break;
    case "Higher rating":
      results = [...results].sort((a, b) => b.rating - a.rating);
      break;
    case "Newest listings":
      results = [...results].sort((a, b) => Number(b.id) - Number(a.id));
      break;
    case "Closest to city center": {
      const km = s => {
        const m = /([0-9.]+)\s*km/i.exec(s);
        return m ? Number(m[1]) : 9999;
      };
      results = [...results].sort((a, b) => km(a.distance) - km(b.distance));
      break;
    }
    default:
      break;
  }

  res.json({ hotels: results });
});

// Rooms by hotel and dates
router.get("/hotels/:id/rooms", (req, res) => {
  const { id } = req.params;
  const h = HOTELS.find(x => x.id === id);
  if (!h) return res.status(404).json({ error: "Hotel not found" });

  const { checkIn, checkOut } = req.query;
  const nights = Math.max(1, nightsBetween(checkIn, checkOut));

  const rooms = [
    {
      id: "r1",
      name: "Standard Room",
      bed: "1 Queen bed · 20 m²",
      img: "https://images.unsplash.com/photo-1551776235-dde6d4829808?q=80&w=1200&auto=format&fit=crop",
      price: h.price,
      tags: ["Free cancellation"],
      perks: ["Pay at the property","No prepayment required","Free Wi-Fi","Air conditioning","No hidden fees"]
    },
    {
      id: "r2",
      name: "Deluxe Room",
      bed: "1 King bed · 28 m²",
      img: "https://images.unsplash.com/photo-1600585154526-990dced4db0d?q=80&w=1200&auto=format&fit=crop",
      price: Math.round(h.price * 1.6),
      tags: ["Breakfast included","Free cancellation"],
      perks: ["City view","Late checkout","Free Wi-Fi","Air conditioning","No hidden fees"]
    },
    {
      id: "r3",
      name: "Executive Suite",
      bed: "1 King bed · 45 m²",
      img: "https://images.unsplash.com/photo-1501117716987-c8e1ecb2101f?q=80&w=1200&auto=format&fit=crop",
      price: Math.round(h.price * 2.1),
      tags: ["Most popular"],
      perks: ["Separate living area","Free Wi-Fi","Breakfast","Free cancellation","No hidden fees"]
    }
  ];

  res.json({ nights, rooms });
});

export default router;
