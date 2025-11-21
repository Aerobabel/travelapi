// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// --- 0. GLOBAL SAFETY & FETCH POLYFILL --------------------------------------
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED PROMISE REJECTION]", reason);
});

let FETCH_SOURCE = "native";
try {
  if (typeof globalThis.fetch !== "function") {
    const nodeFetch = (await import("node-fetch")).default;
    globalThis.fetch = nodeFetch;
    FETCH_SOURCE = "node-fetch";
  }
} catch (e) {
  console.error("[chat] fetch polyfill error:", e?.message);
}

// --- 1. BASIC SETUP ---------------------------------------------------------
const router = Router();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const SERPAPI_KEY = process.env.SERPAPI_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

const newReqId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (id, ...args) => console.log(`[chat][${id}]`, ...args);
const logError = (id, ...args) => console.error(`[chat][${id}]`, ...args);

// --- 2. IN-MEMORY PROFILE/MEMORY -------------------------------------------
const userMem = new Map();
const imageCache = new Map();

function getMem(userId) {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        origin_city: null,
        nationality: null,

        preferred_travel_type: [],
        travel_alone_or_with: null,
        desired_experience: [],

        flight_preferences: {
          class: null,
        },
        flight_priority: [],

        accommodation: {
          preferred_type: null,
          prefer_view: null,
        },

        budget: {
          prefer_comfort_or_saving: "balanced",
        },

        preferred_formats: [],
        liked_activities: [],
        multi_cities: [],
      },
    });
  }
  return userMem.get(userId);
}

// --- 3. HELPERS -------------------------------------------------------------

const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&q=80";

async function pickPhoto(dest, reqId) {
  const key = (dest || "").toLowerCase().trim();
  if (imageCache.has(key)) return imageCache.get(key);
  if (!UNSPLASH_ACCESS_KEY) return FALLBACK_IMAGE_URL;

  const query = encodeURIComponent(`${dest} travel tourist landmark`);
  const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
    if (!res.ok) return FALLBACK_IMAGE_URL;
    const data = await res.json();
    const img = data?.results?.[0]?.urls?.regular || FALLBACK_IMAGE_URL;
    imageCache.set(key, img);
    return img;
  } catch (e) {
    logError(reqId, "Unsplash error:", e);
    return FALLBACK_IMAGE_URL;
  }
}

