// server/chat.routes.js
// Mount with: app.use("/chat", chatRouter)  → POST /chat/travel

import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

// --- Load env
dotenv.config();

// --- Ensure fetch exists (Node < 18)
let FETCH_SOURCE = "native";
try {
  if (typeof globalThis.fetch !== "function") {
    const nodeFetch = (await import("node-fetch")).default;
    globalThis.fetch = nodeFetch;
    FETCH_SOURCE = "node-fetch";
  }
} catch (e) {
  console.error("[chat] fetch polyfill load failed:", e?.message);
}

const router = Router();

const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const NODE_VER = process.versions?.node || "unknown";

/* ------------------------------ Logging helpers ------------------------------ */
const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();

const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logWarn = (reqId, ...args) => console.warn(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

/* --------------------------------- Memory --------------------------------- */
const userMem = new Map();
const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        preferred_travel_type: null,
        travel_alone_or_with: null,
        desired_experience: [],
        flight_preferences: { class: "economy" },
        flight_priority: [],
        accommodation: { preferred_type: null, prefer_view: "doesn't matter" },
        budget: { prefer_comfort_or_saving: "balanced" },
        preferred_formats: [],
        liked_activities: [],
      },
      lastDest: null,
      lastPhotos: [],
    });
  }
  return userMem.get(userId);
};

/* --------------------------------- Utils ---------------------------------- */
const cityList = [
  "Paris","London","Rome","Barcelona","Bali","Tokyo","New York","Dubai",
  "Istanbul","Amsterdam","Madrid","Milan","Kyoto","Lisbon","Prague"
];

