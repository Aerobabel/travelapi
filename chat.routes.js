// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import { getJson } from "serpapi";
import dotenv from "dotenv";

dotenv.config();

/* ------------------------- POLYFILLS & SETUP ------------------------- */
let FETCH_SOURCE = "native";
try {
  if (typeof globalThis.fetch !== "function") {
    globalThis.fetch = (await import("node-fetch")).default;
    FETCH_SOURCE = "node-fetch";
  }
} catch (e) {
  console.error("[chat] fetch polyfill load failed:", e?.message);
}

const router = Router();

const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const hasSerpApiKey = Boolean(process.env.SERPAPI_API_KEY);

const OPENAI_MODEL =
  (process.env.OPENAI_MODEL || "").trim() || "gpt-4o-mini"; // fast + function-calling

const client = hasOpenAIKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

/* ------------------------- LOGGING & MEMORY -------------------------- */
const newReqId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

const userMem = new Map();
const imageCache = new Map();

/* ---------------------- PROFILE / MEMORY HELPERS --------------------- */
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

function updateProfileFromHistory(messages, mem) {
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.text ?? m.content ?? "")
    .join(" ")
    .toLowerCase();

  const { profile } = mem;

  const mappings = {
    preferred_travel_type: {
      beach: /beach/,
      active: /active|hiking|adventure/,
      urban: /city|urban/,
      relaxing: /relax|spa|leisure/,
    },
    travel_alone_or_with: {
      solo: /solo|by myself/,
      family: /family|with my kids/,
      friends: /friends|group/,
    },
    "flight_preferences.class": {
      premium_economy: /premium economy/,
      business: /business class/,
      first: /first class/,
    },
    "budget.prefer_comfort_or_saving": {
      comfort: /comfort|luxury/,
      saving: /saving|budget/,
    },
    liked_activities: {
      hiking: /hiking/,
      "wine tasting": /wine/,
      museums: /museum/,
      shopping: /shopping/,
      "extreme sports": /extreme sports|adrenaline/,
    },
  };

  for (const key in mappings) {
    for (const value in mappings[key]) {
      if (mappings[key][value].test(userTexts)) {
        if (key.includes(".")) {
          const [p, c] = key.split(".");
          profile[p][c] = value;
        } else if (Array.isArray(profile[key])) {
          if (!profile[key].includes(value)) profile[key].push(value);
        } else {
          profile[key] = value;
        }
      }
    }
  }
}

const cityList = [
  "Paris",
  "London",
  "Rome",
  "Barcelona",
  "Bali",
  "Tokyo",
  "New York",
  "Dubai",
  "Istanbul",
  "Amsterdam",
  "Madrid",
  "Milan",
  "Kyoto",
  "Lisbon",
  "Prague",
  "China",
];

function extractDestination(text = "") {
  const m = text.match(/\b(to|in|for|at)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (m) return m[2];
  for (const city of cityList) {
    if (new RegExp(`\\b${city}\\b`, "i").test(text)) return city;
  }
  return null;
}

/* --------------------------- IMAGE PICKER ---------------------------- */
const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1470&auto=format&fit=crop";

async function pickPhoto(dest, reqId) {
  const cacheKey = (dest || "").toLowerCase().trim();
  if (!cacheKey) return FALLBACK_IMAGE_URL;

  if (imageCache.has(cacheKey)) {
    logInfo(reqId, `[CACHE HIT] Serving image for "${dest}"`);
    return imageCache.get(cacheKey);
  }

  logInfo(reqId, `[CACHE MISS] Fetching new image for "${dest}"`);

  if (!UNSPLASH_ACCESS_KEY) {
    logError(reqId, "UNSPLASH_ACCESS_KEY is not set.");
    return FALLBACK_IMAGE_URL;
  }

  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
    `${dest} travel`
  )}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
    if (!res.ok) {
      logError(reqId, `Unsplash API error: ${res.status}`);
      return FALLBACK_IMAGE_URL;
    }
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const imageUrl = data.results[0].urls.regular;
      imageCache.set(cacheKey, imageUrl);
      return imageUrl;
    }
    return FALLBACK_IMAGE_URL;
  } catch (e) {
    logError(reqId, "Failed to fetch from Unsplash API", e.message);
    return FALLBACK_IMAGE_URL;
  }
}

