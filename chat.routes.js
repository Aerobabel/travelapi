// server/chat.routes.js
// npm i openai dotenv node-fetch
// .env => OPENAI_API_KEY=***, UNSPLASH_ACCESS_KEY=***
// This route powers /chat/travel with:
// - Purpose follow-up after destination
// - Real images (Unsplash) with rotation
// - Average weather for selected dates (Open-Meteo)
// - Deterministic pricing (no "depends")
// - Lightweight memory of preferences (learned + explicit fields)
// - Photo recognition (country/city/POI) using OpenAI Vision
// - Hooks to generate walking routes (stubbed call pattern)

import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const router = Router();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------------------------------------------------------------ */
/*                          SIMPLE IN-MEMORY DB                        */
/* ------------------------------------------------------------------ */
const userMem = new Map(); // key: userId => { profile, lastPhotos[], lastDest }
function getMem(userId) {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        preferred_travel_type: null,              // "beach" | "active" | "urban" | "relaxing"
        travel_alone_or_with: null,               // "solo" | "family" | "friends"
        desired_experience: [],                   // ["fun","relaxation","photography","luxury","local culture"]
        flight_preferences: { class: "economy" }, // "economy" | "premium_economy" | "business" | "first"
        flight_priority: [],                      // ["price","comfort","duration"]
        accommodation: {
          preferred_type: null,                   // "hotel" | "apartment" | "villa" | "hostel"
          prefer_view: "doesn't matter",          // "sea" | "mountains" | "city" | "doesn't matter"
        },
        budget: { prefer_comfort_or_saving: "balanced" }, // "comfort" | "saving" | "balanced"
        preferred_formats: [],                    // ["cruise","roadtrip","resort","adventure","cultural"]
        liked_activities: [],                     // ["hiking","wine tasting","museums","shopping","extreme sports"]
      },
      lastDest: null,
      lastPhotos: [], // rotate
    });
  }
  return userMem.get(userId);
}

/* ------------------------------------------------------------------ */
/*                             UTILITIES                               */
/* ------------------------------------------------------------------ */
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;

// Basic destination extractor (quick heuristic)
function extractDestination(text = "") {
  const m = text.match(/\b(to|in|for)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (m) return m[2];
  // fallback: look for common city names (extendable)
  const list = ["Paris","London","Rome","Barcelona","Bali","Tokyo","New York","Dubai","Istanbul","Amsterdam","Madrid","Milan","Kyoto","Lisbon","Prague"];
  for (const city of list) {
    const re = new RegExp(`\\b${city}\\b`, "i");
    if (re.test(text)) return city;
  }
  return null;
}

// Unsplash search -> {photos: [urls...]}, safe to call without revealing key to client
async function getDestinationPhotos(q, count = 5) {
  if (!UNSPLASH_KEY) return [];
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${Math.min(
    10,
    count * 2
  )}&orientation=landscape`;
  const r = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` } });
  if (!r.ok) return [];
  const data = await r.json();
  const urls = (data.results || [])
    .map((x) => x?.urls?.regular || x?.urls?.full || x?.urls?.small)
    .filter(Boolean);
  return urls.slice(0, count);
}

// Rotate photos per user/destination
function pickPhoto(mem, dest, fallback) {
  if (mem.lastDest !== dest) {
    mem.lastDest = dest;
    mem.lastPhotos = [];
  }
  if (!mem.lastPhotos.length) return fallback;
  const url = mem.lastPhotos.shift();
  return url || fallback;
}

// Open-Meteo monthly/average for given dates and lat/lon
// For a quick demo we use geocoding via Open-Meteo's free geocoding.
async function geocodePlace(place) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const hit = j?.results?.[0];
  if (!hit) return null;
  return { lat: hit.latitude, lon: hit.longitude, name: hit.name, country: hit.country };
}

function parseISO(d) {
  const m = d.match(/\d{4}-\d{2}-\d{2}/g);
  if (!m || m.length < 2) return null;
  return { start: m[0], end: m[1] };
}

function daysBetween(a, b) {
  const A = new Date(a + "T00:00:00Z");
  const B = new Date(b + "T00:00:00Z");
  return Math.max(1, Math.round((B - A) / (1000 * 60 * 60 * 24)));
}

async function getAverageWeather(place, startISO, endISO) {
  const geo = await geocodePlace(place);
  if (!geo) return null;
  const days = daysBetween(startISO, endISO);

  // Daily temps, then average.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&daily=temperature_2m_max,temperature_2m_min&start_date=${startISO}&end_date=${endISO}&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const max = j?.daily?.temperature_2m_max || [];
  const min = j?.daily?.temperature_2m_min || [];
  if (!max.length || !min.length) return null;
  const avg =
    (max.reduce((s, x) => s + x, 0) + min.reduce((s, x) => s + x, 0)) / (max.length + min.length);

  // rough icon based on average
  const icon = avg >= 25 ? "sunny-outline" : avg >= 15 ? "partly-sunny-outline" : "cloud-outline";
  return { tempC: Math.round(avg), icon, meta: { days, lat: geo.lat, lon: geo.lon, country: geo.country } };
}

