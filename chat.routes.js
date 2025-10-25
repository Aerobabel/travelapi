// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import { getJson } from "serpapi"; // ✅ SERP: Google Flights & Hotels
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
const hasSerpApiKey = Boolean(process.env.SERPAPI_API_KEY);

const client = hasOpenAIKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// --- Assets / Caches ---
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1470&auto=format&fit=crop";
const userMem = new Map();
const imageCache = new Map();

// --- Utils / Logs ---
const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

// --- Memory/Profile ---
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

// --- Destination Extract ---
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

// --- Image helper ---
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
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
    if (!res.ok) {
      logError(reqId, `Unsplash API error: ${res.status} ${res.statusText}`);
      return FALLBACK_IMAGE_URL;
    }
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const imageUrl = data.results[0].urls.regular;
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

// --- Tools exposed to the model ---
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
      description:
        "Search for real flights based on user criteria via SERPAPI Google Flights. Return 1-3 best options with full legs, times, airlines, cabin, and total price.",
      parameters: {
        type: "object",
        properties: {
          departure_airport: { type: "string", description: "IATA code for departure, e.g., 'SFO'" },
          arrival_airport: { type: "string", description: "IATA code for arrival, e.g., 'CDG'" },
          departure_date: { type: "string", description: "YYYY-MM-DD" },
          return_date: { type: "string", description: "YYYY-MM-DD" },
          currency: { type: "string", description: "ISO currency code, e.g., 'USD'", default: "USD" },
        },
        required: ["departure_airport", "arrival_airport", "departure_date", "return_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_hotels",
      description:
        "Search real hotels via SERPAPI Google Hotels for a location and date range. Return 3-5 concrete hotels with name, rating, price/night, address, and booking links if present.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City or area to search hotels in." },
          check_in_date: { type: "string", description: "YYYY-MM-DD" },
          check_out_date: { type: "string", description: "YYYY-MM-DD" },
          currency: { type: "string", description: "ISO currency code, e.g., 'USD'", default: "USD" },
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
        "Return a full, detailed, day-by-day travel plan with a cost breakdown when destination, dates, and guests are known. MUST incorporate results of search_flights and search_hotels.",
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
                iconType: { type: "string", enum: ["image", "date", "plane", "hotel"] },
                iconValue: {
                  type: "string",
                  description:
                    "URL for image OR 'Mon Day' for date (e.g., 'Dec 26') OR airline/hotel name for plane/hotel.",
                },
              },
              required: ["item", "provider", "details", "price", "iconType", "iconValue"],
            },
          },
          // The model should include a `sources` field when possible with flight/hotel URLs.
          sources: {
            type: "array",
            items: { type: "string" },
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

// --- System Prompt (strongly pushes concrete flight/hotel usage) ---
const getSystemPrompt = (profile) => `You are a world-class, professional AI travel agent.

GOAL: Create inspiring, comprehensive, and highly personalized travel plans using REAL flight and hotel data from the provided search tools.

CRITICAL RULES
1) GATHER INFO FIRST: Use 'request_dates' and 'request_guests' if dates or guest counts are missing.
2) SEARCH FIRST, THEN PLAN: When dates/guests are known, MUST call 'search_flights' (round-trip) and 'search_hotels' for the user's city and dates BEFORE 'create_plan'.
3) USE SEARCH RESULTS: The final plan (create_plan) MUST embed concrete details:
   - Flights: airline + flight number (if available), departure/arrival airports (IATA), exact times, total duration, cabin, layovers. Pick the best 1-2 options aligned with preferences.
   - Hotels: 3-5 named hotels with rating, neighborhood, price/night (converted to the currency requested), short why-it-fits rationale.
   - Include these in the itinerary (arrival day: flight details and transfer; hotel check-in with hotel name; daily activities near the selected hotel).
   - In 'costBreakdown', add flight and hotel line items with iconType "plane" and "hotel".
4) PROFILE-ALIGNED: Activities, hotel style, cabin class, and budget must reflect the provided USER PROFILE. In 'description', explicitly say how profile guided the choices.
5) STRICT DATA FORMAT:
   - weather.icon ∈ {"sunny","partly-sunny","cloudy"}.
   - itinerary.date: "YYYY-MM-DD".
   - itinerary.day: "Mon Day" like "Dec 26".
6) AFTER a plan is produced ([PLAN_SNAPSHOT] appears in history), treat any next user message as a brand new request.

USER PROFILE:
${JSON.stringify(profile, null, 2)}
`;

// --- Snapshot / slot detection ---
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
  const guestsKnown =
    /👤|adult|children|kids|guests?|people/i.test(userTexts) && /\d/.test(userTexts);
  const destination = extractDestination(userTexts);
  return { destinationKnown: !!destination, destination, datesKnown, guestsKnown };
}

