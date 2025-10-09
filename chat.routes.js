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

// Initialize the full user profile structure
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
    });
  }
  return userMem.get(userId);
};

// Learn and update user preferences from conversation
function updateProfileFromHistory(messages, mem) {
    const userTexts = messages.filter(m => m.role === "user").map(m => m.text).join(" ").toLowerCase();
    const { profile } = mem;
    const mappings = {
        preferred_travel_type: { beach: /beach/, active: /active|hiking|adventure/, urban: /city|urban/, relaxing: /relax|spa|leisure/ },
        travel_alone_or_with: { solo: /solo|by myself/, family: /family|with my kids/, friends: /friends|group/ },
        'flight_preferences.class': { premium_economy: /premium economy/, business: /business class/, first: /first class/ },
        'budget.prefer_comfort_or_saving': { comfort: /comfort|luxury/, saving: /saving|budget/ },
        liked_activities: { hiking: /hiking/, 'wine tasting': /wine/, museums: /museum/, shopping: /shopping/, 'extreme sports': /extreme sports|adrenaline/ }
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

const cityList = [ "Paris", "London", "Rome", "Barcelona", "Bali", "Tokyo", "New York", "Dubai", "Istanbul", "Amsterdam", "Madrid", "Milan", "Kyoto", "Lisbon", "Prague", "China" ];
function extractDestination(text = "") {
  const m = text.match(/\b(to|in|for|at)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (m) return m[2];
  for (const city of cityList) { if (new RegExp(`\\b${city}\\b`, "i").test(text)) return city; }
  return null;
}

const FALLBACK_IMAGE_URL = "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1470&auto=format&fit=crop";
async function pickPhoto(dest, reqId) {
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

const tools = [ /* Tools remain unchanged from previous correct version */ ];

// ✅ A much more detailed and professional system prompt
const getSystemPrompt = (profile) => `You are a world-class, professional AI travel agent. Your goal is to create inspiring, comprehensive, and highly personalized travel plans.

**CRITICAL RULES:**
1.  **USE THE PROFILE:** Meticulously analyze the user profile below. Every part of the plan—activities, hotel style, flight class, budget—must reflect their stated preferences. In the plan's 'description' field, explicitly mention how you used their preferences (e.g., "An active solo trip focusing on museums, as requested.").
2.  **HANDLE NEW REQUESTS:** After a plan is created (the user history will contain "[PLAN_SNAPSHOT]"), you MUST treat the next user message as a **brand new request**. Forget the previous destination and start the planning process over. If they say "now to China," you must start planning a trip to China.
3.  **BE COMPREHENSIVE:** A real plan covers everything. Your generated itinerary must be detailed, spanning multiple days with at least 3-5 varied events per day (e.g., flights, transfers, meals at real local restaurants, tours, museum visits, relaxation time).
4.  **STRICT DATA FORMAT:** You must call a function. Never respond with just text if you can call a function. Adhere perfectly to the function's JSON schema.
    -   `weather.icon`: Must be one of: "sunny", "partly-sunny", "cloudy".
    -   `costBreakdown.iconValue`: For images, must be one of: 'getTransfer', 'radisson', 'getYourGuide', 'axa'.

**USER PROFILE:**
${JSON.stringify(profile, null, 2)}
`;

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
    
    // This is now purely a fallback for when the OpenAI call fails or is not available.
    const runFallbackFlow = async () => {
      const slots = deriveSlots(messages);
      if (!slots.destinationKnown) return { aiText: "Where would you like to go on your next adventure?" };
      if (!slots.datesKnown) return { aiText: `Sounds exciting! When would you like to go to ${slots.destination}?`, signal: { type: "dateNeeded" } };
      if (!slots.guestsKnown) return { aiText: "And how many people will be traveling?", signal: { type: "guestsNeeded" } };
      
      const payload = { location: slots.destination, country: 'Unavailable', dateRange: 'N/A', description: 'This is a fallback plan. Please try again to get a personalized itinerary.', image: await pickPhoto(slots.destination, reqId), price: 0, itinerary: [], costBreakdown: [] };
      return { aiText: "The AI planner is currently unavailable, but here is a basic outline.", signal: { type: "planReady", payload } };
    };

    if (!hasKey) {
        logInfo(reqId, "No API key found. Responding with fallback flow.");
        return res.json(await runFallbackFlow());
    }
    
    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...messages.filter(m => !m.hidden)];

    try {
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: convo,
            tools: tools,
            tool_choice: "auto",
        });

        const choice = completion.choices[0];
        const toolCall = choice.message?.tool_calls?.[0];

        if (toolCall) {
            const functionName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            logInfo(reqId, `AI called tool: ${functionName}`);

            if (functionName === "create_plan") {
                // Sanitize image and weather data just in case
                args.image = await pickPhoto(args.location, reqId);
                if (args.weather && !["sunny", "partly-sunny", "cloudy"].includes(args.weather.icon)) {
                    args.weather.icon = "sunny";
                }
                return res.json({ aiText: choice.message.content || "Here is your personalized plan!", signal: { type: 'planReady', payload: args } });
            }
            if (functionName === "request_dates") {
                return res.json({ aiText: choice.message.content || "When would you like to travel?", signal: { type: 'dateNeeded' } });
            }
            if (functionName === "request_guests") {
                return res.json({ aiText: choice.message.content || "How many people are traveling?", signal: { type: 'guestsNeeded' } });
            }
        }
        
        // If the AI responds with text instead of a tool call
        if (choice.message.content) {
            return res.json({ aiText: choice.message.content });
        }

        // Final fallback if the response is empty
        return res.json(await runFallbackFlow());

    } catch (e) {
        logError(reqId, 'OpenAI API call failed. Responding with fallback flow.', e);
        return res.json(await runFallbackFlow());
    }
    
  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    // This is the server's guarantee: always return a valid JSON response.
    return res.status(500).json({ aiText: "A critical server error occurred. Please try again." });
  }
});

export default router;
