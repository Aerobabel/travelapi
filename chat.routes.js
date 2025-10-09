// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

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

const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);
const userMem = new Map();

// ✅ 1. Initialize the full user profile structure
const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        preferred_travel_type: [],
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

// ✅ 2. New function to learn and update user preferences from conversation
function updateProfileFromHistory(messages, mem) {
    const userTexts = messages.filter(m => m.role === "user").map(m => m.text).join(" ").toLowerCase();
    const { profile } = mem;

    const mappings = {
        preferred_travel_type: { beach: /beach/, active: /active|hiking|adventure/, urban: /city|urban/, relaxing: /relax|spa|leisure/ },
        travel_alone_or_with: { solo: /solo|by myself/, family: /family|with my kids/, friends: /friends|group/ },
        'flight_preferences.class': { premium_economy: /premium economy/, business: /business class/, first: /first class/ },
        'budget.prefer_comfort_or_saving': { comfort: /comfort|luxury/, saving: /saving|cheap|budget/ },
        liked_activities: { hiking: /hiking/, 'wine tasting': /wine/, museums: /museum/, shopping: /shopping/ }
    };

    for (const key in mappings) {
        for (const value in mappings[key]) {
            if (mappings[key][value].test(userTexts)) {
                if (Array.isArray(profile[key])) {
                    if (!profile[key].includes(value)) profile[key].push(value);
                } else if (key.includes('.')) {
                    const [p, c] = key.split('.');
                    profile[p][c] = value;
                } else {
                    profile[key] = value;
                }
            }
        }
    }
}


