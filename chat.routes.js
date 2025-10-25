// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import { getJson } from "serpapi"; // Import serpapi
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
const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const hasSerpApiKey = Boolean(process.env.SERPAPI_API_KEY); // Check for SerpAPI key

const client = hasOpenAIKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// --- START OF MODIFIED CODE ---
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
// --- END OF MODIFIED CODE ---

const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);
const userMem = new Map();
const imageCache = new Map();

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
    .map((m) => (m.text ?? m.content ?? ""))
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
    "budget.prefer_comfort_or_saving": { comfort: /comfort|luxury/, saving: /saving|budget/ },
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
    logError(reqId, "UNSPLASH_ACCESS_KEY is not set. Returning fallback image.");
    return FALLBACK_IMAGE_URL;
  }

  const query = encodeURIComponent(`${dest} travel`);
  const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
    if (!res.ok) {
      logError(reqId, `Unsplash API error: ${res.status} ${res.statusText}`);
      return FALLBACK_IMAGE_URL;
    }
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const imageUrl = data.results[0].urls.regular; // 'regular' is 1080px wide
      logInfo(reqId, `Found image for "${dest}": ${imageUrl}`);
      imageCache.set(cacheKey, imageUrl);
      return imageUrl;
    } else {
      logInfo(reqId, `No Unsplash results found for "${dest}".`);
      return FALLBACK_IMAGE_URL;
    }
  } catch (e) {
    logError(reqId, "Failed to fetch from Unsplash API", e.message);
    return FALLBACK_IMAGE_URL;
  }
}

// --- NEW: TOOL IMPLEMENTATIONS (FOR REAL DATA) ---
const functionHandlers = {
  request_dates: async () => ({}), // No external data needed
  request_guests: async () => ({}), // No external data needed

  search_flights: async ({ departure_airport, arrival_airport, departure_date, return_date }) => {
    if (!hasSerpApiKey) return { error: "Flight search is unavailable. SERPAPI_API_KEY is not set." };
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
        flights: [{
          price: bestFlight.price,
          airline: bestFlight.flights[0].airline,
          departure: `${bestFlight.flights[0].departure_airport.name} (${bestFlight.flights[0].departure_airport.id})`,
          arrival: `${bestFlight.flights[0].arrival_airport.name} (${bestFlight.flights[0].arrival_airport.id})`,
          total_duration: bestFlight.total_duration,
        }],
      };
    } catch (e) {
      logError("SERPAPI_FLIGHTS_ERROR", e.message);
      return { error: "Could not retrieve flight information." };
    }
  },

  search_hotels: async ({ location, check_in_date, check_out_date }) => {
    if (!hasSerpApiKey) return { error: "Hotel search is unavailable. SERPAPI_API_KEY is not set." };
    try {
      const response = await getJson({
        engine: "google_hotels",
        api_key: process.env.SERPAPI_API_KEY,
        q: `hotels in ${location}`,
        check_in_date,
        check_out_date,
        currency: "USD",
      });
      const hotels = response.properties?.slice(0, 3).map(h => ({
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

  create_plan: async (args) => args, // This tool now just passes data through
};

const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "Call this to ask the user for their travel dates.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Call this to ask the user how many people are traveling.",
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
          departure_airport: { type: "string", description: "IATA code for departure, e.g., 'SFO'" },
          arrival_airport: { type: "string", description: "IATA code for arrival, e.g., 'CDG'" },
          departure_date: { type: "string", description: "Format YYYY-MM-DD" },
          return_date: { type: "string", description: "Format YYYY-MM-DD" },
        },
        required: ["departure_airport", "arrival_airport", "departure_date", "return_date"],
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
          location: { type: "string", description: "The city to search for hotels in." },
          check_in_date: { type: "string", description: "Format YYYY-MM-DD" },
          check_out_date: { type: "string", description: "Format YYYY-MM-DD" },
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
        "Return a full, detailed, day-by-day travel plan with a cost breakdown when destination, dates, and guests are known, and AFTER flights and hotels have been searched.",
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
                date: { type: "string", description: "YYYY-MM-DD" },
                day: { type: "string", description: "e.g., Dec 26" },
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
                    required: ["type", "icon", "time", "duration", "title", "details"],
                  },
                },
              },
              required: ["date", "day", "events"],
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
                iconType: { type: "string", enum: ["image", "date", "plane", "hotel"] }, // Added plane and hotel
                iconValue: {
                  type: "string",
                  description: "A URL for the image OR 'Month Day' for date (e.g., 'Dec 26') OR airline name/hotel name",
                },
              },
              required: ["item", "provider", "details", "price", "iconType", "iconValue"],
            },
          },
        },
        required: [
          "location",
          "country",
          "dateRange",
          "description",
          "image",
          "price",
          "itinerary",
          "costBreakdown",
        ],
      },
    },
  },
];

