// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// --- 0. GLOBAL SAFETY / FETCH POLYFILL --------------------------------------
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

// --- 2. IN-MEMORY USER PROFILE ----------------------------------------------
/**
 * We keep things in RAM; if you want persistence, swap this for Redis/DB.
 */
const userMem = new Map();
const imageCache = new Map();

function getMem(userId) {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        origin_city: null,
        nationality: null,

        preferred_travel_type: [], // ["beach","active","urban","relaxing"]
        travel_alone_or_with: null, // "solo","family","friends"
        desired_experience: [], // ["fun", "relaxation", "photography", "luxury", "local culture"]

        flight_preferences: {
          class: null, // "economy","premium_economy","business","first"
        },
        flight_priority: [], // ["price","comfort","duration"]

        accommodation: {
          preferred_type: null, // "hotel","apartment","villa","hostel"
          prefer_view: null, // "sea","mountains","city","doesn't matter"
        },

        budget: { prefer_comfort_or_saving: "balanced" }, // "comfort","saving","balanced"

        preferred_formats: [], // ["cruise","roadtrip","resort","adventure","cultural"]
        liked_activities: [], // ["hiking","wine tasting","museums","shopping","extreme sports"]

        multi_cities: [], // ["Paris","Rome","Athens"]
      },
    });
  }
  return userMem.get(userId);
}

// --- 3. SIMPLE HELPERS ------------------------------------------------------

const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?q=80&w=1442&auto=format&fit=crop";

async function pickPhoto(dest, reqId) {
  const cacheKey = (dest || "").toLowerCase().trim();
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
  if (!UNSPLASH_ACCESS_KEY) return FALLBACK_IMAGE_URL;

  const query = encodeURIComponent(`${dest} travel landmark`);
  const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
    if (!res.ok) return FALLBACK_IMAGE_URL;
    const data = await res.json();
    const img = data?.results?.[0]?.urls?.regular || FALLBACK_IMAGE_URL;
    imageCache.set(cacheKey, img);
    return img;
  } catch (e) {
    logError(reqId, "Unsplash error", e?.message || e);
    return FALLBACK_IMAGE_URL;
  }
}

const isSocialLink = (text = "") =>
  /(tiktok\.com|youtube\.com|youtu\.be|instagram\.com|fb\.watch|vimeo\.com)/i.test(
    text
  );

