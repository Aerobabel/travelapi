// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const router = Router();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- memory ----
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

// ---- utils ----
const cityList = ["Paris","London","Rome","Barcelona","Bali","Tokyo","New York","Dubai","Istanbul","Amsterdam","Madrid","Milan","Kyoto","Lisbon","Prague"];

function extractDestination(text = "") {
  const m = text.match(/\b(to|in|for)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (m) return m[2];
  for (const city of cityList) if (new RegExp(`\\b${city}\\b`, "i").test(text)) return city;
  return null;
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
function pickPhoto(mem, dest, fallback) {
  if (mem.lastDest !== dest) {
    mem.lastDest = dest;
    mem.lastPhotos = buildPhotoList(dest, 6);
  }
  const url = mem.lastPhotos.shift();
  if (!url) {
    mem.lastPhotos = buildPhotoList(dest, 6);
    return mem.lastPhotos.shift() || fallback;
  }
  return url || fallback;
}

async function geocodePlace(place) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`geocode failed ${r.status}`);
  const j = await r.json();
  const hit = j?.results?.[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name, country: hit.country } : null;
}
function parseDatesFromHistory(history) {
  const txt = history.filter(m => m.role === "user").map(m => m.text).join(" ");
  const m = txt.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  return m ? { start: m[1], end: m[2], pretty: `${m[1]} – ${m[2]}` } : null;
}
function daysBetween(a, b) {
  const A = new Date(a + "T00:00:00Z"); const B = new Date(b + "T00:00:00Z");
  return Math.max(1, Math.round((B - A) / (1000 * 60 * 60 * 24)));
}
async function getAverageWeather(place, startISO, endISO) {
  const geo = await geocodePlace(place);
  if (!geo) return null;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&daily=temperature_2m_max,temperature_2m_min&start_date=${startISO}&end_date=${endISO}&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`weather failed ${r.status}`);
  const j = await r.json();
  const max = j?.daily?.temperature_2m_max || [];
  const min = j?.daily?.temperature_2m_min || [];
  if (!max.length || !min.length) return null;
  const avg = (max.reduce((s, x) => s + x, 0) + min.reduce((s, x) => s + x, 0)) / (max.length + min.length);
  const icon = avg >= 25 ? "sunny-outline" : avg >= 15 ? "partly-sunny-outline" : "cloud-outline";
  return { tempC: Math.round(avg), icon };
}

function priceTrip({ place, days, pax, className, comfortBias }) {
  const baseMap = { Paris:240, London:260, Rome:200, Barcelona:190, Bali:110, Tokyo:230, "New York":300, Dubai:260, Istanbul:150, Amsterdam:210, Madrid:180, Milan:210, Lisbon:170, Kyoto:220, Prague:160 };
  const base = baseMap[place] || 180;
  const classMult = { economy:1.0, premium_economy:1.25, business:1.9, first:2.6 }[className || "economy"];
  const comfortMult = { saving:0.9, balanced:1.0, comfort:1.25 }[comfortBias || "balanced"];
  const paxMult = pax <= 1 ? 1 : 1 + (pax - 1) * 0.7;
  const extras = 120;
  const total = base * days * comfortMult * paxMult * 1.15 * classMult + extras;
  return Math.round(total / 10) * 10;
}

// ---- tools ----
const tools = [
  { type: "function", function: { name: "request_dates", description: "Need travel dates.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_guests", description: "Need traveler counts.", parameters: { type: "object", properties: { minInfo: { type: "string" } } } } },
  { type: "function", function: {
      name: "create_plan",
      description: "Return a plan card when destination+dates+guests are known.",
      parameters: { type: "object", properties: {
        location: { type: "string" }, dates: { type: "string" },
        description: { type: "string" }, image: { type: "string" }, price: { type: "string" },
        weather: { type: "object", properties: { tempC: { type: "number" }, icon: { type: "string" } } },
      }, required: ["location","dates","description","image","price"] }
  } },
];

const SYSTEM = `
You are a proactive, friendly travel planner.
UI:
- If you need DATES, call request_dates (one short friendly line allowed).
- If you need GUESTS, call request_guests.
- When ready, call create_plan.
Rules:
- After a destination appears, ask the PURPOSE (business, relax, sightseeing, etc.).
- Always give a concrete USD price (no "depends").
- Rotate images via source.unsplash.com with varying sig values.
- Include average weather (°C) for the selected dates when available.
- Learn preferences over time and use them.
`;

