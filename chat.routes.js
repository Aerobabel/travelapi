// server/chat.routes.js
import Amadeus from "amadeus";
import dotenv from "dotenv";
import { Router } from "express";
import OpenAI from "openai";

dotenv.config();

// --- 0. GLOBAL SAFETY & FETCH POLYFILL --------------------------------------
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED PROMISE REJECTION]", reason);
});

let FETCH_SOURCE = "native";
try {
  if (typeof globalThis.fetch !== "function") {
    // ESM top-level await is allowed
    const nodeFetch = (await import("node-fetch")).default;
    globalThis.fetch = nodeFetch;
    FETCH_SOURCE = "node-fetch";
  }
} catch (e) {
  console.error("[chat] fetch polyfill error:", e?.message);
}

const router = Router();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Amadeus client
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  hostname: process.env.AMADEUS_HOSTNAME || 'production',
});

const SERPAPI_KEY = process.env.SERPAPI_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

const newReqId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (id, ...args) => console.log(`[chat][${id}]`, ...args);
const logError = (id, ...args) => console.error(`[chat][${id}]`, ...args);

// --- 1. IN-MEMORY PROFILE/MEMORY -------------------------------------------
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

// --- 2. HELPERS -------------------------------------------------------------

const getCode = (label) => {
  if (!label) return null;
  const s = String(label).trim();
  const m = /\(([A-Za-z]{3})\)/.exec(s);
  if (m) return m[1].toUpperCase();
  const parts = s.split(',').map(t => t.trim());
  const last = parts[parts.length - 1] || s;
  if (/^[A-Za-z]{3}$/i.test(last)) return last.toUpperCase();
  if (/^[A-Za-z]{3}$/i.test(s)) return s.toUpperCase();
  return null;
};

const normalizeOffer = (fo) => {
  const priceObj = fo?.price || {};
  const price = Number(priceObj.grandTotal || priceObj.total || 0);

  const it = fo?.itineraries?.[0];
  const segs = it?.segments || [];
  const seg0 = segs[0];
  const segLast = segs[segs.length - 1];

  const departISO = seg0?.departure?.at || '';
  const arriveISO = segLast?.arrival?.at || '';
  const intlDate = new Date(departISO);
  const departDate = departISO ? departISO.slice(0, 10) : '';

  const depart = departISO.slice(11, 16);
  const arrive = arriveISO.slice(11, 16);

  const carrier = seg0?.carrierCode || fo?.validatingAirlineCodes?.[0] || '';
  const flNum = seg0?.number || '';
  const flightNumber = (carrier && flNum) ? `${carrier}${flNum}` : '';

  const isoDuration = it?.duration || '';
  const duration = isoDuration.replace('PT', '').toLowerCase();

  const stops = Math.max(0, segs.length - 1);
  
  let layover = '';
  if (segs.length > 1) {
     try {
       const arr1 = new Date(segs[0].arrival.at);
       const dep2 = new Date(segs[1].departure.at);
       const diffMs = dep2 - arr1;
       if (diffMs > 0) {
          const hours = Math.floor(diffMs / 3600000);
          const mins = Math.round((diffMs % 3600000) / 60000);
          const durStr = `${hours}h${mins > 0 ? ` ${mins}m` : ''}`;
          const stopCode = segs[0].arrival.iataCode;
          layover = `${durStr} ${stopCode}`;
       }
     } catch (e) {
       // ignore date parse errors
     }
  }

  return {
    price,
    airline: carrier,
    flightNumber,
    duration,
    depart,
    arrive,
    stops,
    layover,
    departDate
  };
};

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
  ["fun", "relaxation", "photography", "luxury", "local culture"].forEach(
    (t) => {
      if (lower.includes(t) && !profile.desired_experience.includes(t))
        profile.desired_experience.push(t);
    }
  );
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

// Simple weather filler so frontend always has something to show
function ensureWeather(plan) {
  if (!plan.weather || typeof plan.weather !== "object") {
    plan.weather = { temp: 24, icon: "☀️" };
    return;
  }
  if (typeof plan.weather.temp !== "number") {
    plan.weather.temp = 24;
  }
  if (!plan.weather.icon || typeof plan.weather.icon !== "string" || plan.weather.icon.length < 3) {
    plan.weather.icon = "partly-sunny";
  }
}