const extractMultiCities = (text = "") => {
  const parts = text
    .split(/to|->|→|,|then|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  return parts.length > 1 ? parts : [];
};

function updateProfileFromHistory(messages, mem) {
  const lastUser = messages.filter((m) => m.role === "user").pop();
  if (!lastUser) return;

  let text = "";
  if (typeof lastUser.content === "string") {
    text = lastUser.content;
  } else if (Array.isArray(lastUser.content)) {
    const t = lastUser.content.find((c) => c.type === "text");
    if (t) text = t.text || "";
  } else if (lastUser.text) {
    text = lastUser.text;
  }

  text = String(text || "");
  const lower = text.toLowerCase();
  const profile = mem.profile;

  // Basic Extraction
  const fromMatch = lower.match(/from\s+([a-z\s]+)/i);
  if (fromMatch?.[1]) profile.origin_city = fromMatch[1].trim();

  const natMatch = lower.match(/i am from\s+([a-z\s]+)/i);
  if (natMatch?.[1]) profile.nationality = natMatch[1].trim();

  ["beach", "active", "urban", "relaxing"].forEach((t) => {
    if (lower.includes(t) && !profile.preferred_travel_type.includes(t))
      profile.preferred_travel_type.push(t);
  });
  ["solo", "family", "friends"].forEach((t) => {
    if (lower.includes(t)) profile.travel_alone_or_with = t;
  });
  ["fun", "relaxation", "photography", "luxury", "local culture"].forEach((t) => {
    if (lower.includes(t) && !profile.desired_experience.includes(t))
      profile.desired_experience.push(t);
  });
  ["economy", "premium economy", "business", "first"].forEach((cls) => {
    if (lower.includes(cls)) profile.flight_preferences.class = cls;
  });
  ["price", "comfort", "duration"].forEach((p) => {
    if (lower.includes(p) && !profile.flight_priority.includes(p))
      profile.flight_priority.push(p);
  });
  ["hotel", "apartment", "villa", "hostel"].forEach((t) => {
    if (lower.includes(t)) profile.accommodation.preferred_type = t;
  });
  ["sea", "mountains", "city"].forEach((v) => {
    if (lower.includes(v)) profile.accommodation.prefer_view = v;
  });
  ["comfort", "saving", "balanced"].forEach((b) => {
    if (lower.includes(b)) profile.budget.prefer_comfort_or_saving = b;
  });

  const cities = extractMultiCities(text);
  if (cities.length > 1) profile.multi_cities = cities;
}

function formatDateToMMMDD(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  return `${month} ${day}`;
}

// --- 4. SERPAPI SEARCH LAYER -----------------------------------------------

async function performGoogleSearch(rawQuery, reqId) {
  if (!SERPAPI_KEY) {
    logInfo(reqId, "[SEARCH] No SERPAPI_KEY, returning stub");
    return `Search skipped (no SERPAPI_KEY). Query: ${rawQuery}`;
  }

  const query = rawQuery || "";
  logInfo(reqId, `[SEARCH] "${query}"`);
  const startsWith = (prefix) => query.startsWith(prefix);

  try {
    // --- RESTAURANTS ---
    if (startsWith("__restaurants__")) {
      const loc = query.replace("__restaurants__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(
        loc + " best restaurants"
      )}&hl=en&type=search&api_key=${SERPAPI_KEY}`;
      
      const data = await fetch(url).then((r) => r.json());
      const results = (data.local_results || []).slice(0, 7).map(r => ({
        title: r.title,
        price: r.price,
        rating: r.rating,
        type: r.type,
        address: r.address
      }));
      return JSON.stringify(results);
    }

    // --- HOTELS ---
    if (startsWith("__hotels__")) {
      const loc = query.replace("__hotels__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(
        loc
      )}&currency=USD&api_key=${SERPAPI_KEY}`;
      
      const data = await fetch(url).then((r) => r.json());
      const results = (data.properties || []).slice(0, 7).map(p => ({
        name: p.name,
        total_rate: p.total_rate?.lowest || p.rate_per_night?.lowest,
        rating: p.overall_rating,
        description: p.description,
        link: p.link
      }));
      return JSON.stringify(results);
    }

    // --- FLIGHTS ---
    if (startsWith("__flights__")) {
      const cleaned = query.replace("__flights__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_flights&q=${encodeURIComponent(
        cleaned
      )}&currency=USD&api_key=${SERPAPI_KEY}`;
      
      const data = await fetch(url).then((r) => r.json());
      const flights = data.best_flights || data.other_flights || [];
      const simplerFlights = flights.slice(0, 5).map(f => {
        const leg = f.flights?.[0] || {};
        return {
          airline: leg.airline,
          flight_number: leg.flight_number,
          departure: leg.departure_airport?.time,
          arrival: leg.arrival_airport?.time,
          duration: f.total_duration,
          price: f.price
        };
      });

      return simplerFlights.length > 0 
        ? JSON.stringify(simplerFlights) 
        : "No direct flight data found via API. Use estimates based on 'Approx 500-800 USD'.";
    }

    // --- ACTIVITIES ---
    if (startsWith("__activities__")) {
      const loc = query.replace("__activities__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(
        loc + " must do things"
      )}&hl=en&type=search&api_key=${SERPAPI_KEY}`;
      
      const data = await fetch(url).then((r) => r.json());
      const results = (data.local_results || []).slice(0, 10).map(r => ({
        title: r.title,
        type: r.type,
        rating: r.rating,
        description: r.description
      }));
      return JSON.stringify(results);
    }

    // --- FALLBACK ---
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
      query
    )}&api_key=${SERPAPI_KEY}&num=8`;
    const res = await fetch(url);
    const data = await res.json();

    const out = [];
    if (data.organic_results) {
      data.organic_results.slice(0, 6).forEach((r) => {
        out.push(`Result: ${r.title}\nSnippet: ${r.snippet}\nLink: ${r.link}`);
      });
    }
    return out.join("\n\n") || "No relevant details found.";

  } catch (err) {
    logError(reqId, "SerpAPI Error", err);
    return "Search API failed. Proceed with best estimates.";
  }
}

// --- 5. TOOLS ---------------------------------------------------------------

const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "Trigger the date picker UI. Call this IMMEDIATELY when the user agrees on a destination.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Trigger the guest picker UI. Call this IMMEDIATELY when you need to know who is traveling.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description: "Search real data. Use prefixes: '__flights__ Helsinki to Paris', '__hotels__ Bali', '__restaurants__ Rome', '__activities__ Tokyo', '__visa__ US to China', '__weather__ London Dec'.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Finalize the trip. ONLY call this after you have searched for and found real flights, real hotels, and activities.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string" },
          description: { type: "string" },
          price: { type: "number", description: "Total estimated cost" },
          weather: {
            type: "object",
            properties: { temp: { type: "number" }, icon: { type: "string" } },
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "ISO format '2025-11-20'" },
                day: { type: "string", description: "ISO format '2025-11-20'" },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["activity", "food", "travel", "stay"] },
                      icon: { type: "string" },
                      time: { type: "string", description: "24h format e.g. 14:00" },
                      duration: { type: "string" },
                      title: { type: "string" },
                      details: { type: "string" },
                      provider: { type: "string", description: "REAL NAME of place/airline/hotel" },
                      approxPrice: { type: "number" },
                    },
                    required: ["type", "title", "details", "provider"],
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
                iconType: { type: "string" },
                iconValue: { type: "string" },
              },
            },
          },
          multiCity: { type: "boolean" },
          cities: { type: "array", items: { type: "string" } },
          visa: { type: "string" },
          currency: { type: "string" },
          flights: {
            type: "array",
            items: {
              type: "object",
              properties: {
                route: { type: "string" },
                airline: { type: "string" },
                flightNumber: { type: "string" },
                cabinClass: { type: "string" },
                departTime: { type: "string" },
                arriveTime: { type: "string" },
                price: { type: "number" },
              },
            },
          },
          alternatives: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                reason: { type: "string" },
                weatherSummary: { type: "string" },
              },
            },
          },
        },
        required: ["location", "price", "itinerary"],
      },
    },
  },
];

// --- 6. SYSTEM PROMPT -------------------------------------------------------

const getSystemPrompt = (profile) => `
You are an elite AI TRAVEL ARCHITECT. Your goal is to build **realistic, bookable, and rich** itineraries.

