import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import Amadeus from 'amadeus';

dotenv.config();

// --- FETCH POLYFILL (No changes) ---
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
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

// --- GLOBAL HELPERS (No changes) ---
const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);
const userMem = new Map();
const imageCache = new Map();

// --- USER PROFILE & HISTORY LOGIC (No changes) ---
const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        preferred_travel_type: [], travel_alone_or_with: null, desired_experience: [],
        flight_preferences: { class: "economy" }, flight_priority: [],
        accommodation: { preferred_type: null, prefer_view: "doesn't matter" },
        budget: { prefer_comfort_or_saving: "balanced" }, preferred_formats: [], liked_activities: [],
      },
      lastDest: null,
    });
  }
  return userMem.get(userId);
};

function updateProfileFromHistory(messages, mem) {
  const userTexts = messages.filter((m) => m.role === "user").map((m) => (m.text ?? m.content ?? "")).join(" ").toLowerCase();
  const { profile } = mem;
  const mappings = {
    preferred_travel_type: { beach: /beach/, active: /active|hiking|adventure/, urban: /city|urban/, relaxing: /relax|spa|leisure/, },
    travel_alone_or_with: { solo: /solo|by myself/, family: /family|with my kids/, friends: /friends|group/, },
    "flight_preferences.class": { premium_economy: /premium economy/, business: /business class/, first: /first class/, },
    "budget.prefer_comfort_or_saving": { comfort: /comfort|luxury/, saving: /saving|budget/ },
    liked_activities: { hiking: /hiking/, "wine tasting": /wine/, museums: /museum/, shopping: /shopping/, "extreme sports": /extreme sports|adrenaline/, },
  };
  for (const key in mappings) {
    for (const value in mappings[key]) {
      if (mappings[key][value].test(userTexts)) {
        if (key.includes(".")) {
          const [p, c] = key.split(".");
          profile[p][c] = value;
        } else if (Array.isArray(profile[key])) {
          if (!profile[key].includes(value)) profile[key].push(value);
        } else { profile[key] = value; }
      }
    }
  }
}

function deriveGuestCount(messages) {
    const userTexts = messages.filter(m => m.role === 'user').map(m => m.text ?? m.content ?? '').join('\n').toLowerCase();
    const match = userTexts.match(/(\d+)\s*(adults|guests|people|person)/);
    return match ? parseInt(match[1], 10) : 1;
}

