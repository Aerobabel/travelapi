// server/chat.routes.js
import { Router } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
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

const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
const hasSerpApiKey = Boolean(process.env.SERPAPI_API_KEY);

// Use a supported model and avoid -latest aliases.
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";

// Create client and model; force API v1 (old SDK defaults to v1beta).
const genAI = hasGeminiKey ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const generativeModel = genAI
  ? genAI.getGenerativeModel({ model: GEMINI_MODEL }, { apiVersion: "v1" })
  : null;

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
  request_dates: async () => ({}), // No external data needed
  request_guests: async () => ({}), // No external data needed

  search_flights: async ({
    departure_airport,
    arrival_airport,
    departure_date,
    return_date,
  }) => {
    if (!hasSerpApiKey) return { error: "Flight search is unavailable." };
    try {
      const response = await getJson({
        engine: "google_flights",
        api_key: process.env.SERPAPI_API_KEY,
        departure_id: departure_airport,
        arrival_id: arrival_airport,
        outbound_date: departure_date,
        return_date: return_date,
        currency: "USD",
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
      logError("SERPAPI_FLIGHTS_ERROR", e.message);
      return { error: "Could not retrieve flight information." };
    }
  },

  search_hotels: async ({ location, check_in_date, check_out_date }) => {
    if (!hasSerpApiKey) return { error: "Hotel search is unavailable." };
    try {
      const response = await getJson({
        engine: "google_hotels",
        api_key: process.env.SERPAPI_API_KEY,
        q: `hotels in ${location}`,
        check_in_date,
        check_out_date,
        currency: "USD",
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
      logError("SERPAPI_HOTELS_ERROR", e.message);
      return { error: "Could not retrieve hotel information." };
    }
  },

  create_plan: async (args) => args, // Pass-through, plan assembled upstream
};

/* --------------------- GEMINI TOOL DECLARATIONS ---------------------- */
const toolDeclarations = [
  {
    functionDeclarations: [
      {
        name: "request_dates",
        description: "Call this to ask the user for their travel dates.",
      },
      {
        name: "request_guests",
        description: "Call this to ask the user how many people are traveling.",
      },
      {
        name: "search_flights",
        description: "Search for real flights based on user criteria.",
        parameters: {
          type: "object",
          properties: {
            departure_airport: {
              type: "string",
              description: "IATA code for departure, e.g., 'SFO'",
            },
            arrival_airport: {
              type: "string",
              description: "IATA code for arrival, e.g., 'CDG'",
            },
            departure_date: {
              type: "string",
              description: "Format YYYY-MM-DD",
            },
            return_date: { type: "string", description: "Format YYYY-MM-DD" },
          },
          required: [
            "departure_airport",
            "arrival_airport",
            "departure_date",
            "return_date",
          ],
        },
      },
      {
        name: "search_hotels",
        description: "Search for real hotels in a location for given dates.",
        parameters: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "The city to search for hotels in.",
            },
            check_in_date: {
              type: "string",
              description: "Format YYYY-MM-DD",
            },
            check_out_date: {
              type: "string",
              description: "Format YYYY-MM-DD",
            },
          },
          required: ["location", "check_in_date", "check_out_date"],
        },
      },
      {
        name: "create_plan",
        description:
          "Call this ONLY when all information (flights, hotels, dates, etc.) has been gathered. It creates the final travel plan for the user.",
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
              properties: {
                temp: { type: "number" },
                icon: { type: "string" },
              },
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
    ],
  },
];

/* ------------------------ SYSTEM INSTRUCTION ------------------------- */
const getSystemPrompt = (profile) => `You are a world-class AI travel agent. Your goal is to create inspiring, personalized travel plans using real-world data.

**CRITICAL RULES:**
1.  **GATHER INFO FIRST:** Do not invent information. First, use the 'request_dates' and 'request_guests' tools to get requirements from the user. Then, use 'search_flights' and 'search_hotels' to find real options.
2.  **USE THE PROFILE:** Analyze the user profile. The plan must reflect their preferences (travel type, budget, etc.).
3.  **CREATE PLAN LAST:** Only after gathering all necessary information with the other tools, call 'create_plan' to assemble the final itinerary for the user.
4.  **HANDLE NEW REQUESTS:** After a plan is created (history contains "[PLAN_SNAPSHOT]"), treat the next message as a new request and start the process over.

**USER PROFILE:**
${JSON.stringify(profile, null, 2)}
`;

/* ------------------- GEMINI MESSAGE NORMALIZER ---------------------- */
function normalizeToGemini(messages = []) {
  const history = [];
  let currentRole = "user";

  // Start with the user's first message
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (firstUserMsg) {
    history.push({
      role: "user",
      parts: [{ text: firstUserMsg.content || firstUserMsg.text }],
    });
  }

  // Process the rest
  for (const m of messages) {
    if (m.hidden || m.role === "system") continue;

    if (m.role === "assistant" || m.role === "ai") {
      const toolCalls = m.tool_calls?.map((tc) => ({
        id: tc.id,
        functionCall: {
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments || "{}"),
        },
      }));
      history.push({
        role: "model",
        parts: toolCalls
          ? [{ functionCall: toolCalls[0].functionCall }]
          : [{ text: m.content || m.text || "" }],
      });
      currentRole = "model";
    } else if (m.role === "tool") {
      history.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: "unknown",
              response: JSON.parse(m.content),
            },
          },
        ],
      });
      currentRole = "function";
    } else if (m.role === "user" && currentRole !== "user") {
      // Avoid consecutive user messages in Gemini content
      history.push({ role: "user", parts: [{ text: m.content || m.text }] });
      currentRole = "user";
    }
  }

  // Fix names of function responses to match the prior functionCall
  for (let i = 1; i < history.length; i++) {
    if (history[i].role === "function" && history[i - 1].role === "model") {
      const lastToolCall = history[i - 1].parts.find((p) => p.functionCall);
      if (lastToolCall) {
        history[i].parts[0].functionResponse.name = lastToolCall.functionCall.name;
      }
    }
  }

  return history;
}