const cityList = [ "Paris", "London", "Rome", "Barcelona", "Bali", "Tokyo", "New York", "Dubai", "Istanbul", "Amsterdam", "Madrid", "Milan", "Kyoto", "Lisbon", "Prague" ];
function extractDestination(text = "") {
  const m = text.match(/\b(to|in|for)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (m) return m[2];
  for (const city of cityList) { if (new RegExp(`\\b${city}\\b`, "i").test(text)) return city; }
  return null;
}

const FALLBACK_IMAGE_URL = "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1470&auto=format&fit=crop";
async function pickPhoto(mem, dest, reqId) {
    const q = encodeURIComponent(`${dest} city skyline`);
    const url = `https://source.unsplash.com/featured/800x600/?${q}`;
    try {
        const res = await fetch(url, { redirect: 'follow' });
        if (res && res.url && res.url.startsWith('https://images.unsplash.com/')) {
            return res.url;
        }
    } catch (e) { logError(reqId, "Unsplash redirect failed", e.message); }
    return FALLBACK_IMAGE_URL;
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
          itinerary: { type: "array", items: { type: "object", properties: { date: { type: "string" }, day: { type: "string" }, events: { type: "array", items: { type: "object", properties: { type: { type: "string" }, icon: { type: "string" }, time: { type: "string" }, duration: { type: "string" }, title: { type: "string" }, details: { type: "string" } }, required: ["type", "icon", "time", "duration", "title", "details"] } } }, required: ["date", "day", "events"] } },
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

const getSystemPrompt = (profile) => `You are a proactive, friendly travel planner.
- Use the user profile provided below to tailor the travel plan.
- If the profile is empty, ask clarifying questions to learn preferences before creating a plan.
- After a plan is created (signaled by a [PLAN_SNAPSHOT] message), treat the next user message as a brand new travel request. Forget the previous destination.
- For weather icon, use ONLY: "sunny", "partly-sunny", "cloudy".
- For cost_breakdown iconType='image', use ONLY these keys: 'getTransfer', 'wizzAir', 'radisson', 'getYourGuide', 'axa'.
- The total plan price must equal the sum of the cost_breakdown prices.

USER PROFILE:
${JSON.stringify(profile, null, 2)}
`;

const toOpenAIMessages = (history = []) => history.map(m => m.role === "user" ? { role: "user", content: m.text } : { role: "assistant", content: m.text });
const lastSnapshotIdx = (h=[]) => { for (let i=h.length-1;i>=0;i--) if (/\[plan_snapshot\]/i.test(h[i]?.text||"")) return i; return -1; };

function deriveSlots(history=[]) {
  const relevantHistory = history.slice(lastSnapshotIdx(history) + 1);
  const userTexts = relevantHistory.filter(m=>m.role==="user").map(m=>m.text).join("\n").toLowerCase();
  const datesKnown = /📅|from\s+\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(userTexts);
  const guestsKnown = /👤|adult|children|kids|guests?|people/i.test(userTexts) && /\d/.test(userTexts);
  const destination = extractDestination(userTexts);
  return { destinationKnown: !!destination, destination, datesKnown, guestsKnown };
}

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel, user=${userId}, hasKey=${hasKey}`);
    const mem = getMem(userId);

    updateProfileFromHistory(messages, mem);
    
    const runSlotFlow = async () => {
      const slots = deriveSlots(messages);
      logInfo(reqId, "Slots derived:", slots);

      if (!slots.destinationKnown) {
        return { aiText: "I'm ready for a new adventure! Where would you like to fly to? 🌍" };
      }
      if (!slots.datesKnown) return { aiText: `Great, ${slots.destination}! Pick your travel dates below 👇`, signal: { type: "dateNeeded" } };
      if (!slots.guestsKnown) return { aiText: "How many travelers are going? 👇`, signal: { type: "guestsNeeded" } };
      
      const costBreakdown = [ { item: 'Transfer to airport (26.12)', provider: 'GetTransfer', details: 'gettransfer.com', price: 40.00, iconType: 'image', iconValue: 'getTransfer' }, { item: 'Fly Tickets', provider: 'Wizz Air', details: 'Details based on your preferences', price: 125.00, iconType: 'date', iconValue: 'Dec 26' }, { item: 'Hotel', provider: 'Radisson (Family suit)', details: `Style chosen based on your preference for '${mem.profile.budget.prefer_comfort_or_saving}'`, price: 570.00, iconType: 'image', iconValue: 'radisson' }, { item: 'Excursions', provider: 'Get Your Guide', details: 'Activities based on your interests', price: 250.00, iconType: 'image', iconValue: 'getYourGuide' }, { item: 'Insurance', provider: 'Axa Schengen', details: 'axa-schengen.com', price: 40.00, iconType: 'image', iconValue: 'axa' } ];
      const totalPrice = costBreakdown.reduce((sum, item) => sum + item.price, 0);
      const itinerary = [ { date: "2024-12-26", day: "Dec 26", events: [ { type: "transport", icon: "car", time: "01:45", duration: "1h", title: "Transfer to airport", details: "Pickup from your location" }, { type: "flight", icon: "airplane", time: "04:45", duration: "18h", title: `Flight to ${slots.destination}`, details: "via London" }, { type: "accommodation", icon: "bed", time: "22:45", duration: "N/A", title: "Hotel Radisson", details: "Check-in" } ] }, { date: "2024-12-27", day: "Dec 27", events: [ { type: "tour", icon: "walk", time: "10:00", duration: "3h", title: "City Tour", details: "Exploring local culture" } ] } ];
      const payload = { location: slots.destination, country: 'Spain', dateRange: '26.12.2024 - 03.01.2025', description: 'A tailored plan based on your preferences.', image: await pickPhoto(mem, slots.destination, reqId), price: totalPrice, weather: { temp: 26, icon: 'sunny' }, itinerary, costBreakdown };
      return { aiText: "Here’s a tailored draft ✨", signal: { type: "planReady", payload } };
    };

    if (!hasKey) {
        logInfo(reqId, "No API key, using slot flow.");
        return res.json(await runSlotFlow());
    }
    
    // The system prompt is now dynamic based on the user's profile
    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...toOpenAIMessages(messages)];

    try {
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: convo,
            tools,
            tool_choice: "auto",
            temperature: 0.5,
        });

        const toolCall = completion?.choices?.[0]?.message?.tool_calls?.[0];
        if (toolCall) {
            const functionName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            if (functionName === "create_plan") {
                return res.json({ aiText: "Here's your personalized plan!", signal: { type: 'planReady', payload: args } });
            }
            if (functionName === "request_dates") {
                return res.json({ aiText: "When would you like to travel?", signal: { type: 'dateNeeded' } });
            }
            if (functionName === "request_guests") {
                return res.json({ aiText: "How many people are traveling?", signal: { type: 'guestsNeeded' } });
            }
        }
    } catch (e) {
        logError(reqId, 'OpenAI call failed, falling back to slot flow.', e);
        return res.json(await runSlotFlow());
    }

    // Fallback if OpenAI doesn't call a tool
    return res.json(await runSlotFlow());
    
  } catch (err) {
    logError(reqId, `Handler crashed:`, err);
    return res.json({ aiText: "A server hiccup occurred. Please try again." });
  }
});

export default router;