/* ------------------------------------------------------------------ */
/*                          PRICING ENGINE                              */
/* ------------------------------------------------------------------ */
// Always returns a number (USD). No "depends".
function priceTrip({ place, days, pax, className, comfortBias }) {
  // Base per-day by place popularity (very crude but deterministic)
  const baseMap = {
    Paris: 240, London: 260, Rome: 200, Barcelona: 190, Bali: 110, Tokyo: 230,
    "New York": 300, Dubai: 260, Istanbul: 150, Amsterdam: 210, Madrid: 180, Milan: 210, Lisbon: 170, Kyoto: 220, Prague: 160
  };
  const base = baseMap[place] || 180;

  // Flight class multiplier
  const classMult = { economy: 1.0, premium_economy: 1.25, business: 1.9, first: 2.6 }[className || "economy"];

  // Comfort bias affects hotel share
  const comfortMult = { saving: 0.9, balanced: 1.0, comfort: 1.25 }[comfortBias || "balanced"];

  // Pax economy: first person full, others 0.7
  const paxCostMult = (pax <= 1) ? 1 : (1 + (pax - 1) * 0.7);

  // Fixed extras (activities, transfers)
  const extrasPerTrip = 120;

  const total = base * days * comfortMult * paxCostMult * 1.15 * classMult + extrasPerTrip;
  // Round to nearest $10
  return Math.round(total / 10) * 10;
}

/* ------------------------------------------------------------------ */
/*                     PHOTO RECOGNITION (VISION)                      */
/* ------------------------------------------------------------------ */
async function recognizePlaceFromUrl(imageUrl) {
  const prompt = `Identify the likely country and city (if possible) and a notable landmark/building/waterfall name for this photo. Respond JSON with keys: country, city, landmark, confidence (0-1). Keep it short.`;
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: "You extract place information from a photograph." },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });
  const raw = resp.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(raw); } catch { return { country: null, city: null, landmark: null, confidence: 0.0 }; }
}

/* ------------------------------------------------------------------ */
/*                         WALKING ROUTE (HOOK)                        */
/* ------------------------------------------------------------------ */
// Example: fetch a simple loop in city center (plug your provider key if needed).
// You can swap to OpenRouteService or Mapbox Directions (profile=walking).
async function buildWalkingRoute(place) {
  // Placeholder: return 3–5 point-of-interest titles & rough order.
  // If you wire OSRM/ORS, return encoded polyline + step list here.
  const curated = {
    Paris: ["Louvre", "Seine Banks", "Notre-Dame", "Latin Quarter", "Luxembourg Gardens"],
    Rome: ["Colosseum", "Roman Forum", "Trevi Fountain", "Pantheon", "Piazza Navona"],
    Barcelona: ["Sagrada Família", "Passeig de Gràcia", "Gothic Quarter", "La Rambla", "Barceloneta"],
  };
  const steps = curated[place] || ["City Center", "Market", "Main Square", "Park", "Museum"];
  return { mode: "walking", estimated_km: 5, steps };
}