function extractDestination(text = "") {
  const m = text.match(/\b(to|in|for)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (m) return m[2];
  for (const city of cityList) if (new RegExp(`\\b${city}\\b`, "i").test(text)) return city;
  return null;
}

async function resolveUnsplashDirect(url, fallback, reqId) {
  const t0 = performance.now?.() ?? Date.now();
  try {
    const res = await fetch(url, { redirect: "follow" });
    const t1 = performance.now?.() ?? Date.now();
    logInfo(reqId, `unsplash resolve: ${url} → ${res?.url} (${Math.round(t1 - t0)}ms)`);
    if (res && res.url && /^https:\/\/images\.unsplash\.com\//.test(res.url)) return res.url;
  } catch (e) {
    logWarn(reqId, "unsplash resolve failed:", e?.message);
  }
  return fallback;
}
function buildPhotoList(place, count = 6) {
  const q = encodeURIComponent(`${place} skyline`);
  const list = [];
  for (let i = 0; i < count; i++) list.push(`https://source.unsplash.com/featured/800x600/?${q}&sig=${i+1}`);
  list.push(
    "https://source.unsplash.com/featured/800x600/?cityscape,travel&sig=99",
    "https://source.unsplash.com/featured/800x600/?landmark,travel&sig=100"
  );
  return list;
}
async function pickPhoto(mem, dest, fallback, reqId) {
  if (mem.lastDest !== dest) {
    mem.lastDest = dest;
    mem.lastPhotos = buildPhotoList(dest, 6);
  }
  let url = mem.lastPhotos.shift();
  if (!url) { mem.lastPhotos = buildPhotoList(dest, 6); url = mem.lastPhotos.shift() || fallback; }
  return await resolveUnsplashDirect(url, fallback, reqId);
}

async function geocodePlace(place, reqId) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`;
  const t0 = performance.now?.() ?? Date.now();
  const r = await fetch(url);
  const t1 = performance.now?.() ?? Date.now();
  logInfo(reqId, `geocode "${place}": HTTP ${r.status} (${Math.round(t1 - t0)}ms)`);
  if (!r.ok) throw new Error(`geocode ${r.status}`);
  const j = await r.json();
  const hit = j?.results?.[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude, country: hit.country } : null;
}
function parseDatesFromHistory(history) {
  const txt = history.filter(m => m.role === "user").map(m => m.text).join(" ");
  const m = txt.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  return m ? { start: m[1], end: m[2], pretty: `${m[1].replace(/-/g, '.')} - ${m[2].replace(/-/g, '.')}` } : null;
}
function daysBetween(a, b) {
  const A = new Date(a + "T00:00:00Z"); const B = new Date(b + "T00:00:00Z");
  return Math.max(1, Math.round((B - A) / 86400000) + 1);
}
async function getAverageWeather(place, startISO, endISO, reqId) {
  const geo = await geocodePlace(place, reqId);
  if (!geo) return null;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&daily=temperature_2m_max,temperature_2m_min&start_date=${startISO}&end_date=${endISO}&timezone=UTC`;
  const t0 = performance.now?.() ?? Date.now();
  const r = await fetch(url);
  const t1 = performance.now?.() ?? Date.now();
  logInfo(reqId, `weather "${place}": HTTP ${r.status} (${Math.round(t1 - t0)}ms)`);
  if (!r.ok) throw new Error(`weather ${r.status}`);
  const j = await r.json();
  const max = j?.daily?.temperature_2m_max || [];
  const min = j?.daily?.temperature_2m_min || [];
  if (!max.length || !min.length) return null;
  const avg = (max.reduce((s,x)=>s+x,0)+min.reduce((s,x)=>s+x,0))/(max.length+min.length);
  const icon = avg >= 25 ? "sunny" : avg >= 15 ? "partly-sunny" : "cloudy";
  return { temp: Math.round(avg), icon, country: geo.country };
}
function priceTrip({ place, days, pax, className, comfortBias }) {
  const baseMap = { Paris:240, London:260, Rome:200, Barcelona:190, Bali:110, Tokyo:230, "New York":300, Dubai:260, Istanbul:150, Amsterdam:210, Madrid:180, Milan:210, Lisbon:170, Kyoto:220, Prague:160 };
  const base = baseMap[place] || 180;
  const classMult = { economy:1, premium_economy:1.25, business:1.9, first:2.6 }[className || "economy"];
  const comfortMult = { saving:0.9, balanced:1.0, comfort:1.25 }[comfortBias || "balanced"];
  const paxMult = pax <= 1 ? 1 : 1 + (pax - 1) * 0.7;
  const extras = 120;
  return Math.round(((base * days * comfortMult * paxMult * 1.15 * classMult) + extras) / 10) * 10;
}

/* ------------------------------ LLM config ------------------------------ */
const tools = [
  { type: "function", function: { name: "request_dates", description: "Need travel dates.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_guests", description: "Need traveler counts.", parameters: { type: "object", properties: { minInfo: { type: "string" } } } } },
  { type: "function", function: {
      name: "create_plan",
      description: "Return a full, detailed, day-by-day travel plan when destination, dates, and guests are known.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string", description: "e.g., 26.12.2024 - 03.01.2025" },
          description: { type: "string", description: "A balanced mix of iconic sights..." },
          image: { type: "string", description: "A direct images.unsplash.com URL" },
          price: { type: "number" },
          weather: { type: "object", properties: { temp: { type: "number" }, icon: { type: "string" } } },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "Full date, e.g., 2024-12-26" },
                day: { type: "string", description: "Short day name, e.g., Dec 26" },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["transport", "flight", "accommodation", "activity", "meal", "tour"] },
                      icon: { type: "string", enum: ["car", "airplane", "bed", "camera", "restaurant", "walk"] },
                      time: { type: "string", description: "e.g., 08:45" },
                      duration: { type: "string", description: "e.g., 1 hour" },
                      title: { type: "string" },
                      details: { type: "string" }
                    },
                    required: ["type", "icon", "time", "duration", "title", "details"]
                  }
                }
              },
              required: ["date", "day", "events"]
            }
          }
        },
        required: ["location", "country", "dateRange", "description", "image", "price", "itinerary"],
      },
  } }
];