// --- IMAGE FETCHER (No changes) ---
const FALLBACK_IMAGE_URL = "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1470&auto=format&fit=crop";
async function pickPhoto(dest, reqId) {
  const cacheKey = (dest || "").toLowerCase().trim();
  if (!cacheKey) return FALLBACK_IMAGE_URL;
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
  logInfo(reqId, `[CACHE MISS] Fetching new image for "${dest}"`);
  if (!UNSPLASH_ACCESS_KEY) return FALLBACK_IMAGE_URL;
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(`${dest} travel`)}&per_page=1&orientation=landscape`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
    if (!res.ok) return FALLBACK_IMAGE_URL;
    const data = await res.json();
    const imageUrl = data.results?.[0]?.urls?.regular || FALLBACK_IMAGE_URL;
    imageCache.set(cacheKey, imageUrl);
    return imageUrl;
  } catch (e) {
    logError(reqId, "Failed to fetch from Unsplash API", e.message);
    return FALLBACK_IMAGE_URL;
  }
}


// =================================================================
// --- 1. AMADEUS REAL-TIME DATA INTEGRATION ---
// =================================================================

const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_API_KEY,
  clientSecret: process.env.AMADEUS_API_SECRET,
});

const getCityCode = async (cityName) => {
  if (!cityName) return null;
  try {
    const response = await amadeus.referenceData.locations.get({ keyword: cityName, subType: Amadeus.location.city });
    return response.data[0]?.iataCode;
  } catch (err) {
    console.error("[Amadeus] Failed to get city code:", err?.description || err);
    return null;
  }
};

const TravelData = {
  async find_flights(origin_airport, destination, departure_date, return_date, num_adults) {
    logInfo(`[Amadeus] Searching flights: ${origin_airport} -> ${destination} on ${departure_date}`);
    const destinationCode = await getCityCode(destination);
    if (!destinationCode) return "Could not find a valid airport code for the destination.";
    
    try {
      const response = await amadeus.shopping.flightOffersSearch.get({
        originLocationCode: origin_airport,
        destinationLocationCode: destinationCode,
        departureDate: departure_date,
        returnDate: return_date,
        adults: String(num_adults),
        max: 5, // Get top 5 results
        currencyCode: 'USD',
      });

      return response.data.map(offer => ({
        price: parseFloat(offer.price.total),
        airline: offer.validatingAirlineCodes[0],
        // Provides a summary of the outbound flight
        outbound_summary: `Departs: ${offer.itineraries[0].segments[0].departure.at}, Arrives: ${offer.itineraries[0].segments[offer.itineraries[0].segments.length - 1].arrival.at}, Duration: ${offer.itineraries[0].duration}`,
        // Provides a summary of the return flight if it exists
        return_summary: offer.itineraries[1] ? `Departs: ${offer.itineraries[1].segments[0].departure.at}, Arrives: ${offer.itineraries[1].segments[offer.itineraries[1].segments.length - 1].arrival.at}, Duration: ${offer.itineraries[1].duration}` : 'N/A',
      }));

    } catch (err) {
      console.error("[Amadeus] Flight search error:", err?.description || err);
      return `Flight search failed: ${err?.description?.detail || "No flights found for the given criteria."}`;
    }
  },

  async find_hotels(location, check_in, check_out, num_adults) {
    logInfo(`[Amadeus] Searching hotels in ${location} for ${check_in}-${check_out}`);
    const cityCode = await getCityCode(location);
    if (!cityCode) return "Could not find a valid city code for the location.";

    try {
      const response = await amadeus.shopping.hotelOffersSearch.get({
        cityCode: cityCode,
        checkInDate: check_in,
        checkOutDate: check_out,
        adults: String(num_adults),
        radius: 20,
        radiusUnit: 'KM',
        ratings: '3,4,5',
        bestRateOnly: true,
      });
      
      return response.data.map(hotelOffer => ({
        name: hotelOffer.hotel.name,
        price_per_night: parseFloat(hotelOffer.offers[0].price.total),
        rating: hotelOffer.hotel.rating,
      }));

    } catch (err) {
      console.error("[Amadeus] Hotel search error:", err?.description || err);
      return `Hotel search failed: ${err?.description?.detail || "No hotels found for the given criteria."}`;
    }
  }
};


// =================================================================
// --- 2. UPDATED AI TOOLS & SYSTEM PROMPT ---
// =================================================================

const tools = [
  { type: "function", function: { name: "request_dates", description: "Use this if you need the user's desired travel dates.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_guests", description: "Use this if you need to know how many people are traveling.", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "find_flights",
      description: "Search for real-time flight availability and pricing. You must call this before creating a plan.",
      parameters: {
        type: "object",
        properties: {
          origin_airport: { type: "string", description: "The 3-letter IATA code for the departure airport (e.g., JFK, LAX). You must ask the user for this if you don't have it." },
          destination: { type: "string", description: "The destination city name (e.g., Paris, Tokyo)." },
          departure_date: { type: "string", description: "Format: YYYY-MM-DD" },
          return_date: { type: "string", description: "Format: YYYY-MM-DD. Optional for one-way trips." },
        },
        required: ["origin_airport", "destination", "departure_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_hotels",
      description: "Search for real-time hotel availability and pricing. You must call this before creating a plan.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "The city where to search for hotels." },
          check_in: { type: "string", description: "Format: YYYY-MM-DD" },
          check_out: { type: "string", description: "Format: YYYY-MM-DD" },
        },
        required: ["location", "check_in", "check_out"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Return a full travel plan ONLY after gathering all necessary real-time flight and hotel data.",
      parameters: { /* The original, large schema from your code */
        type: "object",
        properties: {
          location: { type: "string" }, country: { type: "string" }, dateRange: { type: "string" },
          description: { type: "string" }, image: { type: "string" }, price: { type: "number" },
          weather: { type: "object", properties: { temp: { type: "number" }, icon: { type: "string" } } },
          itinerary: { type: "array", items: { type: "object", properties: {
            date: { type: "string", description: "YYYY-MM-DD" }, day: { type: "string", description: "e.g., Dec 26" },
            events: { type: "array", items: { type: "object", properties: {
              type: { type: "string" }, icon: { type: "string" }, time: { type: "string" }, duration: { type: "string" },
              title: { type: "string" }, details: { type: "string" },
            }, required: ["type", "icon", "time", "duration", "title", "details"] } },
          }, required: ["date", "day", "events"] } },
          costBreakdown: { type: "array", items: { type: "object", properties: {
            item: { type: "string" }, provider: { type: "string" }, details: { type: "string" }, price: { type: "number" },
            iconType: { type: "string", enum: ["image", "date"] },
            iconValue: { type: "string", description: "A URL for the image OR 'Month Day' for date (e.g., 'Dec 26')" },
          }, required: ["item", "provider", "details", "price", "iconType", "iconValue"] } },
        },
        required: ["location", "country", "dateRange", "description", "image", "price", "itinerary", "costBreakdown"],
      },
    },
  },
];

const getSystemPrompt = (profile) => `You are a world-class, professional AI travel agent.