const extractMultiCities = (text = "") => {
  const segments = text
    .split(/to|->|→|,|then|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  // If there's more than one plausible city string, treat as multi-city intent
  return segments.length > 1 ? segments : [];
};

// Parse user text & update memory
function updateProfileFromHistory(messages, mem) {
  const lastUser = messages.filter((m) => m.role === "user").pop();
  if (!lastUser) return;

  let text = "";
  if (typeof lastUser.content === "string") text = lastUser.content;
  else if (Array.isArray(lastUser.content)) {
    const textPart = lastUser.content.find((c) => c.type === "text");
    if (textPart) text = textPart.text || "";
  } else if (lastUser.text) text = lastUser.text;

  const lower = text.toLowerCase();
  const p = mem.profile;

  // origin city
  const fromMatch = lower.match(/from\s+([a-z\s]+)/i);
  if (fromMatch?.[1]) p.origin_city = fromMatch[1].trim();

  // nationality (very rough)
  const natMatch = lower.match(/i am from\s+([a-z\s]+)/i);
  if (natMatch?.[1]) p.nationality = natMatch[1].trim();

  // travel type
  ["beach", "active", "urban", "relaxing"].forEach((t) => {
    if (lower.includes(t) && !p.preferred_travel_type.includes(t)) {
      p.preferred_travel_type.push(t);
    }
  });

  // travel with
  ["solo", "family", "friends"].forEach((t) => {
    if (lower.includes(t)) p.travel_alone_or_with = t;
  });

  // desired experience
  ["fun", "relaxation", "photography", "luxury", "local culture"].forEach(
    (t) => {
      if (lower.includes(t) && !p.desired_experience.includes(t)) {
        p.desired_experience.push(t);
      }
    }
  );

  // flight class
  [
    "economy",
    "premium economy",
    "premium_economy",
    "business",
    "first",
  ].forEach((cls) => {
    if (lower.includes(cls.replace("_", " "))) {
      p.flight_preferences.class = cls;
    }
  });

  // flight priority
  ["price", "comfort", "duration"].forEach((f) => {
    if (lower.includes(f) && !p.flight_priority.includes(f)) {
      p.flight_priority.push(f);
    }
  });

  // accommodation type
  ["hotel", "apartment", "villa", "hostel"].forEach((t) => {
    if (lower.includes(t)) p.accommodation.preferred_type = t;
  });

  // view
  ["sea", "mountains", "city", "doesn't matter", "doesnt matter"].forEach(
    (v) => {
      if (lower.includes(v)) p.accommodation.prefer_view = v;
    }
  );

  // budget preference
  ["comfort", "saving", "balanced"].forEach((b) => {
    if (lower.includes(b)) p.budget.prefer_comfort_or_saving = b;
  });

  // formats
  ["cruise", "roadtrip", "resort", "adventure", "cultural"].forEach((f) => {
    if (lower.includes(f) && !p.preferred_formats.includes(f)) {
      p.preferred_formats.push(f);
    }
  });

  // liked activities
  ["hiking", "wine tasting", "museums", "shopping", "extreme sports"].forEach(
    (a) => {
      if (lower.includes(a) && !p.liked_activities.includes(a)) {
        p.liked_activities.push(a);
      }
    }
  );

  // multi-city
  const cities = extractMultiCities(text);
  if (cities.length > 1) p.multi_cities = cities;
}

// --- 4. SEARCH / SERPAPI INTEGRATION ----------------------------------------

async function performGoogleSearch(rawQuery, reqId) {
  if (!SERPAPI_KEY) {
    logInfo(reqId, "[SEARCH] No SERPAPI_KEY, returning stub for:", rawQuery);
    return `Search skipped (no SERPAPI_KEY). Query was: ${rawQuery}`;
  }

  const query = rawQuery || "";
  logInfo(reqId, `[SEARCH] "${query}"`);

  // SPECIAL MARKERS: restaurants, hotels, activities, flights, visa, weather
  const specialPrefix = (marker) => query.startsWith(marker);

  try {
    // --- RESTAURANTS ---
    if (specialPrefix("__restaurants__")) {
      const loc = query.replace("__restaurants__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(
        loc + " best restaurants"
      )}&hl=en&type=search&api_key=${SERPAPI_KEY}`;

      const data = await fetch(url).then((r) => r.json());
      return JSON.stringify(data.local_results?.slice(0, 7) || []);
    }

    // --- HOTELS ---
    if (specialPrefix("__hotels__")) {
      const loc = query.replace("__hotels__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(
        loc
      )}&api_key=${SERPAPI_KEY}`;

      const data = await fetch(url).then((r) => r.json());
      return JSON.stringify(data.properties?.slice(0, 7) || []);
    }

    // --- ACTIVITIES / THINGS TO DO ---
    if (specialPrefix("__activities__")) {
      const loc = query.replace("__activities__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(
        loc + " things to do"
      )}&hl=en&type=search&api_key=${SERPAPI_KEY}`;

      const data = await fetch(url).then((r) => r.json());
      return JSON.stringify(data.local_results?.slice(0, 10) || []);
    }

    // --- FLIGHT PRICES & OPTIONS ---
    if (specialPrefix("__flights__")) {
      // expected pattern: "__flights__ <origin> to <destination> <dates text>"
      const cleaned = query.replace("__flights__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_flights&q=${encodeURIComponent(
        cleaned
      )}&api_key=${SERPAPI_KEY}`;

      const data = await fetch(url).then((r) => r.json());
      // We'll return flights_results as JSON for the model to parse
      return JSON.stringify(data?.flights_results || data || {});
    }

    // --- CHEAP FLIGHT DATES ---
    if (specialPrefix("__cheap_flights__")) {
      const cleaned = query.replace("__cheap_flights__", "").trim();
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
        cleaned + " cheapest month to fly"
      )}&api_key=${SERPAPI_KEY}`;

      const data = await fetch(url).then((r) => r.json());
      const organic =
        data.organic_results?.find((o) =>
          /cheap|cheapest|low fare|low price|affordable/i.test(o.title || "")
        ) || data.organic_results?.[0];

      return organic?.snippet || "No cheaper date info found.";
    }

    // --- VISA REQUIREMENTS ---
    if (specialPrefix("__visa__")) {
      const cleaned = query.replace("__visa__", "").trim();
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
        cleaned + " visa requirements official"
      )}&api_key=${SERPAPI_KEY}`;

      const data = await fetch(url).then((r) => r.json());
      const organic = data.organic_results?.slice(0, 5) || [];
      return organic
        .map((o) => `${o.title}: ${o.snippet || ""}`)
        .join("\n");
    }

    // --- WEATHER & ALTERNATIVES ---
    if (specialPrefix("__weather__")) {
      const cleaned = query.replace("__weather__", "").trim();
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
        cleaned + " average weather"
      )}&api_key=${SERPAPI_KEY}`;

      const data = await fetch(url).then((r) => r.json());
      const organic = data.organic_results?.slice(0, 5) || [];
      return organic
        .map((o) => `${o.title}: ${o.snippet || ""}`)
        .join("\n");
    }

    // --- SOCIAL / VIDEO LINKS & GENERIC TRAVEL SEARCH -----------------------
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
      query
    )}&api_key=${SERPAPI_KEY}&num=10`;
    const res = await fetch(url);
    const data = await res.json();

    const snippets = [];

    if (data.answer_box) snippets.push(`AnswerBox: ${JSON.stringify(data.answer_box)}`);
    if (data.knowledge_graph)
      snippets.push(`KnowledgeGraph: ${JSON.stringify(data.knowledge_graph)}`);

    if (data.video_results) {
      const vids = data.video_results
        .slice(0, 3)
        .map(
          (v) =>
            `VIDEO: ${v.title} (${v.link}) — ${v.snippet || "no snippet"}`
        );
      snippets.push(vids.join("\n"));
    }

    if (data.flights_results) {
      snippets.push(
        "FlightsSummary: " +
          JSON.stringify(data.flights_results.slice(0, 5) || [])
      );
    }

    if (data.local_results) {
      snippets.push(
        "Local: " + JSON.stringify(data.local_results.slice(0, 8) || [])
      );
    }

    if (data.organic_results) {
      data.organic_results.slice(0, 8).forEach((r) => {
        snippets.push(`Organic: ${r.title}: ${r.snippet || ""}`);
      });
    }

    return snippets.join("\n") || "No details found.";
  } catch (e) {
    logError(reqId, "SerpApi Error", e);
    return "Search failed.";
  }
}

