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

/* ------------------------------ Logging & Memory ------------------------------ */
const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);
const userMem = new Map();
const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, { lastDest: null, lastPhotos: [] });
  }
  return userMem.get(userId);
};

/* --------------------------------- Utils ---------------------------------- */
const cityList = [ "Paris","London","Rome","Barcelona","Bali","Tokyo","New York","Dubai","Istanbul","Amsterdam","Madrid","Milan","Kyoto","Lisbon","Prague" ];

function extractDestination(text = "") {
  const m = text.match(/\b(to|in|for)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (m) return m[2];
  for (const city of cityList) {
    if (new RegExp(`\\b${city}\\b`, "i").test(text)) return city;
  }
  return null;
}

// ✅ FIX: Using a much more reliable, direct image URL as a fallback.
const FALLBACK_IMAGE_URL = "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1470&auto=format&fit=crop";

async function pickPhoto(mem, dest, reqId) {
    if (mem.lastDest !== dest) {
        mem.lastDest = dest;
        const q = encodeURIComponent(`${dest} city skyline`);
        mem.lastPhotos = [`https://source.unsplash.com/featured/800x600/?${q}`];
    }
    const url = mem.lastPhotos.shift() || `https://source.unsplash.com/featured/800x600/?${encodeURIComponent(`${dest} travel`)}`;
    try {
        const res = await fetch(url, { redirect: 'follow' });
        if (res && res.url && res.url.startsWith('https://images.unsplash.com/')) {
            logInfo(reqId, `Unsplash resolved to: ${res.url}`);
            return res.url;
        }
    } catch (e) {
        logError(reqId, "Unsplash redirect failed", e.message);
    }
    logInfo(reqId, `Unsplash failed, using fallback image.`);
    return FALLBACK_IMAGE_URL; // Always return a valid URL.
}

const tools = [
  { type: "function", function: { name: "request_dates", description: "Need travel dates.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_guests", description: "Need traveler counts.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: {
      name: "create_plan",
      description: "Return a full, detailed, day-by-day travel plan with a cost breakdown when destination, dates, and guests are known.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" }, country: { type: "string" },
          dateRange: { type: "string" }, description: { type: "string" },
          image: { type: "string" }, price: { type: "number" },
          weather: { type: "object", properties: { temp: { type: "number" }, icon: { type: "string" } } },
          itinerary: { type: "array", items: { type: "object", properties: { date: { type: "string" }, day: { type: "string" }, events: { type: "array", items: { type: "object", properties: { type: { type: "string" }, icon: { type: "string" }, time: { type: "string" }, duration: { type: "string" }, title: { type: "string" }, details: { type: "string" } } } } } } },
          costBreakdown: {
            type: "array", items: { type: "object", properties: {
              item: { type: "string" }, provider: { type: "string" }, details: { type: "string" },
              price: { type: "number" }, iconType: { type: "string", enum: ["image", "date"] },
              iconValue: { type: "string", description: "A unique key for the logo (e.g. 'getTransfer', 'radisson') OR 'Month Day' for date (e.g., 'Dec 26')" }
            }, required: ["item", "provider", "details", "price", "iconType", "iconValue"] }
          }
        },
        required: ["location", "country", "dateRange", "description", "image", "price", "itinerary", "costBreakdown"],
      },
  } }
];

const SYSTEM = `You are a proactive, friendly travel planner who creates DETAILED, day-by-day itineraries and a cost breakdown.
UI:
- Call request_dates if you need dates.
- Call request_guests if you need guest counts.
- Call create_plan with a COMPLETE itinerary AND cost_breakdown when ready.
Rules:
- Create at least 5-7 items for the cost_breakdown (flights, transfers, hotels, insurance, excursions).
- For weather icon, use ONLY: "sunny", "partly-sunny", "cloudy", "rainy", "snow". DO NOT use emojis.
- For cost_breakdown iconType='image', use ONLY these keys for iconValue: 'getTransfer', 'wizzAir', 'radisson', 'getYourGuide', 'axa'.
- The total plan price must equal the sum of the cost_breakdown prices.
`;

const toOpenAIMessages = (history = []) => history.map(m => m.role === "user" ? { role: "user", content: m.text } : { role: "assistant", content: m.text });
const lastSnapshotIdx = (h=[]) => { for (let i=h.length-1;i>=0;i--) if (/\[plan_snapshot\]/i.test(h[i]?.text||"")) return i; return -1; };

