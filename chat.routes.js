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

        preferred_travel_type: [], // ["beach","active","urban","relaxing"]
        travel_alone_or_with: null, // "solo","family","friends"
        desired_experience: [], // ["fun","relaxation","photography","luxury","local culture"]

        flight_preferences: {
          class: null, // "economy","premium_economy","business","first"
        },
        flight_priority: [], // ["price","comfort","duration"]

        accommodation: {
          preferred_type: null, // "hotel","apartment","villa","hostel"
          prefer_view: null, // "sea","mountains","city","doesn't matter"
        },

        budget: {
          prefer_comfort_or_saving: "balanced", // "comfort","saving","balanced"
        },

        preferred_formats: [], // ["cruise","roadtrip","resort","adventure","cultural"]
        liked_activities: [], // ["hiking","wine tasting","museums","shopping","extreme sports"]

        multi_cities: [], // ["Paris","Rome","Athens"]
      },
    });
  }
  return userMem.get(userId);
}

// --- 3. HELPERS -------------------------------------------------------------

// Neutral fallback (no “2025” / fixed width baked in)
const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&q=80";

async function pickPhoto(dest, reqId) {
  const key = (dest || "").toLowerCase().trim();
  if (imageCache.has(key)) return imageCache.get(key);
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
    imageCache.set(key, img);
    return img;
  } catch (e) {
    logError(reqId, "Unsplash error:", e);
    return FALLBACK_IMAGE_URL;
  }
}

const isSocialLink = (text = "") =>
  /(tiktok\.com|youtube\.com|youtu\.be|instagram\.com|fb\.watch|vimeo\.com)/i.test(
    text
  );

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
  if (typeof lastUser.content === "string") text = lastUser.content;
  else if (Array.isArray(lastUser.content)) {
    const t = lastUser.content.find((c) => c.type === "text");
    if (t) text = t.text || "";
  } else if (lastUser.text) text = lastUser.text;

  const lower = text.toLowerCase();
  const profile = mem.profile;

  // origin city
  const fromMatch = lower.match(/from\s+([a-z\s]+)/i);
  if (fromMatch?.[1]) profile.origin_city = fromMatch[1].trim();

  // nationality (rough)
  const natMatch = lower.match(/i am from\s+([a-z\s]+)/i);
  if (natMatch?.[1]) profile.nationality = natMatch[1].trim();

  // travel type
  ["beach", "active", "urban", "relaxing"].forEach((t) => {
    if (lower.includes(t) && !profile.preferred_travel_type.includes(t)) {
      profile.preferred_travel_type.push(t);
    }
  });

  // with whom
  ["solo", "family", "friends"].forEach((t) => {
    if (lower.includes(t)) profile.travel_alone_or_with = t;
  });

  // desired experience
  ["fun", "relaxation", "photography", "luxury", "local culture"].forEach(
    (t) => {
      if (lower.includes(t) && !profile.desired_experience.includes(t)) {
        profile.desired_experience.push(t);
      }
    }
  );

  // flight class
  ["economy", "premium economy", "premium_economy", "business", "first"].forEach(
    (cls) => {
      if (lower.includes(cls.replace("_", " "))) {
        profile.flight_preferences.class = cls;
      }
    }
  );

  // flight priority
  ["price", "comfort", "duration"].forEach((p) => {
    if (lower.includes(p) && !profile.flight_priority.includes(p)) {
      profile.flight_priority.push(p);
    }
  });

  // accommodation type
  ["hotel", "apartment", "villa", "hostel"].forEach((t) => {
    if (lower.includes(t)) profile.accommodation.preferred_type = t;
  });

  // view
  ["sea", "mountains", "city", "doesn't matter", "doesnt matter"].forEach(
    (v) => {
      if (lower.includes(v)) profile.accommodation.prefer_view = v;
    }
  );

  // budget
  ["comfort", "saving", "balanced"].forEach((b) => {
    if (lower.includes(b)) profile.budget.prefer_comfort_or_saving = b;
  });

  // formats
  ["cruise", "roadtrip", "resort", "adventure", "cultural"].forEach((f) => {
    if (lower.includes(f) && !profile.preferred_formats.includes(f))
      profile.preferred_formats.push(f);
  });

  // liked activities
  ["hiking", "wine tasting", "museums", "shopping", "extreme sports"].forEach(
    (a) => {
      if (lower.includes(a) && !profile.liked_activities.includes(a))
        profile.liked_activities.push(a);
    }
  );

  // multi-city
  const cities = extractMultiCities(text);
  if (cities.length > 1) profile.multi_cities = cities;
}