/* ------------------------------------------------------------------ */
/*                          TOOL DECLARATIONS                          */
/* ------------------------------------------------------------------ */
const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description:
        "Call when you need the user's travel dates. Keep your text minimal; client shows a date picker.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description:
        "Call when you need the number of travelers (adults/children). Client shows a guest picker.",
      parameters: {
        type: "object",
        properties: {
          minInfo: { type: "string", description: "Optional note, e.g. 'adults and children'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Call when destination + dates + guests known (or the user explicitly asks to build). Returns a plan card.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          dates: { type: "string" },
          description: { type: "string" },
          image: { type: "string" },
          price: { type: "string" },
          weather: {
            type: "object",
            properties: {
              tempC: { type: "number" },
              icon: { type: "string" },
            },
          },
        },
        required: ["location", "dates", "description", "image", "price"],
      },
    },
  },
  // New: recognize place from an image URL the user sends
  {
    type: "function",
    function: {
      name: "recognize_place",
      description: "Identify country/city/landmark from a photo URL.",
      parameters: {
        type: "object",
        properties: {
          imageUrl: { type: "string" },
        },
        required: ["imageUrl"],
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/*                       SYSTEM BEHAVIOR / STYLE                       */
/* ------------------------------------------------------------------ */
const SYSTEM = `
You are a proactive, friendly travel planner.

Non-negotiable UI rules for the mobile client:
- If you need DATES, call request_dates (plus one short friendly line).
- If you need GUESTS, call request_guests (plus one short friendly line).
- When ready, call create_plan.
- Never wait for "ok". Keep replies crisp and warm.

Planning rules:
- After the user mentions a destination, ASK their PURPOSE for the trip (business, relax, sightseeing, etc.).
- Always produce concrete prices (USD) with an exact number. Never say "it depends".
- Rotate destination photos; pick one fresh each plan if available.
- Include average weather (°C) for the given dates in the plan payload.
- Learn user preferences over time (memory). If preferences are known, use them.
- If the user shares a photo and asks "where is this?", call recognize_place.

Data collection to improve recommendations (do not nag; ask contextually):
- preferred_travel_type ("beach","active","urban","relaxing")
- travel_alone_or_with ("solo","family","friends")
- desired_experience (["fun","relaxation","photography","luxury","local culture"])
- flight_preferences.class ("economy","premium_economy","business","first")
- flight_priority (["price","comfort","duration"])
- accommodation.preferred_type ("hotel","apartment","villa","hostel")
- accommodation.prefer_view ("sea","mountains","city","doesn't matter")
- budget.prefer_comfort_or_saving ("comfort","saving","balanced")
- preferred_formats (["cruise","roadtrip","resort","adventure","cultural"])
- liked_activities (["hiking","wine tasting","museums","shopping","extreme sports"])
`;

/* ------------------------------------------------------------------ */
/*                        HISTORY UTIL / SLOTS                         */
/* ------------------------------------------------------------------ */
function toOpenAIMessages(history = []) {
  return history.map((m) =>
    m.role === "user"
      ? { role: "user", content: m.text }
      : m.role === "system"
      ? { role: "system", content: m.text }
      : { role: "assistant", content: m.text }
  );
}

function findLastSnapshotIndex(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.text && /\[plan_snapshot\]/i.test(history[i].text)) return i;
  }
  return -1;
}

function deriveSlots(history = []) {
  const startIdx = findLastSnapshotIndex(history) + 1;
  const recent = history.slice(startIdx);
  const userTexts = recent.filter((m) => m.role === "user").map((m) => m.text).join("\n");
  const txt = userTexts.toLowerCase();

  const datesKnown = /📅/.test(txt) || /from\s+\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(userTexts);
  const guestsKnown =
    /👤/.test(txt) ||
    (/(adult|adults|children|kids|\bguests?\b|\bpeople\b)/i.test(userTexts) && /\d/.test(userTexts));

  const dest = extractDestination(userTexts);
  const destinationKnown = !!dest;

  // naive purpose detection
  const purposeKnown = /(business|work|conference|relax|relaxing|beach|sightseeing|tour|honeymoon|family|friends|photography|food)/i.test(
    userTexts
  );
  return { destinationKnown, destination: dest, datesKnown, guestsKnown, purposeKnown };
}

function guessDatesFromHistory(history) {
  const txt = history.filter((m) => m.role === "user").map((m) => m.text).join(" ");
  const m = txt.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (m) return { start: m[1], end: m[2], pretty: `${m[1]} – ${m[2]}` };
  return null;
}

/* ------------------------------------------------------------------ */
/*                                ROUTE                                */
/* ------------------------------------------------------------------ */
router.post("/chat/travel", async (req, res) => {
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);

    // Learn explicit preferences if user types them
    const joined = messages.filter((m) => m.role === "user").map((m) => m.text).join("\n").toLowerCase();
    // very light inference
    if (/i (like|love).*(hiking|museums|shopping|wine|extreme)/.test(joined)) {
      const act = joined.match(/hiking|museums|shopping|wine tasting|extreme sports/);
      if (act && !mem.profile.liked_activities.includes(act[0])) mem.profile.liked_activities.push(act[0]);
    }
    if (/prefer(ed)? view:?\s*(sea|mountains|city|doesn't matter)/.test(joined)) {
      const v = joined.match(/sea|mountains|city|doesn't matter/)[0];
      mem.profile.accommodation.prefer_view = v;
    }

    // Base conversation
    const convo = [{ role: "system", content: SYSTEM }, ...toOpenAIMessages(messages)];

    // Let the model respond first (we’ll still enforce tools/slots after)
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: convo,
      tools,
      tool_choice: "auto",
      temperature: 0.3,
    });

    let aiText = completion.choices?.[0]?.message?.content || "";
    let signal = null;
    let toolCall = completion.choices?.[0]?.message?.tool_calls?.[0];

    // Handle recognize_place tool directly if requested by user via photo URL
    if (toolCall?.function?.name === "recognize_place") {
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
      const info = await recognizePlaceFromUrl(args.imageUrl);
      aiText = `Looks like ${info.landmark ? info.landmark + ", " : ""}${info.city || ""}${info.city && info.country ? ", " : ""}${info.country || ""} (confidence ${Math.round((info.confidence || 0)*100)}%).`;
      return res.json({ aiText, signal: null });
    }

    // If the model asked for a UI tool, reflect that
    if (toolCall) {
      const { name } = toolCall.function;
      let args = {};
      try { args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}; } catch {}
      if (name === "request_dates") {
        signal = { type: "dateNeeded" };
        if (!aiText) aiText = "Great — pick your travel dates below 👇";
      } else if (name === "request_guests") {
        signal = { type: "guestsNeeded", payload: args };
        if (!aiText) aiText = "Awesome — how many are traveling? 👇";
      } else if (name === "create_plan") {
        signal = { type: "planReady", payload: args };
        if (!aiText) aiText = "Here’s your plan ✨";
      }
    }

    // Slots-based enforcement & purpose follow-up
    const slots = deriveSlots(messages);

    // Ask purpose right after destination appears (once)
    if (!signal && slots.destinationKnown && !slots.purposeKnown) {
      aiText =
        aiText ||
        `Nice choice — ${slots.destination}! Is this more of a business trip, a relaxing getaway, or sightseeing/photography?`;
      return res.json({ aiText, signal: null });
    }

    if (!signal && slots.destinationKnown && !slots.datesKnown) {
      signal = { type: "dateNeeded" };
      aiText = aiText || "Great — pick your travel dates below 👇";
    }
    if (!signal && slots.destinationKnown && slots.datesKnown && !slots.guestsKnown) {
      signal = { type: "guestsNeeded", payload: { minInfo: "adults and children" } };
      aiText = aiText || "How many travelers are going? 👇";
    }

    // If we can build a plan, enrich with real data
    if (!signal && slots.destinationKnown && slots.datesKnown && slots.guestsKnown) {
      const dest = slots.destination;
      const datesObj = guessDatesFromHistory(messages);
      const prettyDates = datesObj?.pretty || "Your dates";
      const startISO = datesObj?.start || null;
      const endISO = datesObj?.end || null;

      // pull Unsplash photos and store to rotate
      if (UNSPLASH_KEY) {
        const photoList = await getDestinationPhotos(dest, 6);
        if (photoList.length) {
          mem.lastDest = dest;
          mem.lastPhotos = photoList.slice(); // copy
        }
      }
      const fallbackImg =
        "https://images.unsplash.com/photo-1543342384-1bbd4b285d05?q=80&w=1600&auto=format&fit=crop";
      const image = pickPhoto(mem, dest, fallbackImg);

      // weather avg
      const weather =
        startISO && endISO ? await getAverageWeather(dest, startISO, endISO) : null;

      // price (deterministic)
      const paxMatch = joined.match(/(\d+)\s*(adult|adults|people|guests)/);
      const childrenMatch = joined.match(/(\d+)\s*(child|children|kids)/);
      const adults = paxMatch ? parseInt(paxMatch[1], 10) : 1;
      const children = childrenMatch ? parseInt(childrenMatch[1], 10) : 0;
      const pax = adults + children;

      const className = mem.profile.flight_preferences?.class || "economy";
      const comfortBias = mem.profile.budget?.prefer_comfort_or_saving || "balanced";
      const days = datesObj?.start && datesObj?.end ? daysBetween(datesObj.start, datesObj.end) : 4;
      const amount = priceTrip({ place: dest, days, pax, className, comfortBias });
      const price = `$${amount.toLocaleString("en-US")}`;

      // walking route (quick hint)
      const walk = await buildWalkingRoute(dest);

      const description =
        `A ${days}-day ${walk?.mode} plan across ${dest} with ${walk?.steps?.length || 4} key stops. ` +
        `We’ll tune hotels to your comfort level and include ${mem.profile.liked_activities?.slice(0,2).join(", ") || "local highlights"}.`;

      signal = {
        type: "planReady",
        payload: {
          location: dest,
          dates: prettyDates,
          description,
          image,
          price,
          weather: weather ? { tempC: weather.tempC, icon: weather.icon } : undefined,
        },
      };
      aiText = aiText || "Here’s a tailored draft ✨";
    }

    // If still nothing, keep it moving
    if (!signal && !aiText) aiText = "Tell me where you’d like to fly 🌍";

    return res.json({ aiText, signal });
  } catch (err) {
    console.error("chat_failed:", err);
    return res.status(500).json({ error: "chat_failed", message: err?.message || "Unknown error" });
  }
});

export default router;