// --- 3. SERPAPI SEARCH LAYER -----------------------------------------------

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
      const base = data.local_results || data.places || [];
      const results = base.slice(0, 7).map((r) => ({
        title: r.title,
        price: r.price,
        rating: r.rating,
        type: r.type,
        address: r.address,
        latitude: r.gps_coordinates?.latitude,
        longitude: r.gps_coordinates?.longitude,
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
      const results = (data.properties || []).slice(0, 7).map((p) => ({
        name: p.name,
        total_rate: p.total_rate?.lowest || p.rate_per_night?.lowest,
        rating: p.overall_rating,
        description: p.description,
        link: p.link,
        latitude: p.gps_coordinates?.latitude,
        longitude: p.gps_coordinates?.longitude,
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
      const simplerFlights = flights.slice(0, 5).map((f) => {
        const leg = (f.flights && f.flights[0]) || {};
        const dep = leg.departure_airport || {};
        const arr = leg.arrival_airport || {};
        const depCode = dep.code || dep.airport_code || "";
        const arrCode = arr.code || arr.airport_code || "";
        const route = depCode && arrCode ? `${depCode} → ${arrCode}` : "";

        return {
          airline: leg.airline,
          flight_number: leg.flight_number,
          departure_time: dep.time,
          arrival_time: arr.time,
          departure_airport_code: depCode,
          departure_airport_name: dep.name,
          arrival_airport_code: arrCode,
          arrival_airport_name: arr.name,
          duration: f.total_duration,
          price: f.price,
          route,
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
      const base = data.local_results || data.places || [];
      const results = base.slice(0, 10).map((r) => ({
        title: r.title,
        type: r.type,
        rating: r.rating,
        description: r.description,
        latitude: r.gps_coordinates?.latitude,
        longitude: r.gps_coordinates?.longitude,
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

// --- 4. TOOLS ---------------------------------------------------------------

const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description:
        "Trigger the date picker UI. Call this IMMEDIATELY once the destination is clear or the user shows interest in planning a trip. NEVER ask about dates via text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description:
        "Trigger the guest picker UI. Call this IMMEDIATELY after (or together with) dates are requested. NEVER ask 'how many people' via text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description:
        "Search for restaurants, activities,- Make the plan REALISTIC. Do NOT use placeholder prices.\n- Provide OFFICIAL booking URLs for flights and hotels in the 'booking_url' field (e.g. 'https://www.turkishairlines.com', 'https://www.radisson.com'). Avoid generic Google Search links.\n- The user can \"Pay Now\", so accurate links are critical.ghts or hotels anymore. Use prefixes: '__restaurants__ Rome', '__activities__ Tokyo'.",
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
      name: "search_flights",
      description: "Search for real flights using Amadeus. Dates must be YYYY-MM-DD.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "IATA code (e.g. LON, NYC) or City Name" },
          destination: { type: "string", description: "IATA code (e.g. PAR, TYO) or City Name" },
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["origin", "destination", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_hotels",
      description: "Search for real hotels using Amadeus.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City Name or IATA code" },
          checkIn: { type: "string", description: "YYYY-MM-DD" },
          checkOut: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["city", "checkIn", "checkOut"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Finalize the trip. ONLY call this after you have searched for and found real flights, real hotels, and real activities, and you have dates + guests from tools.",
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
                  description: "ISO format '2025-11-20'",
                },
                day: {
                  type: "string",
                  description:
                    "ISO format '2025-11-20' (backend reformats to 'Nov 20')",
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
                          "24h format e.g. '14:00'. Must always be present.",
                      },
                      duration: { type: "string" },
                      title: { type: "string" },
                      details: { type: "string" },
                      provider: {
                        type: "string",
                        description:
                          "REAL NAME of place/airline/hotel/tour operator. Never generic.",
                      },
                      approxPrice: { type: "number" },
                      latitude: { type: "number" },
                      longitude: { type: "number" },
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
                booking_url: { type: "string", description: "Official homepage or booking deep link e.g. 'https://wizzair.com'. NO generic searches." },
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
                duration: { type: "string" },
                stops: { type: "number" },
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

// --- 5. SYSTEM PROMPT -------------------------------------------------------

const getSystemPrompt = (profile) => `
You are an elite AI TRAVEL ARCHITECT inside a mobile app.

You CAN see and interpret images. When the user sends a photo:
- Carefully analyze the scene (architecture, landscape, language on signs, style).
- Infer likely location(s) and type of place (city, beach resort, mountain village, etc.).
- NEVER say "I can't identify locations from images" or "I can't see images".
- If uncertain, say things like "This looks similar to Santorini or another Greek island" and ask which they prefer.
- Treat a user’s image as a strong signal they want a trip inspired by that scene.

PROFILE CONTEXT:
- Origin city: ${profile.origin_city || "Unknown (you MUST ask 'Where are you flying from?')"}
- Nationality: ${profile.nationality || "Unknown"}
- Travel Style: ${profile.preferred_travel_type.join(", ") || "Any"}
- Budget: ${profile.budget.prefer_comfort_or_saving}
- Existing multi-city intent: ${profile.multi_cities.join(" → ") || "none"}

=====================================
DISCOVERY PHASE (MANDATORY QUESTIONS)
=====================================
As soon as the user shows travel intent (mentions a destination, sends a travel photo, or says "plan a trip"):

3. 1. If DESTINATION is unknown:
   - Ask: "Where would you like to go?"
2. If ORIGIN is unknown:
   - Ask: "Where are you flying from?" (Do NOT assume Istanbul)
3. Always clarify:
   - Budget: "Do you prefer saving money, comfort, or something balanced?"
   - Travel style: "What kind of trip vibe: beach, active, urban, relaxing, nightlife, or culture?"
   - With whom: "Are you going solo, with a partner, with friends, or with family?"

Keep questions short, in **WhatsApp-style** responses (1–3 short sentences).

=====================================
DATES & GUESTS: ALWAYS TOOL, NEVER TEXT
=====================================
- You are FORBIDDEN from asking dates or number of travelers in plain text.
- As soon as:
  - destination is reasonably clear (from text, image, or link), AND
  - the user shows planning intent (e.g., "I want to go there", "plan something like this")
- You MUST:
  1. If the user JUST provided the dates in text (e.g. "I want to go Oct 12-15"), ACCEPT them. Do not ask again.
  2. If dates are missing, call \`request_dates\` immediately.
  3. After that, call \`request_guests\` in a later turn (never via text questions).

NEVER write sentences like:
- "When do you want to travel?"
- "What dates are you thinking?"
- "How many people are going?"

=====================================
REAL-WORLD RESEARCH (MANDATORY)
=====================================
When you have:
- clear destination (or your best inferred guess), AND
- travel intent, AND
- dates + guests (from tools),

You MUST:
- Call \`search_flights\` for flight options (origin/dest can be city names, I'll convert them).
- Call \`search_hotels\` for accommodation.
- Call \`search_google\` ONLY for:
  - "__restaurants__ DESTINATION"
  - "__activities__ DESTINATION"

Your goal:
- Use **real flights** from search results:
  - Airlines, flight numbers, realistic prices.
  - Include airports by real IATA codes (e.g., HEL, CDG, JFK).

  >>> HARD RULE FOR FLIGHT WORDING <<<
  - NEVER write vague phrases like "depart from Abuja to Moscow".
  - ALWAYS anchor flights to specific airports and the airline/flight number.
  - Use this pattern in titles and details:
    - "Turkish Airlines TK624 from Nnamdi Azikiwe International Airport (ABV) in Abuja to Sheremetyevo International Airport (SVO) in Moscow".
    - Short title example: "Flight ABV → SVO (Turkish Airlines TK624)".

- Use **real hotels**:
  - Real property names, approximate nightly rates, and ratings. 
  - Aim for high-rated, characterful stays (boutique, luxury, or unique local spots) rather than just generic chains.
- Use **real restaurants and activities**:
  - Real venue/tour names, taken from search results.
  - **CRITICAL:** Search for "hidden gems", "local favorites", "best kept secrets", and "unique experiences".
  - **DIVERSITY:** Ensure the plan has a mix of culture, culinary, relaxation, and active elements.
  - **LOGISTICS:** Group activities by neighborhood to minimize travel time. Don't zigzag across the city.

=====================================
ITINERARY & create_plan
=====================================
When you call \`create_plan\`:

- \`itinerary[*].date\` and \`itinerary[*].day\`:
  - MUST be ISO-like "YYYY-MM-DD". The backend will display them as "Nov 20".

- Every event:
  - MUST have a specific, realistic time in 24h format (e.g., "09:00", "14:30", "19:30").
  - MUST have a \`provider\` field with a REAL entity name (hotel, restaurant, airline, tour operator).
  - MUST NOT be generic like "Nice restaurant", "Local hotel", "Beach time".
  - For travel events, mention airport names + codes and airline:
    - Example details: "Turkish Airlines TK624, Nnamdi Azikiwe International Airport (ABV) → Sheremetyevo International Airport (SVO)".

- Flights in \`flights\`:
  - Use airline name, flight number, and realistic departure/arrival times and approximate price.
  - Derive from \`search_google("__flights__ ...")\` results.

- Hotels:
  - Use hotel names from \`__hotels__\` results.

- Restaurants / Food:
  - Use restaurant names from \`__restaurants__\` results.

- Activities:
  - Use attraction or tour names from \`__activities__\` results or your best known real-world names.
  - **CRITICAL**: If the search results provided 'latitude' and 'longitude', you MUST include them in the event object.

>>> HARD RULE: NO TEXT-ONLY FULL ITINERARIES <<<
- You are FORBIDDEN from writing a full day-by-day itinerary in normal chat messages.
- Do NOT send messages like:
  - "Day 1: ... Day 2: ..." or big lists of activities per day.
- All detailed "Day X / morning / afternoon / evening" content MUST be inside the \`itinerary\` array of the \`create_plan\` tool.
- In normal chat, you may mention at most 2–3 highlight examples in ONE short sentence.

>>> WHEN TO CALL create_plan <<<
As soon as you have:
- origin city
- destination
- dates & guests (from tools)
- at least one realistic flight option
- at least one realistic hotel option
- a set of 4–8 good activities/places

You MUST:
- Stop explaining the trip in detail.
- Say a very short message like: "Great, I'll build a plan for you now."
- Immediately call \`create_plan\` and put ALL day-by-day details into the tool payload instead of the chat text.

=====================================
CHAT STYLE
=====================================
- Messages must be short and conversational (WhatsApp-style).
- Do NOT dump long essays.
- Never print long bullet lists of activities in normal chat when you could instead finalize a plan via \`create_plan\`.

=====================================
TOOLS AND ORDER (ONE TOOL PER MESSAGE)
=====================================
- You must call AT MOST one tool in each assistant message.
- Sequence:
  1. Clarify origin + preferences (budget, style, with whom).
  2. Call \`request_dates\`.
  3. Call \`request_guests\`.
  4. Call \`search_google\` multiple times (in separate turns) for flights, hotels, restaurants, activities.
  5. Call \`create_plan\` once, when you have enough info.

Never say "I can't do X because I don't have browsing" — you DO have a search tool, also create more than 2 itineraries for each day.
`;

// --- 6. NORMALIZE MESSAGES --------------------------------------------------

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
        // vision: text + image_url array is passed as-is
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

// --- 7. MAIN ROUTE ----------------------------------------------------------

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
          content:
            "SYSTEM INTERVENTION: You have gathered enough information. Stop asking questions. Use the data you have found (or make reasonable real-world estimates) and call the 'create_plan' tool IMMEDIATELY.",
        });
      } else if (depth > 9) {
        return { aiText: "I'm having trouble finalizing. Let's start fresh." };
      }

      let completion;
      try {
        completion = await client.chat.completions.create({
          model: "gpt-5.2",
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

      // --- TOOL CALL HANDLING (STRICT SINGLE TOOL) ---
      if (msg.tool_calls?.length) {
        const toolCall = msg.tool_calls[0];
        const toolName = toolCall.function.name;
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch (e) {
          logError(reqId, "[Tool args parse error]", e);
        }

        logInfo(reqId, `[Tool] ${toolName}`, args);

        const assistantMsgSanitized = {
          ...msg,
          tool_calls: [toolCall],
        };
        const newHistory = [...conversation, assistantMsgSanitized];

        // A. SEARCH -> recurse
        if (toolName === "search_google") {
          const result = await performGoogleSearch(args.query, reqId);
          newHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          return runConversation(newHistory, depth + 1);
        }

        // A2. SEARCH FLIGHTS (AMADEUS)
        if (toolName === "search_flights") {
          let result = "No flights found.";
          try {
            // Resolve IATA
            const originCode = getCode(args.origin) || args.origin.toUpperCase();
            const destCode = getCode(args.destination) || args.destination.toUpperCase();
            // Simple search
            const { data } = await amadeus.shopping.flightOffersSearch.post(JSON.stringify({
              currencyCode: 'USD',
              originDestinations: [
                {
                  id: '1',
                  originLocationCode: originCode,
                  destinationLocationCode: destCode,
                  departureDateTimeRange: { date: args.date }
                }
              ],
              travelers: [{ id: '1', travelerType: 'ADULT' }],
              sources: ['GDS']
            }));
            const offers = data ? data.slice(0, 5) : [];
            if (offers.length) {
              // 1. Convert to structured objects
              const structured = offers.map(o => normalizeOffer(o));
              // 2. Save to memory for fallback
              mem.lastFlights = structured;
              
              // 3. Convert to string for LLM
              result = structured.map(n => {
                const route = `${n.origin || args.origin}->${n.destination || args.destination}`; 
                // Wait, n.origin/dest might be missing in normalizeOffer if we rely on route parsing?
                // normalizeOffer sets depart/arrive as times. It doesn't set origin/dest codes yet?
                // Let's check normalizeOffer. It has layover, stops, airline...
                // Actually normalizeOffer returns `depart`, `arrive`, `stops`, `layover`, `airline`, `flightNumber`.
                // It does NOT return `origin` or `destination` codes explicitly? 
                // Let's check line 1067 of chat.routes.js: `origin: origin || f0.departure_airport_code`. 
                // In my previous edits I added `departDate`? Yes.
                
                const stopsPart = n.stops === 0 ? "Direct" : `${n.stops} stops`;
                return `Flight ${n.flightNumber} (${n.airline}) ${route}: ${n.depart}-${n.arrive} (${n.duration}, ${stopsPart}) for $${n.price}`;
              }).join('\n');
            }
          } catch (e) {
            result = `Flight search failed: ${e?.response?.result?.errors?.[0]?.detail || e.message}`;
            logError(reqId, "Amadeus Flight Error", e);
          }
          newHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          return runConversation(newHistory, depth + 1);
        }

        // A3. SEARCH HOTELS (AMADEUS)
        if (toolName === "search_hotels") {
          let result = "No hotels found.";
          try {
            // 1. Resolve city to IATA or use directly if 3 chars
            let cityCode = args.city.length === 3 ? args.city.toUpperCase() : null;
            if (!cityCode) {
              const locs = await amadeus.referenceData.locations.get({ keyword: args.city, subType: 'CITY' });
              cityCode = locs?.data?.[0]?.iataCode;
            }

            if (cityCode) {
              // 2. Get Hotel IDs
              const hList = await amadeus.referenceData.locations.hotels.byCity.get({ cityCode });
              const hIds = (hList?.data || []).slice(0, 10).map(h => h.hotelId);

              if (hIds.length > 0) {
                // 3. Get Offers
                const { data } = await amadeus.shopping.hotelOffersSearch.get({
                  hotelIds: hIds.join(','),
                  checkInDate: args.checkIn,
                  checkOutDate: args.checkOut,
                  adults: 1,
                  currencyCode: 'USD'
                });
                if (data && data.length) {
                  result = data.slice(0, 5).map(h => {
                    return `Hotel ${h.hotel?.name} (${h.hotel?.hotelId}): $${h.offers?.[0]?.price?.total} total`;
                  }).join('\n');
                }
              }
            } else {
              result = "Could not resolve city code.";
            }
          } catch (e) {
            result = `Hotel search failed: ${e?.response?.result?.errors?.[0]?.detail || e.message}`;
            logError(reqId, "Amadeus Hotel Error", e);
          }
          newHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          return runConversation(newHistory, depth + 1);
        }

        // B. DATES / GUESTS -> return signal to frontend
        if (toolName === "request_dates") {
          return {
            aiText: "Choose your travel dates.",
            signal: { type: "dateNeeded" },
            assistantMessage: assistantMsgSanitized,
          };
        }

        if (toolName === "request_guests") {
          return {
            aiText: "Select how many people are traveling.",
            signal: { type: "guestsNeeded" },
            assistantMessage: assistantMsgSanitized,
          };
        }

        // C. CREATE PLAN -> finalize and return
        if (toolName === "create_plan") {
          logInfo(reqId, "[TOOL] create_plan called. Keys:", Object.keys(args));
          const plan = { ...args };

          if (!plan.itinerary) plan.itinerary = [];
          if (!plan.flights) plan.flights = [];
          
          // FALLBACK: If LLM forgot to pass flights back, use memory
          if (plan.flights.length === 0) {
             if (mem.lastFlights && mem.lastFlights.length > 0) {
                 logInfo(reqId, "Restoring flights from memory fallback (count: " + mem.lastFlights.length + ")");
                 plan.flights = mem.lastFlights;
             } else {
                 logInfo(reqId, "No flights in plan AND no flights in memory fallback.");
             }
          }

          if (!plan.costBreakdown) plan.costBreakdown = [];
          
          // FORCE USD to avoid AI hallucinating local currency on USD prices
          plan.currency = "USD";
          
          if (!plan.cities) plan.cities = [];
          if (plan.cities.length > 1) plan.multiCity = true;

          // Ensure weather exists so frontend always has something
          ensureWeather(plan);

          // Attach image
          try {
            const q =
              plan.multiCity && plan.cities.length > 0
                ? plan.cities[0]
                : plan.location;
            plan.image = await pickPhoto(q || "travel", reqId);
          } catch (e) {
            plan.image = FALLBACK_IMAGE_URL;
          }

          // --- ENRICH FLIGHTS FROM MEMORY (Merge rich data) ---
          if (plan.flights && plan.flights.length > 0 && mem.lastFlights && mem.lastFlights.length > 0) {
              plan.flights.forEach(f => {
                   // Ensure we have a flight number to match
                   const fNum = (f.flightNumber || "").replace(/\s+/g, '').toUpperCase();
                   if (fNum) {
                       const match = mem.lastFlights.find(mf => 
                           (mf.flightNumber || "").replace(/\s+/g, '').toUpperCase() === fNum ||
                           (mf.airline === f.airline && mf.price === f.price) // fallback match
                       );
                       if (match) {
                           logInfo(reqId, "Enriching flight " + fNum + " from memory data");
                           if (!f.layover) f.layover = match.layover;
                           if (!f.departDate) f.departDate = match.departDate;
                           if (!f.stops) f.stops = match.stops;
                           if (!f.depart) f.depart = match.depart;
                           if (!f.arrive) f.arrive = match.arrive;
                           // if (!f.duration) f.duration = match.duration; // Trust AI duration or memory? Memory is safer.
                           // Actually AI returns formatted duration "23h30m", memory has "xh ym". 
                           // Let's keep AI duration if present, as it might be what user saw.
                       }
                   }
                   
                   // Fallback: Derive departDate from departTime if still missing
                   if (!f.departDate && f.departTime && f.departTime.includes('T')) {
                        f.departDate = f.departTime.split('T')[0];
                   } else if (!f.departDate && f.departTime && f.departTime.match(/^\d{4}-\d{2}-\d{2}/)) {
                        f.departDate = f.departTime.slice(0, 10);
                   }
              });
          }

          // --- ITINERARY SYNC: INJECT REAL FLIGHT DETAILS ---
          // Run this BEFORE formatting dates so we can match ISO strings
          if (plan.flights && plan.flights.length > 0 && plan.itinerary) {
              logInfo(reqId, "Syncing flights to itinerary...", { 
                  flightDate: plan.flights[0].departDate, 
                  itinDates: plan.itinerary.map(d => d.date) 
              });
              
              plan.flights.forEach(f => {
                  if (f.departDate) {
                      const day = plan.itinerary.find(d => 
                          (d.date && d.date.startsWith(f.departDate)) || 
                          (d.day && d.day.startsWith(f.departDate))
                      );
                      
                      if (day) {
                          const ev = day.events ? day.events.find(e => 
                              e.type === 'travel' || 
                              (e.title && e.title.toLowerCase().includes('flight'))
                          ) : null;
                          
                          if (ev) {
                              logInfo(reqId, "Found matching event for sync:", ev.title);
                              if (f.duration) ev.duration = f.duration;
                              if (f.flightNumber && (!ev.title || !ev.title.includes(f.flightNumber))) {
                                  ev.title = `Flight ${f.flightNumber} (${f.airline})`;
                                  ev.provider = f.airline; 
                              }
                          } else {
                              logInfo(reqId, "Day found but no Flight/Travel event", day);
                          }
                      } else {
                         logInfo(reqId, "No matching day found for flight date:", f.departDate);
                      }
                  }
              });
          }

          // Format itinerary dates to "Nov 20" for frontend
          plan.itinerary.forEach((day) => {
            if (day.date) {
              const nice = formatDateToMMMDD(day.date);
              day.date = nice;
              day.day = nice;
            } else if (day.day) {
              const nice = formatDateToMMMDD(day.day);
              day.date = nice;
              day.day = nice;
            }

            if (Array.isArray(day.events)) {
              const defaultSlots = ["09:00", "13:00", "17:00", "20:00"];
              day.events.forEach((ev, idx) => {
                if (
                  !ev.time ||
                  typeof ev.time !== "string" ||
                  !ev.time.trim()
                ) {
                  ev.time = defaultSlots[idx] || "10:00";
                }
                if (
                  !ev.duration ||
                  typeof ev.duration !== "string" ||
                  !ev.duration.trim()
                ) {
                   // Smarter defaults
                   if (ev.type === 'travel' || (ev.title && ev.title.toLowerCase().includes('flight'))) {
                       ev.duration = "Travel"; 
                   } else {
                       ev.duration = "1h"; // Reduce default for regular activities
                   }
                }

                const t = String(ev.title || "").toLowerCase();
                const p = String(ev.provider || "").toLowerCase();

                const generic =
                  t.includes("local restaurant") ||
                  t.includes("nice restaurant") ||
                  (t.includes("hotel") &&
                    !t.includes("★") &&
                    !t.includes("resort") &&
                    !t.includes("inn") &&
                    !t.includes("hotel ") &&
                    !/[a-z]{3,}/.test(t.replace("hotel", ""))) ||
                  t.includes("beach time") ||
                  t.includes("explore the city") ||
                  t.includes("generic") ||
                  p === "local restaurant" ||
                  p === "nice hotel" ||
                  p === "local hotel";

                if (generic) {
                  ev.title =
                    "INVALID_GENERIC_EVENT — PLEASE REGENERATE WITH REAL PLACE NAMES";
                }
              });
            }
          });



          // --- COST BREAKDOWN ENRICHMENT ---
          // 1. If breakdown is empty but we have flights, add a default flight item
          if (plan.costBreakdown.length === 0 && plan.flights.length > 0) {
            const f0 = plan.flights[0];
            const details = f0.route || "Round trip";
            // Enrich with time/stops if available
            const extra = [];
            if (f0.duration) extra.push(f0.duration);
            if (f0.stops !== undefined) extra.push(f0.stops === 0 ? "Direct" : `${f0.stops} stops`);
            const subTitle = extra.length ? `${details} (${extra.join(', ')})` : details;

            plan.costBreakdown.push({
              item: "Flights",
              provider: f0.airline || "Airline",
              details: subTitle,
              price: f0.price || 0,
              iconType: "plane",
              iconValue: "✈️",
              // PASS THROUGH RAW DATA for custom cards
              raw: {
                ...f0,
                depart: f0.departTime, // Map schema mismatch
                arrive: f0.arriveTime
              }
            });
          }
          else if (plan.costBreakdown.length > 0 && plan.flights.length > 0) {
             // Strategy: Remove ALL existing "Flight" line items and inject our ONE single simplified "Flights" line.
             // This guarantees no duplicates and perfect data.
             
             // Filter out any AI-generated flight entries
             plan.costBreakdown = plan.costBreakdown.filter(item => {
                 const lower = (item.item || "").toLowerCase();
                 return !(lower.includes("flight") || lower.includes("fly") || lower.includes("airline"));
             });

             // Now append our single source of truth flight item
             const f0 = plan.flights[0];
             const details = f0.route || "Round trip";
             // Enrich with time/stops/layover
             const extra = [];
             if (f0.duration) extra.push(f0.duration);
             if (f0.stops !== undefined) extra.push(f0.stops === 0 ? "Direct" : `${f0.stops} stops`);
             if (f0.layover) extra.push(f0.layover); 

             const subTitle = extra.length ? `${details} (${extra.join(', ')})` : details;
             
              // Simple origin/dest parsing from route "LON -> NYC"
              let origin = ""; 
              let destination = "";
              if (f0.route && f0.route.includes('→')) {
                 const parts = f0.route.split('→');
                 origin = parts[0].trim();
                 destination = parts[1].trim();
              }

             plan.costBreakdown.unshift({ 
               item: "Flights",
               provider: f0.airline || "Airline",
               details: subTitle,
               price: f0.price || 0,
               iconType: "plane",
               iconValue: "✈️",
               booking_url: f0.booking_url,
               raw: {
                 ...f0,
                 depart: f0.departTime,
                 arrive: f0.arriveTime,
                 origin: origin || f0.departure_airport_code,
                 destination: destination || f0.arrival_airport_code,
                 layover: f0.layover
               }
             });
          }

          return {
            aiText: `I've built a plan for ${plan.location}.`,
            signal: { type: "planReady", payload: plan },
            assistantMessage: assistantMsgSanitized,
          };
        }
      }

      // No tool calls -> Standard text response (also guard against manual date questions)
      let text = msg.content || "";
      const lower = (text || "").toLowerCase();

      // If the model starts dumping an itinerary, intercept and push it to create_plan
      const looksLikeItinerary =
        lower.includes("day 1") ||
        lower.includes("day one") ||
        lower.includes("itinerary") ||
        /day\s+\d+[:\-]/i.test(text || "");

      if (looksLikeItinerary && depth < 7) {
        logInfo(
          reqId,
          "[Guardrail] Intercepted text itinerary. Forcing model to use create_plan instead."
        );

        const newConversation = [
          ...conversation,
          msg,
          {
            role: "system",
            content:
              "SYSTEM REMINDER: Do NOT write day-by-day itineraries in plain text. You already have enough information. Now you MUST call the 'create_plan' tool and put all days/activities inside its 'itinerary' field. In the chat message, only say a short confirmation like 'Great, I'll build a plan for you now.'",
          },
        ];

        return runConversation(newConversation, depth + 1);
      }

      // Guardrail: if the model mistakenly asks about dates/guests via text, convert to tool signals instead
      const mentionsDates =
        lower.includes("what dates") ||
        lower.includes("when do you want") ||
        lower.includes("when are you planning") ||
        lower.includes("when would you like to travel");

      const mentionsGuests =
        lower.includes("how many people") ||
        lower.includes("how many guests") ||
        (lower.includes("who is traveling") && lower.includes("people"));

      if (mentionsDates) {
        logInfo(
          reqId,
          "[Guardrail] Intercepted text question about dates. Returning dateNeeded signal instead."
        );
        return {
          aiText: "Choose your travel dates.",
          signal: { type: "dateNeeded" },
          assistantMessage: msg,
        };
      }

      if (mentionsGuests) {
        logInfo(
          reqId,
          "[Guardrail] Intercepted text question about guests. Returning guestsNeeded signal instead."
        );
        return {
          aiText: "Select how many people are traveling.",
          signal: { type: "guestsNeeded" },
          assistantMessage: msg,
        };
      }

      // Anti-dump: shorten overly long messages
      if (typeof text === "string" && text.length > 600) {
        text = text.slice(0, 580) + "…";
      }

      return { aiText: text };
    };

    const response = await runConversation(baseHistory);
    return res.json(response);
  } catch (err) {
    logError(reqId, "Route Error", err);
    return res.status(500).json({ aiText: "Server error." });
  }
});

export default router;