/* --------------------------- ROUTES --------------------------------- */
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(
      reqId,
      `POST /chat/travel, user=${userId}, Gemini=${hasGeminiKey}, SerpApi=${hasSerpApiKey}, fetch=${FETCH_SOURCE}, model=${GEMINI_MODEL}`
    );

    if (!hasGeminiKey || !generativeModel) {
      return res.status(500).json({ aiText: "The AI model is not configured." });
    }

    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    const systemPrompt = getSystemPrompt(mem.profile);
    let convo = normalizeToGemini(messages);

    // Prepend system instruction as a user message (Gemini pattern)
    convo.unshift({ role: "user", parts: [{ text: `System Instruction: ${systemPrompt}` }] });
    // Optional: Acknowledge system instruction
    if (convo.length > 1) {
      convo.splice(1, 0, {
        role: "model",
        parts: [{ text: "Understood. I will follow all instructions. How can I help?" }],
      });
    }

    /* --------------------------- AGENT LOOP -------------------------- */
    const MAX_TURNS = 5;

    for (let i = 0; i < MAX_TURNS; i++) {
      const result = await generativeModel.generateContent({
        contents: convo,
        tools: toolDeclarations,
      });

      const choice = result?.response?.candidates?.[0];
      const assistantMessage = choice?.content;

      // Pull out any tool/function calls
      const toolCalls =
        assistantMessage?.parts
          ?.filter((p) => p.functionCall)
          ?.map((p) => p.functionCall) || [];

      // If there are no tool calls, treat as final text
      if (!toolCalls.length) {
        const textResponse =
          assistantMessage?.parts?.map((p) => p.text).join("") ||
          "I'm sorry, I couldn't process that. Could you try again?";
        return res.json({ aiText: textResponse });
      }

      // Process a single tool call at a time (simpler control flow)
      const toolCall = toolCalls[0];
      const functionName = toolCall.name;
      const args = toolCall.args || {};
      logInfo(reqId, `AI wants to call tool: ${functionName}`, args);

      // Add the model's tool request to history
      convo.push({ role: "model", parts: [{ functionCall: toolCall }] });

      // Immediate UI signals
      if (functionName === "request_dates") {
        return res.json({
          aiText: "When would you like to travel?",
          signal: { type: "dateNeeded" },
          assistantMessage: {
            role: "assistant",
            tool_calls: [
              {
                id: `call_${reqId}`,
                type: "function",
                function: { name: "request_dates", arguments: "{}" },
              },
            ],
          },
        });
      }

      if (functionName === "request_guests") {
        return res.json({
          aiText: "How many people will be traveling?",
          signal: { type: "guestsNeeded" },
          assistantMessage: {
            role: "assistant",
            tool_calls: [
              {
                id: `call_${reqId}`,
                type: "function",
                function: { name: "request_guests", arguments: "{}" },
              },
            ],
          },
        });
      }

      // Execute the function (API calls, etc.)
      const handler = functionHandlers[functionName];
      if (!handler) {
        throw new Error(`Unknown tool called: ${functionName}`);
      }
      const toolResult = await handler(args);

      // If the tool was create_plan, finalize and return
      if (functionName === "create_plan") {
        logInfo(reqId, "Final plan created by AI.");
        const payload = { ...toolResult };
        payload.image = await pickPhoto(payload.location, reqId);

        return res.json({
          aiText: "Here is your personalized travel plan!",
          signal: { type: "planReady", payload },
        });
      }

      // Otherwise, add function response and loop again
      convo.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: functionName,
              response: toolResult,
            },
          },
        ],
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