/* -------------------- REAL DATA TOOL IMPLEMENTATIONS ----------------- */
const functionHandlers = {
  request_dates: async () => ({}), // UI-only
  request_guests: async () => ({}), // UI-only

  // FIXED: use getJson("google_flights", params)
  search_flights: async ({
    departure_airport,
    arrival_airport,
    departure_date,
    return_date,
  }) => {
    if (!hasSerpApiKey) return { error: "Flight search is unavailable." };
    try {
      const response = await getJson("google_flights", {
        api_key: process.env.SERPAPI_API_KEY,
        departure_id: departure_airport,
        arrival_id: arrival_airport,
        outbound_date: departure_date,
        return_date: return_date,
        currency: "USD",
        hl: "en",
        gl: "us",
      });

      const bestFlight = response.best_flights?.[0];
      if (!bestFlight) return { flights: [] };

      return {
        flights: [
          {
            price: bestFlight.price,
            airline: bestFlight.flights[0].airline,
            departure: `${bestFlight.flights[0].departure_airport.name} (${bestFlight.flights[0].departure_airport.id})`,
            arrival: `${bestFlight.flights[0].arrival_airport.name} (${bestFlight.flights[0].arrival_airport.id})`,
            total_duration: bestFlight.total_duration,
          },
        ],
      };
    } catch (e) {
      logError("SERPAPI_FLIGHTS_ERROR", e?.message || e);
      return { error: "Could not retrieve flight information." };
    }
  },

  // FIXED: use getJson("google_hotels", params)
  search_hotels: async ({ location, check_in_date, check_out_date }) => {
    if (!hasSerpApiKey) return { error: "Hotel search is unavailable." };
    try {
      const response = await getJson("google_hotels", {
        api_key: process.env.SERPAPI_API_KEY,
        q: `hotels in ${location}`,
        check_in_date,
        check_out_date,
        currency: "USD",
        hl: "en",
        gl: "us",
      });

      const hotels =
        response.properties?.slice(0, 3).map((h) => ({
          name: h.name,
          rating: h.overall_rating,
          price: h.rate_per_night?.extracted_price,
          description: h.description,
        })) || [];
      return { hotels };
    } catch (e) {
      logError("SERPAPI_HOTELS_ERROR", e?.message || e);
      return { error: "Could not retrieve hotel information." };
    }
  },

  create_plan: async (args) => args, // pass-through
};

/* --------------------- OPENAI TOOL DECLARATIONS ---------------------- */
const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "Ask the user for their travel dates.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Ask the user how many people are traveling.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_flights",
      description: "Search for real flights based on user criteria.",
      parameters: {
        type: "object",
        properties: {
          departure_airport: { type: "string", description: "IATA, e.g., 'SFO'" },
          arrival_airport: { type: "string", description: "IATA, e.g., 'CDG'" },
          departure_date: { type: "string", description: "YYYY-MM-DD" },
          return_date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: [
          "departure_airport",
          "arrival_airport",
          "departure_date",
          "return_date",
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_hotels",
      description: "Search for real hotels in a location for given dates.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          check_in_date: { type: "string", description: "YYYY-MM-DD" },
          check_out_date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["location", "check_in_date", "check_out_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Call ONLY when all info (flights, hotels, dates, etc.) is ready. Creates the final travel plan.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string" },
          description: { type: "string" },
          image: { type: "string" },
          price: { type: "number" },
          weather: {
            type: "object",
            properties: { temp: { type: "number" }, icon: { type: "string" } },
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string" },
                day: { type: "string" },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      icon: { type: "string" },
                      time: { type: "string" },
                      duration: { type: "string" },
                      title: { type: "string" },
                      details: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          costBreakdown: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item: { type: "string" },
                provider: { type: "string" },
                details: { type: "string" },
                price: { type: "number" },
                iconType: { type: "string" },
                iconValue: { type: "string" },
              },
            },
          },
        },
        required: [
          "location",
          "country",
          "dateRange",
          "description",
          "price",
          "itinerary",
          "costBreakdown",
        ],
      },
    },
  },
];