// --- Message normalization (no tool msgs from client required) ---
function normalizeMessages(messages = []) {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        return { role: "assistant", tool_calls: m.tool_calls };
      }
      if (m.role === "tool" && m.tool_call_id) {
        return { role: "tool", tool_call_id: m.tool_call_id, content: m.content || m.text || "" };
      }
      const role = allowedRoles.has(m.role) ? m.role : "user";
      const content = m.content ?? m.text ?? "";
      return { role, content: String(content) };
    });
}

// --- Server-side tool handlers (SERP) ---
async function handleSearchFlights(args, reqId) {
  if (!hasSerpApiKey) return { error: "Flight search unavailable: SERPAPI_API_KEY not set." };
  try {
    const resp = await getJson({
      engine: "google_flights",
      api_key: process.env.SERPAPI_API_KEY,
      departure_id: args.departure_airport,
      arrival_id: args.arrival_airport,
      outbound_date: args.departure_date,
      return_date: args.return_date,
      currency: args.currency || "USD",
    });

    // Parse best 1-3 options
    const collected = [];
    const take = (resp.best_flights || []).slice(0, 3);
    for (const opt of take) {
      const price = opt.price;
      const total_duration = opt.total_duration;
      const legs = (opt.flights || []).map((f) => ({
        airline: f.airline,
        flight_number: f.flight_number,
        cabin: f.cabin || null,
        departure_airport: `${f.departure_airport?.name} (${f.departure_airport?.id})`,
        arrival_airport: `${f.arrival_airport?.name} (${f.arrival_airport?.id})`,
        departure_time: f.departure_time,
        arrival_time: f.arrival_time,
        duration: f.duration || null,
      }));
      collected.push({
        price,
        currency: args.currency || "USD",
        total_duration,
        legs,
      });
    }

    // Fallback to other itineraries if best_flights empty
    if (collected.length === 0 && Array.isArray(resp.other_flights)) {
      for (const opt of resp.other_flights.slice(0, 2)) {
        const legs = (opt.flights || []).map((f) => ({
          airline: f.airline,
          flight_number: f.flight_number,
          cabin: f.cabin || null,
          departure_airport: `${f.departure_airport?.name} (${f.departure_airport?.id})`,
          arrival_airport: `${f.arrival_airport?.name} (${f.arrival_airport?.id})`,
          departure_time: f.departure_time,
          arrival_time: f.arrival_time,
          duration: f.duration || null,
        }));
        collected.push({
          price: opt.price,
          currency: args.currency || "USD",
          total_duration: opt.total_duration,
          legs,
        });
      }
    }

    return { flights: collected };
  } catch (e) {
    logError(reqId, "SERPAPI_FLIGHTS_ERROR:", e.message);
    return { error: "Could not retrieve flight information." };
  }
}

async function handleSearchHotels(args, reqId) {
  if (!hasSerpApiKey) return { error: "Hotel search unavailable: SERPAPI_API_KEY not set." };
  try {
    const resp = await getJson({
      engine: "google_hotels",
      api_key: process.env.SERPAPI_API_KEY,
      q: `hotels in ${args.location}`,
      check_in_date: args.check_in_date,
      check_out_date: args.check_out_date,
      currency: args.currency || "USD",
    });

    const props = Array.isArray(resp.properties) ? resp.properties.slice(0, 5) : [];
    const hotels = props.map((h) => ({
      name: h.name,
      rating: h.overall_rating,
      price_per_night: h.rate_per_night?.extracted_price,
      currency: args.currency || "USD",
      address: h.address,
      neighborhood: h.neighborhood,
      thumbnails: h.images?.slice?.(0, 1)?.map?.((img) => img.thumbnail) || [],
      link: h.link, // if available
      description: h.description,
    }));

    return { hotels };
  } catch (e) {
    logError(reqId, "SERPAPI_HOTELS_ERROR:", e.message);
    return { error: "Could not retrieve hotel information." };
  }
}