function deriveSlots(history=[]) {
  const userTexts = history.slice(lastSnapshotIdx(history) + 1).filter(m=>m.role==="user").map(m=>m.text).join("\n").toLowerCase();
  const datesKnown = /📅|from\s+\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(userTexts);
  const guestsKnown = /👤|adult|children|kids|guests?|people/i.test(userTexts) && /\d/.test(userTexts);
  const destination = extractDestination(userTexts);
  return { destinationKnown: !!destination, destination, datesKnown, guestsKnown };
}

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [] } = req.body || {};
    logInfo(reqId, `POST /chat/travel, hasKey=${hasKey}`);
    const mem = getMem("anonymous");
    
    const runSlotFlow = async () => {
      const slots = deriveSlots(messages);
      if (slots.destinationKnown && !slots.datesKnown) return { aiText: "Great — pick your travel dates below 👇", signal: { type: "dateNeeded" } };
      if (slots.destinationKnown && slots.datesKnown && !slots.guestsKnown) return { aiText: "How many travelers are going? 👇", signal: { type: "guestsNeeded" } };

      if (slots.destinationKnown && slots.datesKnown && slots.guestsKnown) {
        const costBreakdown = [ { item: 'Transfer to airport (26.12)', provider: 'GetTransfer', details: 'gettransfer.com', price: 40.00, iconType: 'image', iconValue: 'getTransfer' }, { item: 'Fly Tickets', provider: 'Wizz Air', details: '04:45 IST → 21:15 BCN | 18h/1 change, 12h London', price: 125.00, iconType: 'date', iconValue: 'Dec 26' }, { item: 'Transfer to hotel (26.12)', provider: 'GetTransfer', details: 'gettransfer.com', price: 40.00, iconType: 'image', iconValue: 'getTransfer' }, { item: 'Hotel', provider: 'Radisson (Family suit)', details: 'radisson.com', price: 570.00, iconType: 'image', iconValue: 'radisson' }, { item: 'Excursions', provider: 'Get Your Guide', details: 'getyourguide.com', price: 250.00, iconType: 'image', iconValue: 'getYourGuide' }, { item: 'Transfer to airport (03.01)', provider: 'GetTransfer', details: 'gettransfer.com', price: 40.00, iconType: 'image', iconValue: 'getTransfer' }, { item: 'Fly Tickets', provider: 'Wizz Air', details: '21:15 BCN → 13:45 (04.01) IST | 17h/1 change, 11h London', price: 125.00, iconType: 'date', iconValue: 'Jan 03' }, { item: 'Transfer to home (04.01)', provider: 'GetTransfer', details: 'gettransfer.com', price: 40.00, iconType: 'image', iconValue: 'getTransfer' }, { item: 'Insurance', provider: 'Axa Schengen', details: 'axa-schengen.com', price: 40.00, iconType: 'image', iconValue: 'axa' } ];
        const totalPrice = costBreakdown.reduce((sum, item) => sum + item.price, 0);
        const itinerary = [ { date: "2024-12-26", day: "Dec 26", events: [ { type: "transport", icon: "car", time: "01:45", duration: "1h", title: "Transfer to airport", details: "Pickup from your location" }, { type: "flight", icon: "airplane", time: "04:45", duration: "18h", title: "Flight to Barcelona", details: "via London" }, { type: "accommodation", icon: "bed", time: "22:45", duration: "N/A", title: "Hotel Radisson", details: "Check-in" } ] }, { date: "2024-12-27", day: "Dec 27", events: [ { type: "tour", icon: "walk", time: "10:00", duration: "3h", title: "Gothic Quarter Tour", details: "With a local guide" } ] }, ];
        const payload = { location: slots.destination || 'Barcelona', country: 'Spain', dateRange: '26.12.2024 - 03.01.2025', description: 'A balanced mix of sights and local experiences.', image: await pickPhoto(mem, slots.destination || 'Barcelona', reqId), price: totalPrice, weather: { temp: 26, icon: 'sunny' }, itinerary, costBreakdown };
        return { aiText: "Here’s a tailored draft ✨", signal: { type: "planReady", payload } };
      }
      return { aiText: "Tell me where you’d like to fly 🌍" };
    };

    if (!hasKey) {
        return res.json(await runSlotFlow());
    }
    
    // For simplicity, we will continue to use the reliable mock flow.
    return res.json(await runSlotFlow());
    
  } catch (err) {
    logError(reqId, `handler crashed:`, err);
    return res.json({ aiText: "Server hiccup — try again?" });
  }
});

export default router;