const SYSTEM = `
You are a proactive, friendly travel planner who creates DETAILED, day-by-day itineraries.
UI:
- If you need DATES, call request_dates (one short friendly line allowed).
- If you need GUESTS, call request_guests.
- When destination, dates, and guests are known, call create_plan with a COMPLETE itinerary.
Rules:
- After a destination appears, ask the PURPOSE (business, relax, sightseeing, etc.).
- The plan MUST cover every day of the trip.
- For each day, create at least 3-5 events (e.g., flight, hotel check-in, transfer, tour, meal, museum visit).
- Vary the activities. Include transport, accommodation, and leisure.
- Always give a concrete USD price (no "depends").
- For the weather icon, use one of these exact strings: "sunny", "partly-sunny", "cloudy", "rainy", "snow". DO NOT use emojis.
- Rotate images via Unsplash; return direct images.unsplash.com links when possible.
- Include average weather (°C) for the selected dates when available.
`;

const toOpenAIMessages = (history=[]) =>
  history.map(m => m.role === "user" ? { role: "user", content: m.text }
    : m.role === "system" ? { role: "system", content: m.text }
    : { role: "assistant", content: m.text });

const lastSnapshotIdx = (h=[]) => { for (let i=h.length-1;i>=0;i--) if (/\[plan_snapshot\]/i.test(h[i]?.text||"")) return i; return -1; };
function deriveSlots(history=[]) {
  const start = lastSnapshotIdx(history) + 1;
  const userTexts = history.slice(start).filter(m=>m.role==="user").map(m=>m.text).join("\n");
  const txt = userTexts.toLowerCase();
  const datesKnown = /📅/.test(txt) || /from\s+\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(userTexts);
  const guestsKnown = /👤/.test(txt) || (/(adult|adults|children|kids|\bguests?\b|\bpeople\b)/i.test(userTexts) && /\d/.test(userTexts));
  const destination = extractDestination(userTexts);
  const destinationKnown = !!destination;
  const purposeKnown = /(business|work|conference|relax|relaxing|beach|sightseeing|tour|honeymoon|family|friends|photography|food)/i.test(userTexts);
  return { destinationKnown, destination, datesKnown, guestsKnown, purposeKnown };
}