// Date formatting → "DEC 10"
function formatDateToMMMDD(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  return `${month} ${d.getDate()}`;
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
    // Restaurants
    if (startsWith("__restaurants__")) {
      const loc = query.replace("__restaurants__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(
        loc + " best restaurants"
      )}&hl=en&type=search&api_key=${SERPAPI_KEY}`;
      const data = await fetch(url).then((r) => r.json());
      return JSON.stringify(data.local_results?.slice(0, 7) || []);
    }

    // Hotels
    if (startsWith("__hotels__")) {
      const loc = query.replace("__hotels__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(
        loc
      )}&api_key=${SERPAPI_KEY}`;
      const data = await fetch(url).then((r) => r.json());
      return JSON.stringify(data.properties?.slice(0, 7) || []);
    }

    // Activities / POIs
    if (startsWith("__activities__")) {
      const loc = query.replace("__activities__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(
        loc + " things to do"
      )}&hl=en&type=search&api_key=${SERPAPI_KEY}`;
      const data = await fetch(url).then((r) => r.json());
      return JSON.stringify(data.local_results?.slice(0, 10) || []);
    }

    // Flights (prices/options)
    if (startsWith("__flights__")) {
      const cleaned = query.replace("__flights__", "").trim();
      const url = `https://serpapi.com/search.json?engine=google_flights&q=${encodeURIComponent(
        cleaned
      )}&api_key=${SERPAPI_KEY}`;
      const data = await fetch(url).then((r) => r.json());
      return JSON.stringify(data?.flights_results || data || {});
    }

    // Cheapest date hints
    if (startsWith("__cheap_flights__")) {
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

    // Visa requirements
    if (startsWith("__visa__")) {
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

    // Weather info
    if (startsWith("__weather__")) {
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

    // Generic travel/social search
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
      query
    )}&api_key=${SERPAPI_KEY}&num=10`;
    const res = await fetch(url);
    const data = await res.json();

    const out = [];

    if (data.answer_box) out.push(`AnswerBox: ${JSON.stringify(data.answer_box)}`);
    if (data.knowledge_graph)
      out.push(`KnowledgeGraph: ${JSON.stringify(data.knowledge_graph)}`);

    if (data.video_results) {
      const vids = data.video_results.slice(0, 3).map((v) => {
        return `VIDEO: ${v.title} (${v.link}) — ${v.snippet || "no snippet"}`;
      });
      out.push(vids.join("\n"));
    }

    if (data.flights_results) {
      out.push(
        "FlightsSummary: " +
          JSON.stringify(data.flights_results.slice(0, 5) || [])
      );
    }

    if (data.local_results) {
      out.push(
        "Local: " + JSON.stringify(data.local_results.slice(0, 8) || [])
      );
    }

    if (data.organic_results) {
      data.organic_results.slice(0, 8).forEach((r) => {
        out.push(`Organic: ${r.title}: ${r.snippet || ""}`);
      });
    }

    return out.join("\n") || "No details found.";
  } catch (err) {
    logError(reqId, "SerpAPI Error", err);
    return "Search failed.";
  }
}

// --- 5. TOOLS ---------------------------------------------------------------