/* ------------------------ SYSTEM INSTRUCTION ------------------------- */
const getSystemPrompt = (profile) => `You are a world-class AI travel agent. Your goal is to create inspiring, personalized travel plans using real-world data.

CRITICAL RULES:
1) GATHER INFO FIRST: Use 'request_dates' and 'request_guests' tools to collect dates and headcount. Then use 'search_flights' and 'search_hotels'.
2) USE THE PROFILE: Reflect the user's preferences in the plan.
3) CREATE PLAN LAST: Call 'create_plan' only after data is gathered.
4) NEW REQUESTS: If history contains "[PLAN_SNAPSHOT]", treat the next message as a new request.

USER PROFILE:
${JSON.stringify(profile, null, 2)}
`;

/* ------------------- HISTORY NORMALIZER (OpenAI) --------------------- */
function normalizeToOpenAI(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m.hidden) continue;
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content || m.text || "" });
    } else if (m.role === "assistant" || m.role === "ai") {
      out.push({ role: "assistant", content: m.content || m.text || "" });
    }
  }
  return out;
}

/* --------------------------- ROUTES --------------------------------- */
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(
      reqId,
      `POST /chat/travel, user=${userId}, OpenAI=${hasOpenAIKey}, SerpApi=${hasSerpApiKey}, fetch=${FETCH_SOURCE}, model=${OPENAI_MODEL}`
    );

    if (!hasOpenAIKey || !client) {
      return res.status(500).json({ aiText: "The AI model is not configured." });
    }

    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    const systemPrompt = getSystemPrompt(mem.profile);
    const chatHistory = normalizeToOpenAI(messages);

    const baseMessages = [{ role: "system", content: systemPrompt }, ...chatHistory];

    /* --------------------------- AGENT LOOP -------------------------- */
    const MAX_TURNS = 6;
    let loopMessages = [...baseMessages];

    for (let i = 0; i < MAX_TURNS; i++) {
      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: loopMessages,
        tools,
        tool_choice: "auto",
        temperature: 0.7,
      });

      const msg = completion.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls || [];

      if (toolCalls.length > 0) {
        // Immediate UI prompts
        for (const tc of toolCalls) {
          const fn = tc.function?.name;
          if (fn === "request_dates") {
            return res.json({
              aiText: "When would you like to travel?",
              signal: { type: "dateNeeded" },
              assistantMessage: {
                role: "assistant",
                tool_calls: [
                  {
                    id: tc.id || `call_${reqId}`,
                    type: "function",
                    function: { name: "request_dates", arguments: "{}" },
                  },
                ],
              },
            });
          }
          if (fn === "request_guests") {
            return res.json({
              aiText: "How many people will be traveling?",
              signal: { type: "guestsNeeded" },
              assistantMessage: {
                role: "assistant",
                tool_calls: [
                  {
                    id: tc.id || `call_${reqId}`,
                    type: "function",
                    function: { name: "request_guests", arguments: "{}" },
                  },
                ],
              },
            });
          }
        }

        // Append assistant tool-calls
        loopMessages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: tc.function,
          })),
        });

        // Execute functions and append their results
        for (const tc of toolCalls) {
          const functionName = tc.function?.name;
          const rawArgs = tc.function?.arguments || "{}";
          let argsObj = {};
          try {
            argsObj = JSON.parse(rawArgs);
          } catch (e) {
            logError(reqId, `Bad tool args for ${functionName}:`, rawArgs);
          }

          const handler = functionHandlers[functionName];
          if (!handler) {
            logError(reqId, `Unknown tool: ${functionName}`);
            continue;
          }

          const result = await handler(argsObj);

          // If create_plan, finalize and return immediately
          if (functionName === "create_plan") {
            const payload = { ...result };
            payload.image = await pickPhoto(payload.location, reqId);

            return res.json({
              aiText: "Here is your personalized travel plan!",
              signal: { type: "planReady", payload },
            });
          }

          loopMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }

        continue; // go to next loop turn so model can use tool results
      }

      // No tool call → final text
      const finalText = msg?.content?.trim();
      if (finalText) {
        return res.json({ aiText: finalText });
      }

      return res.json({
        aiText:
          "I'm sorry, I couldn't process that right now. Could you try again with a bit more detail?",
      });
    }

    logError(reqId, "Agent loop exceeded max turns.");
    return res.status(500).json({
      aiText:
        "I'm having trouble creating a plan right now. Please try simplifying your request.",
    });
  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    return res.status(500).json({
      aiText: "A critical server error occurred. Please try again.",
    });
  }
});

export default router;