// --- 5. TOOLS DEFINITION ----------------------------------------------------

const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description:
        "Trigger a UI flow that lets the user pick start/end dates. Do not ask for dates via plain text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description:
        "Trigger a UI flow that lets the user set guests (adults, children). Do not ask via plain text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description:
        "Search the web for travel info, social links, prices, flights, visa, weather, hotels, restaurants, and activities. Accepts raw user URL (YouTube, TikTok, etc.) too.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query or special marker query like '__restaurants__ Paris', '__hotels__ Bali', '__activities__ Rome', '__flights__ Helsinki to Paris Jun 1-7', '__cheap_flights__ Helsinki to Tokyo', '__visa__ Finnish citizens to Japan', '__weather__ Bali in August'.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Finalize the travel plan JSON: use all previous search results and preferences to build a realistic, bookable trip (including multi-city if requested).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the trip." },
          location: {
            type: "string",
            description: "Main destination, or starting city of the trip.",
          },
          country: { type: "string" },
          multiCity: { type: "boolean", description: "True if multi-city trip." },
          cities: {
            type: "array",
            items: { type: "string" },
            description: "List of cities in order, for multi-city trips.",
          },
          dateRange: {
            type: "string",
            description: "Human-readable date range like '2025-06-01 to 2025-06-10'.",
          },
          description: {
            type: "string",
            description:
              "High level description that matches the user's preferences & vibe.",
          },
          price: {
            type: "number",
            description: "Total estimated price for the trip.",
          },
          currency: {
            type: "string",
            description: "Currency code like 'USD', 'EUR', etc.",
          },
          weather: {
            type: "object",
            properties: {
              temp: { type: "number" },
              icon: { type: "string" },
              summary: { type: "string" },
            },
          },
          visa: {
            type: "string",
            description:
              "Concise summary of visa requirements for the user, if relevant.",
          },
          flights: {
            type: "array",
            items: {
              type: "object",
              properties: {
                route: { type: "string" },
                airline: { type: "string" },
                flightNumber: { type: "string" },
                departTime: { type: "string" },
                arriveTime: { type: "string" },
                cabinClass: { type: "string" },
                price: { type: "number" },
              },
            },
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                city: { type: "string" },
                date: { type: "string" },
                dayLabel: { type: "string" },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        enum: ["activity", "food", "travel", "stay"],
                      },
                      time: { type: "string" },
                      title: { type: "string" },
                      details: { type: "string" },
                      providerName: { type: "string" },
                      approxPrice: { type: "number" },
                    },
                  },
                },
                hotel: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    address: { type: "string" },
                    pricePerNight: { type: "number" },
                    totalNights: { type: "number" },
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
        required: ["location", "description", "price"],
      },
    },
  },
];

// --- 6. SYSTEM PROMPT -------------------------------------------------------