const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description:
        "Trigger the app's date picker. NEVER ask dates in plain text, always call this tool.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description:
        "Trigger the app's guest picker. NEVER ask guest counts in plain text, always call this tool.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description:
        "Search the web via SerpAPI for flights, hotels, restaurants, activities, visa rules, weather, and also to interpret social links (YouTube/TikTok/etc).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A plain search query or a special marker query like '__restaurants__ Paris', '__hotels__ Bali', '__activities__ Rome', '__flights__ Helsinki to Paris Jun 1-7', '__cheap_flights__ Helsinki to Tokyo', '__visa__ Finnish citizens to Japan', '__weather__ Bali in August'.",
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
        "Finalize a JSON trip plan, using realistic data discovered via search_google. The client app will render this in a plan card & trip details screen.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string" },
          description: { type: "string" },
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
                date: {
                  type: "string",
                  description:
                    "Trip date in ISO-like format (e.g. '2025-12-10'). Backend will convert and display as 'DEC 10'. Do NOT write weekday names here.",
                },
                day: {
                  type: "string",
                  description:
                    "Short label for the day. Use the same date-like value as 'date' (e.g. '2025-12-10'); server will format it as 'DEC 10'. Do NOT use 'Monday' / 'December 10'.",
                },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        enum: ["activity", "food", "travel", "stay"],
                      },
                      icon: { type: "string" },
                      time: {
                        type: "string",
                        description:
                          "Local start time in 24h format like '09:00', '13:30', etc. Every event MUST have a realistic time.",
                      },
                      duration: {
                        type: "string",
                        description:
                          "Approximate duration like '2h', '3.5h', 'All day'.",
                      },
                      title: { type: "string" },
                      details: { type: "string" },
                      provider: {
                        type: "string",
                        description:
                          "Real-world place or company name (hotel, restaurant, tour, airline). NO generic placeholders.",
                      },
                      approxPrice: { type: "number" },
                    },
                    required: ["type", "title", "details"],
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
          cities: {
            type: "array",
            items: { type: "string" },
          },
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
You are an advanced **AI TRAVEL AGENT** inside a mobile chat app.

You DO NOT control the UI directly. Instead, you:
- Use tools \`request_dates\` and \`request_guests\` for dates/guests.
- Use \`search_google\` for real-world data (flights, restaurants, hotels, attractions, visa, weather, social links).
- Use \`create_plan\` only when you are ready to finalize a trip.

Known user profile:
- Origin city: ${profile.origin_city || "unknown"}
- Nationality: ${profile.nationality || "unknown"}
- Preferred travel type: ${profile.preferred_travel_type.join(", ") || "unknown"}
- Travel with: ${profile.travel_alone_or_with || "unknown"}
- Desired experience: ${profile.desired_experience.join(", ") || "unknown"}
- Flight class: ${profile.flight_preferences.class || "unknown"}
- Flight priority: ${profile.flight_priority.join(", ") || "unknown"}
- Accommodation type: ${profile.accommodation.preferred_type || "unknown"}, view: ${
  profile.accommodation.prefer_view || "unknown"
}
- Budget preference: ${profile.budget.prefer_comfort_or_saving}
- Preferred formats: ${profile.preferred_formats.join(", ") || "unknown"}
- Liked activities: ${profile.liked_activities.join(", ") || "unknown"}
- Multi-city intent: ${profile.multi_cities.join(" → ") || "none"}

CONVERSATION STYLE (VERY IMPORTANT):
- Think in **WhatsApp-sized messages**.
- Do NOT dump huge walls of text. Prefer 1–3 short paragraphs max, or a few bullet points.
- Ask **one follow-up question at a time**.
- Only when finalizing a plan (via \`create_plan\`) should you pack lots of detail into the structured JSON.
- The app itself will show the full plan UI; you only need to verbally summarize key points.

DATES & GUESTS (TOOL USAGE IS MANDATORY):
- NEVER ask for dates in plain text. Always call \`request_dates\`.
- NEVER ask for guest counts in plain text. Always call \`request_guests\`.
- As soon as you have a clear idea of the destination and rough trip idea, **trigger \`request_dates\` and \`request_guests\`** before finalizing anything.

PREFERENCES:
If missing, ask short, crisp questions like:
- "Where are you flying from?"
- "Do you prefer beach, active, urban or relaxing trips?"
- "Solo, with family, or with friends?"
- "More important for flights: price, comfort or duration?"
- "Hotel, apartment, villa or hostel?"
- "Sea view, mountains, city view, or doesn't matter?"
- "Comfort, saving or balanced budget?"
- "What kind of vibe: fun, relaxation, photography, luxury, local culture?"
- "Any activities you love? (hiking, museums, shopping, wine tasting, extreme sports...)"

SOCIAL LINKS (YouTube/TikTok/Instagram/etc):
- If the user shares a link, do NOT say "I can't open links".
- Call \`search_google\` with the link as the query.
- Use video_results/local_results/organic_results to infer:
  - Location (city/country),
  - Type of place (beach club, hike, café, etc.),
  - Approximate vibe & cost.
- Suggest a trip inspired by that content.

REAL, GROUNDED ITINERARIES (NO GENERIC FILLER):
For the main destination or each city in a multi-city trip:
- Call \`search_google\` with markers:
  - "__restaurants__ CITY"
  - "__hotels__ CITY"
  - "__activities__ CITY"
- Use those JSON search results to fill \`itinerary.events\` with **real places**:
  - Real names for restaurants, attractions, hotels (put these in \`provider\` and/or \`title\`).
  - Use \`approxPrice\` where possible.
- **Never** invent placeholder names like "Nice Hotel", "Popular Restaurant", "City Walking Tour".
- Every event should:
  - Have a realistic **time** in 24h format, e.g. "09:00", "14:30", "19:30".
  - Have a **duration**, e.g. "2h", "3.5h", "All day".
  - Be ordered in chronological order within the day (morning → afternoon → evening).

ITINERARY DATES & DAY LABELS:
- When you call \`create_plan\`, set \`itinerary[i].date\` and \`itinerary[i].day\` both to **ISO-like dates** like "2025-12-10".
- The server will convert these to "DEC 10" for display.
- Do **NOT** put weekday names like "Monday", and do **NOT** write "December 10".
- All human-facing day formatting will be handled by the backend (format "DEC 10").

FLIGHTS & CHEAPER DATES:
If origin & destination are known:
- Before or during date picking:
  - Call \`search_google\` with "__cheap_flights__ ORIGIN to DESTINATION"
  - Mention cheaper periods briefly if found.
- When dates and routes are known:
  - Call \`search_google\` with "__flights__ ORIGIN to DESTINATION <date info>"
  - Turn the results into realistic flight options in \`flights\` + \`costBreakdown\`.

VISA REQUIREMENTS:
If nationality and destination country are known:
- Call \`search_google\` with "__visa__ <nationality> to <country>".
- Summarize in about 1–3 sentences and put it into \`visa\` and/or \`description\`.
- Make it clear it's not legal advice, just an overview.

WEATHER & ALTERNATIVES:
If dates/destination are known or strongly implied:
- Call \`search_google\` with "__weather__ <city> in <month or season>".
- If weather is very bad or extreme, propose 1–2 alternative destinations with better conditions and add them under \`alternatives\`.

MULTI-CITY TRIPS:
If the user mentions multiple cities (e.g., "Paris, Rome and Athens"):
- Treat as a multi-city trip (\`multiCity = true\`).
- Fill \`cities\` in \`create_plan\`.
- For each city, include at least one day in \`itinerary\` with:
  - city name in \`day\` label or event titles,
  - real hotel and activities,
  - travel events between cities if appropriate.

USING \`create_plan\`:
- Only call \`create_plan\` once you have enough info for a realistic plan.
- Make sure \`itinerary\` uses ISO-like dates ("2025-12-10") for both \`date\` and \`day\`; backend will format to "DEC 10".
- Use real names from \`search_google\`, not placeholders.
`;