PROFILE CONTEXT:
- Origin: ${profile.origin_city || "Unknown (Ask user)"}
- Travel Style: ${profile.preferred_travel_type.join(", ") || "Any"}
- Budget: ${profile.budget.prefer_comfort_or_saving}
- Dates/Guests: You MUST use tools \`request_dates\` and \`request_guests\` to get these.

--- YOUR PROCESS (STRICT) ---

1. **DISCOVERY**: Ask short questions to find Destination, Dates, and Guests.
   - DO NOT plan anything until you have Dates and Guest count.
   - Use \`request_dates\` and \`request_guests\` immediately when context allows.

2. **RESEARCH (MANDATORY)**:
   - Once you have the basic details, you MUST search for REAL availability.
   - **FLIGHTS**: Call \`search_google\` with "__flights__ [Origin] to [Dest] [Dates]".
   - **HOTELS**: Call \`search_google\` with "__hotels__ [Dest] [Dates]".
   - **ACTIVITIES**: Call \`search_google\` with "__activities__ [Dest]" and "__restaurants__ [Dest]".

3. **PLANNING (RICH & REAL)**:
   - When calling \`create_plan\`, the data MUST be real.
   - **NO GENERIC PLACEHOLDERS**: Never say "Local Restaurant" or "Nice Hotel". Use the specific names found in your search (e.g., "Hotel Ristorante Roma", "Lufthansa LH404").
   - **REAL PRICES**: Use the prices found in search to calculate the \`price\` field.
   - **FLIGHTS**: Fill the \`flights\` array with specific options found (Airline, Flight Number, Price).
   - **ITINERARY**: Every event must have a specific \`provider\` (name of place) and a realistic \`time\`.

4. **CLOSING**:
   - Do not chat endlessly. Once you have searched Flights/Hotels/Activities, generate the plan immediately.

--- RULES ---
- **One tool per message**: Do not call multiple tools at once.
- **Short Chat**: Keep your text responses to the user brief (WhatsApp style). The richness goes into the JSON plan.
- **Currency**: Assume USD unless specified.
- **Dates**: In the JSON, always use ISO format "YYYY-MM-DD".

--- CRITICAL ---
If you have the destination, dates, and guests, do NOT ask "Shall I create the plan?". JUST CREATE IT.
Start by searching for flights and hotels, then compile.
`;

// --- 7. NORMALIZE MESSAGES --------------------------------------------------

function normalizeMessages(messages = []) {
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.tool_call_id,
          content: m.content,
        };
      }
      if (m.role === "user" && Array.isArray(m.content)) {
        return { role: "user", content: m.content };
      }
      let role = m.role;
      if (role === "ai") role = "assistant";
      if (role === "plan") role = "assistant"; 

      let content = m.content || m.text || "";
      if (role === "assistant" && m.payload) {
        content = "[Previous plan displayed to user]";
      }
      return { role, content: String(content) };
    });
}

// --- 8. MAIN ROUTE ----------------------------------------------------------