**CRITICAL EXECUTION PATH:**
1.  **GATHER INFO:** If destination, dates, guest count, or origin airport are missing, ask for them. You MUST have the origin airport's 3-letter IATA code.
2.  **SEARCH REAL DATA:** Once you have the basics, you **MUST** call \`find_flights\` and \`find_hotels\` to get real-time data. DO NOT make up prices, flight numbers, or hotel names.
3.  **ANALYZE & SELECT:** Review the search results from the tools. Based on the user's profile (e.g., 'budget' vs 'comfort'), select the most suitable flight and hotel.
4.  **CREATE FINAL PLAN:** Call \`create_plan\` using the **specific, real details** (e.g., flight price from the tool, hotel name from the tool) you just gathered. Explicitly mention the airline and hotel in the plan's cost breakdown.
5.  **PROFILE:** Meticulously analyze the user profile and reflect their preferences in the plan.

**USER PROFILE:**
${JSON.stringify(profile, null, 2)}
`;


// =================================================================
// --- 3. REWRITTEN ROUTE WITH AGENT LOOP ---
// =================================================================

function normalizeMessages(messages = []) {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      const role = allowedRoles.has(m.role) ? m.role : "user";
      const content = m.content ?? m.text ?? "";
      if (role === 'tool') {
          return { role: 'tool', tool_call_id: m.tool_call_id, content: String(content) };
      }
      return { role, content: String(content) };
    });
}

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    if (!hasKey) return res.status(500).json({ aiText: "Server is not configured with an API key." });
    
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel, user=${userId}`);
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    const systemPrompt = getSystemPrompt(mem.profile);
    let convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];
    
    let maxTurns = 5;
    
    while (maxTurns > 0) {
      maxTurns--;

      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: convo,
        tools,
        tool_choice: "auto",
      });

      const choice = completion.choices[0];
      const message = choice.message;

      // Add the assistant's response (including any tool calls) to the conversation history
      convo.push(message);

      if (!message.tool_calls) {
        // If the AI is just talking, we're done. Return the text to the user.
        return res.json({ aiText: message.content });
      }

      // --- Process Tool Calls ---
      const toolCall = message.tool_calls[0]; // Handle one tool at a time for simplicity
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      logInfo(reqId, `Agent wants to call tool: ${functionName}`, args);
      
      // These tools are "final steps" - they send a signal back to the UI
      if (functionName === "create_plan") {
        args.image = await pickPhoto(args.location, reqId);
        return res.json({
          aiText: message.content || "Here is your personalized, real-time plan!",
          signal: { type: "planReady", payload: args },
        });
      }
      if (functionName === "request_dates") {
        return res.json({ aiText: message.content || "When would you like to travel?", signal: { type: "dateNeeded" } });
      }
      if (functionName === "request_guests") {
        return res.json({ aiText: message.content || "How many people are traveling?", signal: { type: "guestsNeeded" } });
      }

      // These tools are "intermediate steps" - we call them and loop back to the AI
      let toolResult;
      const numAdults = deriveGuestCount(messages);

      if (functionName === "find_flights") {
        toolResult = await TravelData.find_flights(args.origin_airport, args.destination, args.departure_date, args.return_date, numAdults);
      } else if (functionName === "find_hotels") {
        toolResult = await TravelData.find_hotels(args.location, args.check_in, args.check_out, numAdults);
      } else {
        toolResult = { error: "Unknown tool called" };
      }

      // Add the tool's result to the conversation history
      convo.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });

      // Continue the loop to let the AI process the tool's result
    }
    
    // If the loop finishes without returning, something went wrong.
    logError(reqId, "Agent loop timed out.");
    return res.status(500).json({ aiText: "I'm having trouble creating a plan right now. Please try again." });

  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    return res.status(500).json({ aiText: "A critical server error occurred. Please try again." });
  }
});

export default router;