// --- 7. NORMALIZE MESSAGES FOR OPENAI ---------------------------------------

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

      // Vision-style input: array of text + image_url objects
      if (m.role === "user" && Array.isArray(m.content)) {
        return { role: "user", content: m.content };
      }

      let role = m.role;
      if (role === "ai") role = "assistant";
      if (role === "plan") role = "assistant";

      let content = m.content || m.text || "";
      if (role === "assistant" && m.payload) {
        content = "[Previous trip plan card shown to user]";
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

    if (!hasKey || !client) {
      return res.json({
        aiText: "The travel assistant is temporarily unavailable (no API key).",
      });
    }

    const systemPrompt = getSystemPrompt(mem.profile);
    const baseHistory = [
      { role: "system", content: systemPrompt },
      ...normalizeMessages(messages),
    ];

    const runConversation = async (conversation, depth = 0) => {
      if (depth > 8) {
        return {
          aiText:
            "I'm having trouble finalizing your trip after several steps. Please try simplifying your request.",
        };
      }

      let completion;
      try {
        completion = await client.chat.completions.create({
          model: "gpt-4o",
          messages: conversation,
          tools,
          tool_choice: "auto",
          temperature: 0.25,
        });
      } catch (err) {
        logError(reqId, "[OpenAI ERROR]", err);
        return {
          aiText: "I'm having trouble contacting the planning engine right now.",
        };
      }

      const msg = completion.choices[0]?.message;
      if (!msg) return { aiText: "No response from planning engine." };

      // --- TOOL CALLS HANDLING (MULTI-TOOL SAFE) ---------------------------
      if (msg.tool_calls?.length) {
        let newHistory = [...conversation, msg];

        for (const toolCall of msg.tool_calls) {
          const toolName = toolCall.function.name;
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments || "{}");
          } catch (e) {
            logError(reqId, "[Tool args parse error]", e);
          }

          logInfo(reqId, `[Tool] ${toolName}`, args);

          // search_google: we perform it here & add tool messages
          if (toolName === "search_google") {
            const toolResult = await performGoogleSearch(args.query, reqId);
            newHistory.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResult,
            });
            continue;
          }

          // UI triggers: return immediately (no further OpenAI calls with this msg)
          if (toolName === "request_dates") {
            return {
              aiText: "Please choose your travel dates.",
              signal: { type: "dateNeeded" },
              assistantMessage: msg,
            };
          }

          if (toolName === "request_guests") {
            return {
              aiText: "How many people are traveling?",
              signal: { type: "guestsNeeded" },
              assistantMessage: msg,
            };
          }

          if (toolName === "create_plan") {
            // Finalize plan for frontend
            const planArgs = { ...args };

            // set multiCity defaults
            planArgs.multiCity =
              typeof planArgs.multiCity === "boolean"
                ? planArgs.multiCity
                : Array.isArray(planArgs.cities) && planArgs.cities.length > 1;

            if (!Array.isArray(planArgs.cities) || planArgs.cities.length === 0) {
              if (
                Array.isArray(mem.profile.multi_cities) &&
                mem.profile.multi_cities.length > 1
              ) {
                planArgs.cities = mem.profile.multi_cities;
                planArgs.multiCity = true;
              } else {
                planArgs.cities = [];
              }
            }

            if (!Array.isArray(planArgs.itinerary)) planArgs.itinerary = [];
            if (!Array.isArray(planArgs.costBreakdown))
              planArgs.costBreakdown = [];
            if (!Array.isArray(planArgs.flights)) planArgs.flights = [];
            if (!Array.isArray(planArgs.alternatives))
              planArgs.alternatives = [];

            if (!planArgs.weather) {
              planArgs.weather = { temp: 24, icon: "sunny" };
            }

            if (!planArgs.currency) {
              planArgs.currency = "USD";
            }

            // Ensure times & durations exist and normalize date/day → "DEC 10"
            for (const day of planArgs.itinerary) {
              // Normalize original date/day to display format
              if (day.date) {
                const formatted = formatDateToMMMDD(day.date);
                day.date = formatted;
                day.day = formatted; // keep `day` in "DEC 10" format too
              } else if (day.day) {
                // fallback: try to format whatever is in `day`
                day.day = formatDateToMMMDD(day.day);
                day.date = day.day;
              }

              if (Array.isArray(day.events)) {
                // Very simple, deterministic fallback schedule if missing times:
                // 1st event: 09:00, 2nd: 13:00, 3rd: 18:00, others stay as-is.
                const defaultSlots = ["09:00", "13:00", "18:00", "21:00"];
                day.events.forEach((ev, idx) => {
                  if (!ev.time || typeof ev.time !== "string" || !ev.time.trim()) {
                    ev.time = defaultSlots[idx] || "10:00";
                  }
                  if (
                    !ev.duration ||
                    typeof ev.duration !== "string" ||
                    !ev.duration.trim()
                  ) {
                    ev.duration = "2h";
                  }
                });
              }
            }

            // Attach image
            try {
              const primaryLoc =
                planArgs.multiCity && planArgs.cities.length > 0
                  ? planArgs.cities[0]
                  : planArgs.location;
              planArgs.image = await pickPhoto(primaryLoc || "travel", reqId);
            } catch (e) {
              planArgs.image = FALLBACK_IMAGE_URL;
            }

            // Price fallback
            if (
              typeof planArgs.price !== "number" ||
              Number.isNaN(planArgs.price)
            ) {
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

          // Unknown tool (shouldn't happen)
          logError(reqId, "[Unknown tool]", toolName);
          return {
            aiText: "I tried to use a tool I don't recognize.",
          };
        }

        // If we are here, all tool_calls were search_google calls and have responses;
        // now we can safely recurse with newHistory.
        return runConversation(newHistory, depth + 1);
      }

      // NO TOOL CALLS → plain assistant message
      return { aiText: msg.content };
    };

    const response = await runConversation(baseHistory);
    return res.json(response);
  } catch (err) {
    logError(reqId, "[ROUTE ERROR]", err);
    return res.status(500).json({
      aiText: "A server error occurred while planning the trip.",
    });
  }
});

export default router;