/* -------------------------------- Route -------------------------------- */
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  const tStart = performance.now?.() ?? Date.now();

  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel @ ${now()}`);
    logInfo(reqId, `node=${NODE_VER}, fetch=${FETCH_SOURCE}, hasKey=${hasKey}`);
    logInfo(reqId, `payload messages=${messages.length}, userId=${userId}`);

    const mem = getMem(userId);
    const joined = messages.filter(m=>m.role==="user").map(m=>m.text).join("\n").toLowerCase();

    // light preference learning
    if (/i (like|love).*(hiking|museums|shopping|wine|extreme)/.test(joined)) {
      const act = joined.match(/hiking|museums|shopping|wine tasting|extreme sports/);
      if (act && !mem.profile.liked_activities.includes(act[0])) {
        mem.profile.liked_activities.push(act[0]);
        logInfo(reqId, "learned activity:", act[0]);
      }
    }

    /* --------------------------- Slot flow helper --------------------------- */
    const runSlotFlow = async () => {
      const slots = deriveSlots(messages);
      logInfo(reqId, "slots:", slots);

      if (slots.destinationKnown && !slots.purposeKnown) {
        return { aiText: `Nice choice — ${slots.destination}! Is this more of a business trip, a relaxing getaway, or sightseeing/photography?`, signal: null };
      }
      if (slots.destinationKnown && !slots.datesKnown) {
        return { aiText: "Great — pick your travel dates below 👇", signal: { type: "dateNeeded" } };
      }
      if (slots.destinationKnown && slots.datesKnown && !slots.guestsKnown) {
        return { aiText: "How many travelers are going? 👇", signal: { type: "guestsNeeded", payload: { minInfo: "adults and children" } } };
      }

      if (slots.destinationKnown && slots.datesKnown && slots.guestsKnown) {
        const dest = "Barcelona";
        const dates = { start: "2024-12-26", end: "2025-01-03", pretty: "26.12.2024 - 03.01.2025" };

        const fallbackImg = "https://images.unsplash.com/photo-1543342384-1bbd4b285d05?q=80&w=1600&auto-format&fit=crop";
        const image = await pickPhoto(mem, dest, fallbackImg, reqId);
        
        const weather = { temp: 26, icon: 'sunny', country: 'Spain' };

        const paxMatch = joined.match(/(\d+)\s*(adult|adults|people|guests)/);
        const kidsMatch = joined.match(/(\d+)\s*(child|children|kids)/);
        const adults = paxMatch ? parseInt(paxMatch[1],10) : 1;
        const children = kidsMatch ? parseInt(kidsMatch[1],10) : 0;
        const pax = adults + children;

        const numDays = daysBetween(dates.start, dates.end);
        const price = priceTrip({ place: dest, days: numDays, pax, className: "economy", comfortBias: "balanced" });

        const description = `A balanced mix of iconic sights, beaches, and authentic local experiences.`;

        // --- MOCK ITINERARY ---
        const itinerary = [
          {
            date: "2024-12-26",
            day: "Dec 26",
            events: [
              { type: "transport", icon: "car", time: "01:45", duration: "1 hour", title: "Transfer to airport", details: "Full information will be after purchase" },
              { type: "flight", icon: "airplane", time: "04:45", duration: "3 hour", title: "Flight WZ389", details: "You will go to London, 12 hours waiting" },
              { type: "flight", icon: "airplane", time: "18:15", duration: "3 hour", title: "Flight WZ345", details: "You will go to Barcelona" },
              { type: "transport", icon: "car", time: "21:45", duration: "1 hour", title: "Transfer to hotel", details: "Full information will be after purchase" },
              { type: "accommodation", icon: "bed", time: "22:45", duration: "1 hour", title: "Hotel: Blue Radisson Barcelona", details: "Full information will be after purchase" },
            ]
          },
          {
            date: "2024-12-27",
            day: "Dec 27",
            events: [
              { type: "meal", icon: "restaurant", time: "09:00", duration: "1.5 hours", title: "Breakfast at Brunch & Cake", details: "Famous local spot for creative dishes." },
              { type: "tour", icon: "walk", time: "11:00", duration: "3 hours", title: "Gothic Quarter Walking Tour", details: "Explore the historic heart of the city." },
              { type: "activity", icon: "camera", time: "15:00", duration: "2 hours", title: "Visit La Sagrada Familia", details: "Entry tickets pre-booked." },
            ]
          },
          {
            date: "2024-12-28",
            day: "Dec 28",
            events: [
              { type: "activity", icon: "camera", time: "10:00", duration: "4 hours", title: "Explore Park Güell", details: "Enjoy Gaudí's whimsical park." },
              { type: "meal", icon: "restaurant", time: "14:00", duration: "2 hours", title: "Lunch at El Nacional", details: "A beautiful food hall with multiple options." },
              { type: "activity", icon: "walk", time: "17:00", duration: "3 hours", title: "Stroll down La Rambla", details: "Experience the vibrant street life." },
            ]
          }
        ];

        const payload = { location: dest, country: weather.country, dateRange: dates.pretty, description, image, price, weather, itinerary };
        logInfo(reqId, "plan payload prepared (mock)");
        return { aiText: "Here’s a tailored draft ✨", signal: { type: "planReady", payload } };
      }

      return { aiText: "Tell me where you’d like to fly 🌍", signal: null };
    };

    /* ----------------------------- No key path ------------------------------ */
    if (!hasKey) {
      logWarn(reqId, "OPENAI_API_KEY missing — using slot flow");
      const out = await runSlotFlow();
      const tEnd = performance.now?.() ?? Date.now();
      logInfo(reqId, `responded (mock) in ${Math.round(tEnd - tStart)}ms`);
      return res.json(out);
    }

    /* ----------------------------- OpenAI path ------------------------------ */
    let aiText = "";
    let signal = null;

    const convo = [{ role: "system", content: SYSTEM }, ...toOpenAIMessages(messages)];
    logInfo(reqId, "openai.chat.completions.create start");
    const tAI0 = performance.now?.() ?? Date.now();
    let completion = null;

    try {
      completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: convo,
        tools,
        tool_choice: "auto",
        temperature: 0.3,
      });
    } catch (e) {
      const tAI1 = performance.now?.() ?? Date.now();
      logError(reqId, `openai failed after ${Math.round(tAI1 - tAI0)}ms:`, e?.status || "", e?.message || e);
      const out = await runSlotFlow();
      const tEnd = performance.now?.() ?? Date.now();
      logInfo(reqId, `responded (fallback) in ${Math.round(tEnd - tStart)}ms`);
      return res.json(out);
    }

    const tAI1 = performance.now?.() ?? Date.now();
    logInfo(reqId, `openai completed in ${Math.round(tAI1 - tAI0)}ms`);

    aiText = completion?.choices?.[0]?.message?.content || "";
    const toolCall = completion?.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall) {
      const name = toolCall.function?.name;
      let args = {};
      try { args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {}; } catch {}
      logInfo(reqId, "tool call:", name, "args:", args ? Object.keys(args) : "none");

      if (name === "request_dates") {
        signal = { type: "dateNeeded" };
        if (!aiText) aiText = "Great — pick your travel dates below 👇";
      } else if (name === "request_guests") {
        signal = { type: "guestsNeeded", payload: args };
        if (!aiText) aiText = "Awesome — how many are traveling? 👇";
      } else if (name === "create_plan") {
        if (args?.image && /source\.unsplash\.com/.test(args.image)) {
          const fallbackImg = "https://images.unsplash.com/photo-1543342384-1bbd4b285d05?q=80&w=1600&auto-format&fit=crop";
          args.image = await resolveUnsplashDirect(args.image, fallbackImg, reqId);
        }

        // ✅ START OF THE FIX: Sanitize the weather icon from the AI
        if (args.weather && args.weather.icon) {
          const icon = args.weather.icon.toLowerCase();
          if (icon.includes('☀️') || icon.includes('sunny')) {
            args.weather.icon = 'sunny';
          } else if (icon.includes('⛅️') || icon.includes('partly-sunny')) {
            args.weather.icon = 'partly-sunny';
          } else if (icon.includes('☁️') || icon.includes('cloud')) {
            args.weather.icon = 'cloudy';
          } else if (icon.includes('🌧️') || icon.includes('rain')) {
            args.weather.icon = 'rainy';
          } else if (icon.includes('❄️') || icon.includes('snow')) {
            args.weather.icon = 'snow';
          } else {
            // If it's something unexpected, default to "sunny"
            args.weather.icon = 'sunny';
          }
        }
        // ✅ END OF THE FIX

        signal = { type: "planReady", payload: args };
        if (!aiText) aiText = "Here’s your plan ✨";
      }
    }

    if (!signal) {
      logInfo(reqId, "no tool used — running slot flow for guidance");
      const out = await runSlotFlow();
      aiText = aiText || out.aiText;
      signal = out.signal;
    }

    if (!signal && !aiText) aiText = "Tell me where you’d like to fly 🌍";

    const tEnd = performance.now?.() ?? Date.now();
    logInfo(reqId, `responded 200 in ${Math.round(tEnd - tStart)}ms`);
    return res.json({ aiText, signal });

  } catch (err) {
    const tEnd = performance.now?.() ?? Date.now();
    logError(reqId, `handler crashed after ${Math.round(tEnd - tStart)}ms:`, err?.stack || err?.message || err);
    return res.json({ aiText: "Server hiccup — try again in a sec?", signal: null });
  }
});

export default router;