router.post("/travel", async (req, res) => {
  const reqId = newReqId();

  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey || !client) {
      return res.json({ aiText: "API Key missing. Cannot plan trip." });
    }

    const systemPrompt = getSystemPrompt(mem.profile);
    const baseHistory = [
      { role: "system", content: systemPrompt },
      ...normalizeMessages(messages),
    ];

    const runConversation = async (conversation, depth = 0) => {
      // --- SAFETY VALVE ---
      if (depth > 7) {
        logInfo(reqId, "Forcing plan creation due to depth");
        conversation.push({
            role: "system",
            content: "SYSTEM INTERVENTION: You have gathered enough information. Stop asking questions. Use the data you have found (or make reasonable real-world estimates) and call the 'create_plan' tool IMMEDIATELY."
        });
      } else if (depth > 9) {
          return { aiText: "I'm having trouble finalizing. Let's start fresh." };
      }

      let completion;
      try {
        completion = await client.chat.completions.create({
          model: "gpt-4o",
          messages: conversation,
          tools,
          tool_choice: "auto",
          temperature: 0.2,
        });
      } catch (err) {
        logError(reqId, "OpenAI Error", err);
        return { aiText: "My planning brain is offline briefly." };
      }

      const msg = completion.choices[0]?.message;
      if (!msg) return { aiText: "No response." };

      // --- TOOL CALL HANDLING (CRITICAL FIX) ---
      if (msg.tool_calls?.length) {
        // OpenAI sometimes ignores instructions and calls 3 tools at once (e.g. search, dates, plan).
        // If we just process [0] and send the original 'msg' back to history, OpenAI crashes 
        // saying "You didn't reply to tool_calls[1] and [2]".
        // FIX: We create a "Sanitized" version of the message containing ONLY the tool we act on.
        
        const toolCall = msg.tool_calls[0]; // We only process the first one
        const toolName = toolCall.function.name;
        let args = {};
        try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch (e) {}

        logInfo(reqId, `[Tool] ${toolName}`, args);

        // 1. Sanitize History: Create a copy of message that ONLY has this specific tool call
        const assistantMsgSanitized = {
            ...msg,
            tool_calls: [toolCall] 
        };
        const newHistory = [...conversation, assistantMsgSanitized];

        // 2. Execute Logic
        // A. SEARCH -> RECURSE
        if (toolName === "search_google") {
            const result = await performGoogleSearch(args.query, reqId);
            newHistory.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result
            });
            return runConversation(newHistory, depth + 1);
        }

        // B. UI ACTIONS -> RETURN TO FRONTEND (EXIT LOOP)
        if (toolName === "request_dates") {
          return { 
              aiText: "When are you planning to go?", 
              signal: { type: "dateNeeded" }, 
              assistantMessage: assistantMsgSanitized 
          };
        }
        if (toolName === "request_guests") {
          return { 
              aiText: "How many people?", 
              signal: { type: "guestsNeeded" }, 
              assistantMessage: assistantMsgSanitized 
          };
        }

        // C. CREATE PLAN -> RETURN TO FRONTEND (EXIT LOOP)
        if (toolName === "create_plan") {
          const plan = { ...args };
          
          // Data Cleanup
          if (!plan.itinerary) plan.itinerary = [];
          if (!plan.flights) plan.flights = [];
          if (!plan.costBreakdown) plan.costBreakdown = [];
          if (!plan.currency) plan.currency = "USD";
          
          if (!plan.cities) plan.cities = [];
          if (plan.cities.length > 1) plan.multiCity = true;

          // Image
          try {
             const q = plan.multiCity ? plan.cities[0] : plan.location;
             plan.image = await pickPhoto(q, reqId);
          } catch(e) { plan.image = FALLBACK_IMAGE_URL; }

          // Format Dates
          plan.itinerary.forEach(day => {
             day.events.forEach(e => {
                 if(e.provider === "Local Restaurant") e.provider = "Recommended Local Spot";
             });
             if(day.date) {
                 const nice = formatDateToMMMDD(day.date);
                 day.date = nice;
                 day.day = nice; 
             }
          });

          // Cost Breakdown Fallback
          if (plan.costBreakdown.length === 0 && plan.flights.length > 0) {
              plan.costBreakdown.push({
                  item: "Flights",
                  provider: plan.flights[0].airline,
                  price: plan.flights[0].price || 0,
                  iconType: "plane",
                  details: "Round trip"
              });
          }

          return {
            aiText: `I've built a plan for ${plan.location}.`,
            signal: { type: "planReady", payload: plan },
            assistantMessage: assistantMsgSanitized
          };
        }
      }

      // No tool calls -> Standard text response
      return { aiText: msg.content || "" };
    };

    const response = await runConversation(baseHistory);
    return res.json(response);

  } catch (err) {
    logError(reqId, "Route Error", err);
    return res.status(500).json({ aiText: "Server error." });
  }
});

export default router;