const getSystemPrompt = (profile) => `
You are a **world-class AI TRAVEL AGENT** that works inside a mobile chat app.

You DO NOT control the UI directly. Instead you:
- Use tools to ask for dates and guests.
- Use search_google for real-world data.
- Use create_plan ONLY when you're ready to finalize a trip.

You remember and use these preferences:
- Origin city: ${profile.origin_city || "unknown"}
- Nationality: ${profile.nationality || "unknown"}
- Preferred travel type: ${profile.preferred_travel_type.join(", ") || "unknown"}
- Travel with: ${profile.travel_alone_or_with || "unknown"}
- Desired experience: ${
  profile.desired_experience.join(", ") || "unknown"
}
- Flight class: ${profile.flight_preferences.class || "unknown"}
- Flight priority: ${profile.flight_priority.join(", ") || "unknown"}
- Accommodation type: ${
  profile.accommodation.preferred_type || "unknown"
}, view: ${profile.accommodation.prefer_view || "unknown"}
- Budget preference: ${profile.budget.prefer_comfort_or_saving}
- Preferred formats: ${profile.preferred_formats.join(", ") || "unknown"}
- Liked activities: ${profile.liked_activities.join(", ") || "unknown"}
- Multi-city intent: ${profile.multi_cities.join(" → ") || "none"}

BEHAVIOR:
1. **If key preferences are missing**, ask short, relevant follow-ups:
   - "Where are you flying from?"
   - "Do you prefer beach, active, urban or relaxing trips?"
   - "Solo, with family, or friends?"
   - "Do you care more about price, comfort or duration for flights?"
   - "Hotel, apartment, villa, or hostel?"
   - "Sea, mountains, city view or doesn't matter?"
   - "Comfort, saving, or balanced budget?"
   - "What kind of experiences you prefer (fun, relaxation, photography, luxury, local culture)?"
   - "Any specific activities you love (hiking, museums, shopping, etc.)?"

   BUT: never ask for travel dates or guest counts using plain text — use tools instead.

2. **SOCIAL LINKS (YouTube/TikTok/Instagram/etc)**:
   - If user sends a link or mentions a short video, DO NOT say "I can't open links".
   - Call search_google with the full URL (or related keywords).
   - Use video_results, local_results, etc. to infer:
     - Location / city / country
     - Type of experience (beach club, hike, rooftop bar, etc.)
   - Then propose a trip inspired by that content.

3. **REAL-WORLD ITINERARY**:
   - For each city:
     - Call search_google with "__restaurants__ CITY" to get real restaurants (JSON).
     - Call "__hotels__ CITY" to get real hotels (JSON).
     - Call "__activities__ CITY" to get top attractions/things-to-do (JSON).
   - Parse those JSON responses and pick actual names, descriptions, and approximate prices.
   - Build an itinerary with:
     - Morning activity, lunch spot, afternoon activity, dinner, and optional evening.
     - Real hotel(s) by name and approximate nightly price.

4. **FLIGHT PRICES & CHEAPER DATES**:
   - Before or while requesting dates, if you know origin & destination:
     - Call search_google("__cheap_flights__ ORIGIN to DESTINATION") to see if some months are cheaper.
     - Briefly mention cheaper periods if they exist.
   - For confirmed dates/routes:
     - Call search_google("__flights__ ORIGIN to DESTINATION <date info>") and extract realistic flight options (airline, cabin, approx price).

5. **VISA REQUIREMENTS**:
   - If nationality and destination country are known:
     - Call search_google("__visa__ <nationality> to <destination country>").
     - Summarize in 1–3 lines (no legal guarantees, just an overview).

6. **WEATHER & ALTERNATIVES**:
   - For planned dates & destination:
     - Call search_google("__weather__ <city> in <month>").
     - If weather is poor or extreme, suggest alternative destinations with better weather (and briefly explain why).

7. **MULTI-CITY TRIPS**:
   - If user mentions multiple cities (e.g. "Paris, Rome, Athens"):
     - Treat it as multiCity: true and fill cities[].
     - Build a leg-by-leg itinerary and flights between them.
     - Each city must have its own hotel & activities.

8. **TOOLS USAGE**:
   - NEVER ask for dates or guests directly. Always call request_dates and request_guests.
   - Use search_google liberally for:
     - Hotels, restaurants, activities, flights, weather, visa, social links.
   - Call create_plan ONLY once you have enough info for a useful plan.
`;

// --- 7. NORMALIZING MESSAGES FOR OPENAI ------------------------------------

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

      // Support vision style: array of {type:"text"| "image_url"}
      if (m.role === "user" && Array.isArray(m.content)) {
        return { role: "user", content: m.content };
      }

      let role = m.role;
      if (role === "ai") role = "assistant";
      if (role === "plan") role = "assistant";

      let content = m.content || m.text || "";
      if (role === "assistant" && m.payload) {
        // previous UI plan snapshots: compress them
        content = "[Previous plan card was shown to user]";
      }

      return { role, content: String(content) };
    });
}