const getSystemPrompt = (profile) => `You are a world-class, professional AI travel agent. Your goal is to create inspiring, comprehensive, and highly personalized travel plans using **real-world flight and hotel data from the search tools**.

**CRITICAL RULES:**
1.  **GATHER INFO FIRST:** Do not invent information. First, use the 'request_dates' and 'request_guests' tools to get initial requirements from the user.
2.  **SEARCH FIRST, THEN PLAN:** After gathering initial info, you MUST use the 'search_flights' and 'search_hotels' tools to find real options. Wait for the tool results before proceeding.
3.  **USE SEARCH RESULTS:** When calling 'create_plan', explicitly incorporate details from the 'search_flights' and 'search_hotels' results into the itinerary and cost breakdown.
4.  **USE THE PROFILE:** Meticulously analyze the user profile below. Every part of the plan—activities, hotel style, flight class, budget—must reflect their stated preferences. In the plan's 'description' field, explicitly mention how you used their preferences (e.g., "An active solo trip focusing on museums, as requested.").
5.  **HANDLE NEW REQUESTS:** After a plan is created (the user history will contain "[PLAN_SNAPSHOT]"), you MUST treat the next user message as a **brand new request**. Forget the previous destination and start the planning process over. If they say "now to China," you must start planning a trip to China.
6.  **BE COMPREHENSIVE:** A real plan covers everything. Your generated itinerary must be detailed, spanning multiple days with at least 3-5 varied events per day (e.g., flights, transfers, meals at real local restaurants, tours, museum visits, relaxation time).
7.  **STRICT DATA FORMAT:** You must call a function. Never respond with just text if you can call a function. Adhere perfectly to the function's JSON schema.
    -   \`weather.icon\`: Must be one of: "sunny", "partly-sunny", "cloudy".
    -   \`itinerary.date\`: MUST be in 'YYYY-MM-DD' format.
    -   \`itinerary.day\`: MUST be in 'Mon Day' format (e.g., 'Dec 26').
    -   \`costBreakdown.iconType\`: Can now also be "plane" or "hotel" if related to flight/hotel bookings.

**USER PROFILE:**
${JSON.stringify(profile, null, 2)}
`;

const lastSnapshotIdx = (h = []) => {
  for (let i = h.length - 1; i >= 0; i--) if (/\[plan_snapshot\]/i.test(h[i]?.text || "")) return i;
  return -1;
};

function deriveSlots(history = []) {
  const relevantHistory = history.slice(lastSnapshotIdx(history) + 1);
  const userTexts = relevantHistory
    .filter((m) => m.role === "user")
    .map((m) => (m.text ?? m.content ?? ""))
    .join("\n")
    .toLowerCase();
  const datesKnown = /📅|from\s+\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(userTexts);
  const guestsKnown = /👤|adult|children|kids|guests?|people/i.test(userTexts) && /\d/.test(userTexts);
  const destination = extractDestination(userTexts);
  return { destinationKnown: !!destination, destination, datesKnown, guestsKnown };
}

/** Normalize incoming messages to OpenAI's { role, content } format */
function normalizeMessages(messages = []) {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]); // Added 'tool' role
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      // Map tool_calls to 'assistant' role with tool_calls property
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: 'assistant',
          tool_calls: m.tool_calls
        };
      }
      // Map tool_response to 'tool' role with tool_call_id and content
      if (m.role === 'tool' && m.tool_call_id) {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id,
          content: m.content || m.text || ''
        };
      }
      const role = allowedRoles.has(m.role) ? m.role : "user";
      const content = m.content ?? m.text ?? "";
      return { role, content: String(content) };
    });
}