// ---- helpers ----
function toOpenAIMessages(history = []) {
  return history.map(m =>
    m.role === "user" ? { role: "user", content: m.text }
    : m.role === "system" ? { role: "system", content: m.text }
    : { role: "assistant", content: m.text }
  );
}
function lastSnapshotIdx(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.text && /\[plan_snapshot\]/i.test(history[i].text)) return i;
  }
  return -1;
}
function deriveSlots(history = []) {
  const start = lastSnapshotIdx(history) + 1;
  const userTexts = history.slice(start).filter(m => m.role === "user").map(m => m.text).join("\n");
  const txt = userTexts.toLowerCase();
  const datesKnown = /📅/.test(txt) || /from\s+\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(userTexts);
  const guestsKnown = /👤/.test(txt) || (/(adult|adults|children|kids|\bguests?\b|\bpeople\b)/i.test(userTexts) && /\d/.test(userTexts));
  const destination = extractDestination(userTexts);
  const destinationKnown = !!destination;
  const purposeKnown = /(business|work|conference|relax|relaxing|beach|sightseeing|tour|honeymoon|family|friends|photography|food)/i.test(userTexts);
  return { destinationKnown, destination, datesKnown, guestsKnown, purposeKnown };
}

// ---- route ----
router.post("/travel", async (req, res) => {
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing_key", message: "OPENAI_API_KEY missing" });
    }

    const mem = getMem(userId);
    const joined = messages.filter(m => m.role === "user").map(m => m.text).join("\n").toLowerCase();

    // learn tiny bits
    if (/i (like|love).*(hiking|museums|shopping|wine|extreme)/.test(joined)) {
      const act = joined.match(/hiking|museums|shopping|wine tasting|extreme sports/);
      if (act && !mem.profile.liked_activities.includes(act[0])) mem.profile.liked_activities.push(act[0]);
    }

    const convo = [{ role: "system", content: SYSTEM }, ...toOpenAIMessages(messages)];
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: convo,
      tools,
      tool_choice: "auto",
      temperature: 0.3,
    });

    let aiText = completion.choices?.[0]?.message?.content || "";
    let signal = null;
    const toolCall = completion.choices?.[0]?.message?.tool_calls?.[0];

    if (toolCall) {
      const name = toolCall.function?.name;
      let args = {};
      try { args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {}; } catch {}
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

    const slots = deriveSlots(messages);
    if (!signal && slots.destinationKnown && !slots.purposeKnown) {
      aiText = aiText || `Nice choice — ${slots.destination}! Is this business, relaxing, or sightseeing/photography?`;
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

    if (!signal && slots.destinationKnown && slots.datesKnown && slots.guestsKnown) {
      const dest = slots.destination;
      const dates = parseDatesFromHistory(messages);
      const startISO = dates?.start, endISO = dates?.end;
      const prettyDates = dates?.pretty || "Your dates";

      const fallbackImg = "https://images.unsplash.com/photo-1543342384-1bbd4b285d05?q=80&w=1600&auto=format&fit=crop";
      const image = pickPhoto(mem, dest, fallbackImg);

      let weather = null;
      try {
        if (startISO && endISO) weather = await getAverageWeather(dest, startISO, endISO);
      } catch (e) {
        console.warn("weather_error", e?.message);
      }

      const all = joined;
      const paxMatch = all.match(/(\d+)\s*(adult|adults|people|guests)/);
      const kidsMatch = all.match(/(\d+)\s*(child|children|kids)/);
      const adults = paxMatch ? parseInt(paxMatch[1], 10) : 1;
      const children = kidsMatch ? parseInt(kidsMatch[1], 10) : 0;
      const pax = adults + children;

      const className = mem.profile.flight_preferences?.class || "economy";
      const comfortBias = mem.profile.budget?.prefer_comfort_or_saving || "balanced";
      const days = startISO && endISO ? daysBetween(startISO, endISO) : 4;
      const amount = priceTrip({ place: dest, days, pax, className, comfortBias });
      const price = `$${amount.toLocaleString("en-US")}`;

      const description = `A ${days}-day walking-friendly plan across ${dest} with local highlights. We’ll tune hotels to your comfort level and include ${mem.profile.liked_activities?.slice(0,2).join(", ") || "top sights"}.`;

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

    if (!signal && !aiText) aiText = "Tell me where you’d like to fly 🌍";
    return res.json({ aiText, signal });
  } catch (err) {
    console.error("chat_failed:", err);
    return res.status(500).json({ error: "chat_failed", message: err?.message || "Unknown error" });
  }
});

export default router;