// --- Route ---
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(
      reqId,
      `POST /chat/travel, user=${userId}, hasOpenAIKey=${hasOpenAIKey}, hasSerpApiKey=${hasSerpApiKey}, fetch=${FETCH_SOURCE}`
    );
    const mem = getMem(userId);

    updateProfileFromHistory(messages, mem);

    // Fallback (no OpenAI key)
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
      return {
        aiText: "The AI planner is temporarily unavailable, but here is a basic outline.",
        signal: { type: "planReady", payload },
      };
    };

    if (!hasOpenAIKey) {
      logInfo(reqId, "No OpenAI API key found. Responding with fallback flow.");
      return res.json(await runFallbackFlow());
    }

    // Prepare conversation & system prompt
    const systemPrompt = getSystemPrompt(mem.profile);
    let currentConvo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];

    // Server-side tool execution loop (no dangling tool_calls returned to client)
    const MAX_TOOL_CALL_ITERATIONS = 6;
    for (let i = 0; i < MAX_TOOL_CALL_ITERATIONS; i++) {
      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: currentConvo,
        tools,
        tool_choice: "auto",
      });

      const choice = completion.choices?.[0];
      const message = choice?.message;

      // If plain text from assistant and no tool calls -> return to client
      if (message?.content && !message.tool_calls) {
        return res.json({ aiText: message.content });
      }

      // If tools are called, handle the FIRST one synchronously and continue the loop
      if (message?.tool_calls && message.tool_calls.length > 0) {
        currentConvo.push(message); // push assistant tool-call message
        const toolCall = message.tool_calls[0];
        const functionName = toolCall.function?.name;
        let args = {};
        try {
          args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        } catch (e) {
          logError(reqId, "Failed to parse tool arguments; aborting to fallback.", e);
          return res.json(await runFallbackFlow());
        }

        logInfo(reqId, `AI called tool: ${functionName}`);

        if (functionName === "request_dates") {
          // return UI signal; do NOT add a tool result (no tool to execute)
          return res.json({
            aiText: message.content || "When would you like to travel?",
            signal: { type: "dateNeeded" },
          });
        }

        if (functionName === "request_guests") {
          return res.json({
            aiText: message.content || "How many people are traveling?",
            signal: { type: "guestsNeeded" },
          });
        }

        if (functionName === "search_flights") {
          const toolResult = await handleSearchFlights(args, reqId);
          currentConvo.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
          continue; // let the model consume flight data and proceed
        }

        if (functionName === "search_hotels") {
          const toolResult = await handleSearchHotels(args, reqId);
          currentConvo.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
          continue;
        }

        if (functionName === "create_plan") {
          // Finalize the plan. We don't call a real tool, just enrich payload and return.
          const payload = { ...args };
          payload.image = await pickPhoto(payload.location, reqId);
          if (payload.weather && !["sunny", "partly-sunny", "cloudy"].includes(payload.weather.icon)) {
            payload.weather.icon = "sunny";
          }
          return res.json({
            aiText: message.content || "Here is your personalized travel plan!",
            signal: { type: "planReady", payload },
          });
        }

        // Unknown tool name
        logError(reqId, `Unknown tool called: ${functionName}`);
        return res.json(await runFallbackFlow());
      }

      // Neither content nor tool_calls
      logInfo(reqId, "Assistant returned no content and no tool calls; using fallback.");
      return res.json(await runFallbackFlow());
    }

    logError(reqId, "Agent loop exceeded max tool call iterations.");
    return res
      .status(500)
      .json({ aiText: "I'm having trouble creating a plan right now. Please try again." });
  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    return res.status(500).json({ aiText: "A critical server error occurred. Please try again." });
  }
});

export default router;