// --- 8. MAIN /travel ROUTE --------------------------------------------------

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey) {
      return res.json({
        aiText: "The travel assistant is temporarily unavailable (missing API key).",
      });
    }

    const systemPrompt = getSystemPrompt(mem.profile);
    const history = [
      { role: "system", content: systemPrompt },
      ...normalizeMessages(messages),
    ];

    const runConversation = async (convHistory, depth = 0) => {
      if (depth > 8) {
        return {
          aiText:
            "I'm having trouble finalizing your trip after several attempts. Please try refining your request.",
        };
      }

      let completion;
      try {
        completion = await client.chat.completions.create({
          model: "gpt-4o",
          messages: convHistory,
          tools,
          tool_choice: "auto",
          temperature: 0.25,
        });
      } catch (err) {
        logError(reqId, "[OpenAI ERROR]", err);
        return { aiText: "I'm having trouble connecting to the planning engine." };
      }

      const msg = completion.choices[0]?.message;
      if (!msg) return { aiText: "No response from planning engine." };

      // --- HANDLE TOOL CALLS -------------------------------------------------
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCall = msg.tool_calls[0];
        const toolName = toolCall.function.name;
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch (e) {
          logError(reqId, "[Tool args JSON error]", e);
        }

        logInfo(reqId, `[Tool] ${toolName}`, args);

        // 1) search_google: we do it here, append result as tool message, recurse
        if (toolName === "search_google") {
          const toolResult = await performGoogleSearch(args.query, reqId);
          const newHistory = [
            ...convHistory,
            msg,
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResult,
            },
          ];
          return runConversation(newHistory, depth + 1);
        }

        // 2) request_dates: signal to frontend to open date picker
        if (toolName === "request_dates") {
          return {
            aiText: "Please choose your travel dates.",
            signal: { type: "dateNeeded" },
            assistantMessage: msg,
          };
        }

        // 3) request_guests: signal to frontend to open guest picker
        if (toolName === "request_guests") {
          return {
            aiText: "How many people are traveling?",
            signal: { type: "guestsNeeded" },
            assistantMessage: msg,
          };
        }

        // 4) create_plan: finalize payload for UI plan card
        if (toolName === "create_plan") {
          const planArgs = { ...args };

          // Fallbacks & enrichment
          planArgs.multiCity = !!planArgs.multiCity;
          if (!Array.isArray(planArgs.cities)) planArgs.cities = [];
          if (!Array.isArray(planArgs.itinerary)) planArgs.itinerary = [];
          if (!Array.isArray(planArgs.flights)) planArgs.flights = [];
          if (!Array.isArray(planArgs.costBreakdown)) planArgs.costBreakdown = [];
          if (!Array.isArray(planArgs.alternatives)) planArgs.alternatives = [];

          if (!planArgs.weather) {
            planArgs.weather = {
              temp: 24,
              icon: "sunny",
              summary: "Mild and pleasant.",
            };
          }

          if (!planArgs.currency) {
            planArgs.currency = "USD";
          }

          // Attach photo
          try {
            const primaryLocation =
              planArgs.multiCity && planArgs.cities.length > 0
                ? planArgs.cities[0]
                : planArgs.location;
            planArgs.image = await pickPhoto(primaryLocation || "travel", reqId);
          } catch (e) {
            planArgs.image = FALLBACK_IMAGE_URL;
          }

          // price fallback
          if (typeof planArgs.price !== "number" || Number.isNaN(planArgs.price)) {
            planArgs.price = 0;
          }

          const mainLocation =
            planArgs.multiCity && planArgs.cities.length > 0
              ? planArgs.cities.join(" → ")
              : planArgs.location;

          return {
            aiText: `I've prepared a trip plan for ${mainLocation}.`,
            signal: { type: "planReady", payload: planArgs },
            assistantMessage: msg,
          };
        }

        // Unknown tool: return safe fallback
        logError(reqId, "Unknown tool called:", toolName);
        return { aiText: "I tried to use a tool I don't recognize." };
      }

      // --- NO TOOL CALLS → Just normal text content -------------------------
      return { aiText: msg.content };
    };

    const response = await runConversation(history);
    return res.json(response);
  } catch (err) {
    logError(reqId, "[ROUTE ERROR]", err);
    return res.status(500).json({ aiText: "System error while planning trip." });
  }
});

export default router;