router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  // Store tool outputs for the current turn
  const toolOutputs = {}; 
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel, user=${userId}, hasOpenAIKey=${hasOpenAIKey}, hasSerpApiKey=${hasSerpApiKey}, fetch=${FETCH_SOURCE}`);
    const mem = getMem(userId);

    updateProfileFromHistory(messages, mem);

    const runFallbackFlow = async () => {
      const slots = deriveSlots(messages);
      logInfo(reqId, "Running fallback flow. Slots:", slots);
      if (!slots.destinationKnown)
        return { aiText: "Where would you like to go on your next adventure?" };
      if (!slots.datesKnown)
        return {
          aiText: `Sounds exciting! When would you like to go to ${slots.destination}?`,
          signal: { type: "dateNeeded" },
        };
      if (!slots.guestsKnown)
        return { aiText: "And how many people will be traveling?", signal: { type: "guestsNeeded" } };

      const payload = {
        location: slots.destination,
        country: "Unavailable",
        dateRange: "N/A",
        description: "This is a fallback plan. The AI planner is currently unavailable.",
        image: await pickPhoto(slots.destination, reqId),
        price: 0,
        itinerary: [],
        costBreakdown: [],
      };
      return { aiText: "The AI planner is temporarily unavailable, but here is a basic outline.", signal: { type: "planReady", payload } };
    };

    if (!hasOpenAIKey) {
      logInfo(reqId, "No OpenAI API key found. Responding with fallback flow.");
      return res.json(await runFallbackFlow());
    }

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];

    try {
      let currentConvo = [...convo]; // Create a mutable copy for the loop
      const MAX_TOOL_CALL_ITERATIONS = 5; // Prevent infinite loops
      for (let i = 0; i < MAX_TOOL_CALL_ITERATIONS; i++) {
        const completion = await client.chat.completions.create({
          model: "gpt-4o", // Using gpt-4o as it's excellent for tool use
          messages: currentConvo,
          tools,
          tool_choice: "auto",
        });

        const choice = completion.choices?.[0];
        const message = choice?.message;

        // If the AI provides a text response, we are done
        if (message?.content) {
          return res.json({ aiText: message.content });
        }

        // If the AI calls a tool
        if (message?.tool_calls && message.tool_calls.length > 0) {
          currentConvo.push(message); // Add AI's tool call to conversation history

          const toolCall = message.tool_calls[0]; // Process one tool at a time for simplicity
          const functionName = toolCall.function?.name;
          logInfo(reqId, `AI called tool: ${functionName}`);

          let args = {};
          try {
            args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
          } catch (e) {
            logError(reqId, "Failed to parse AI arguments, using fallback.", e);
            return res.json(await runFallbackFlow());
          }

          // Handle simple UI signals immediately
          if (functionName === "request_dates") {
            return res.json({
              aiText: message.content || "When would you like to travel?",
              signal: { type: "dateNeeded" },
              // Include the tool call in assistantMessage for frontend to track if needed
              assistantMessage: { role: 'assistant', tool_calls: [{ id: toolCall.id, type: 'function', function: { name: 'request_dates', arguments: JSON.stringify(args) } }] }
            });
          }
          if (functionName === "request_guests") {
            return res.json({
              aiText: message.content || "How many people are traveling?",
              signal: { type: "guestsNeeded" },
              // Include the tool call in assistantMessage for frontend to track if needed
              assistantMessage: { role: 'assistant', tool_calls: [{ id: toolCall.id, type: 'function', function: { name: 'request_guests', arguments: JSON.stringify(args) } }] }
            });
          }

          // Execute the function (API calls, etc.)
          const handler = functionHandlers[functionName];
          if (!handler) {
            throw new Error(`Unknown tool called: ${functionName}`);
          }
          const toolResult = await handler(args);
          toolOutputs[functionName] = toolResult; // Store tool output

          // Add tool response to conversation history
          currentConvo.push({
            tool_call_id: toolCall.id,
            role: "tool",
            content: JSON.stringify(toolResult),
          });

          // If the tool was create_plan, we're done!
          if (functionName === "create_plan") {
            logInfo(reqId, "Final plan created by AI.");
            const payload = { ...toolResult };
            payload.image = await pickPhoto(payload.location, reqId);
            if (payload.weather && !["sunny", "partly-sunny", "cloudy"].includes(payload.weather.icon)) {
              payload.weather.icon = "sunny"; // Default if AI gives invalid weather icon
            }
            return res.json({
              aiText: message.content || "Here is your personalized travel plan!",
              signal: { type: "planReady", payload },
            });
          }
          // If it's a search tool, loop again to let AI process results and decide next step (e.g., create_plan)
          // The loop will continue, and the AI will see the tool output in the `currentConvo`
        } else {
          // No tool call and no content, this shouldn't happen but log it
          logInfo(reqId, "AI did not call a tool or return text. Using fallback.");
          return res.json(await runFallbackFlow());
        }
      }

      logError(reqId, "Agent loop exceeded max tool call iterations.");
      return res.status(500).json({ aiText: "I'm having trouble creating a plan right now. Please try simplifying your request." });

    } catch (e) {
      logError(reqId, "OpenAI API call failed. Responding with fallback flow.", e);
      return res.json(await runFallbackFlow());
    }
  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    return res.status(500).json({ aiText: "A critical server error occurred. Please try again." });
  }
});

export default router;
