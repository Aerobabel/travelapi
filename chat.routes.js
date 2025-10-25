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

const hasSerpKey = Boolean(process.env.SERPAPI_API_KEY);
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o";

/* ----------------------------- LOGGING ------------------------------- */
const newReqId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

/* --------------------------- MEMORY (LIGHT) -------------------------- */
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

/* -------------------------- IMAGE (UNSPLASH) ------------------------- */
const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1470&auto=format&fit=crop";

async function pickPhoto(dest, reqId) {
  const cacheKey = (dest || "").toLowerCase().trim();
  if (!cacheKey) return FALLBACK_IMAGE_URL;
  if (imageCache.has(cacheKey)) {
    logInfo(reqId, `[CACHE HIT] Serving image for "${dest}"`);
    return imageCache.get(cacheKey);
  }
  if (!UNSPLASH_ACCESS_KEY) {
    logError(reqId, "UNSPLASH_ACCESS_KEY is not set. Returning fallback image.");
    return FALLBACK_IMAGE_URL;
  }

  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
    `${dest} travel`
  )}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
    if (!res.ok) {
      logError(reqId, `Unsplash API error: ${res.status} ${res.statusText}`);
      return FALLBACK_IMAGE_URL;
    }
    const data = await res.json();
    if (data.results?.length > 0) {
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

/* ------------------------------ DATES -------------------------------- */
const fmtYMD = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shortMonthDay = (d) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d); // "Oct 1"

function parseISO(s) {
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function spanDates(startYMD, endYMD) {
  const start = parseISO(startYMD);
  const end = parseISO(endYMD);
  if (!start || !end || end < start) return [];
  const out = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push({ date: fmtYMD(d), day: shortMonthDay(d) });
  }
  return out;
}

/* -------------------------- WEATHER (Open-Meteo) --------------------- */
async function fetchWeatherSummary(city, startYMD, reqId) {
  try {
    const g = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
    ).then((r) => r.json());
    const loc = g?.results?.[0];
    if (!loc) return null;

    const { latitude, longitude, timezone } = loc;

    const forecastUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=${encodeURIComponent(
        timezone || "auto"
      )}&start_date=${startYMD}&end_date=${startYMD}`;
    const f = await fetch(forecastUrl).then((r) => r.json());

    const tmax = f?.daily?.temperature_2m_max?.[0];
    const tmin = f?.daily?.temperature_2m_min?.[0];
    const code = f?.daily?.weathercode?.[0];

    let temp = null;
    if (typeof tmax === "number" && typeof tmin === "number") temp = Math.round((tmax + tmin) / 2);

    let icon = "partly-sunny";
    if (typeof code === "number") {
      if (code === 0) icon = "sunny";
      else if ([1, 2, 3].includes(code)) icon = "partly-sunny";
      else icon = "cloudy";
    }

    if (temp != null) return { temp, icon };

    // Climate fallback
    const month = new Date(startYMD).getMonth() + 1;
    const c = await fetch(
      `https://climate-api.open-meteo.com/v1/climate?latitude=${latitude}&longitude=${longitude}&start_year=1991&end_year=2020&models=ERA5&month=${month}&daily=temperature_2m_mean`
    ).then((r) => r.json());
    const tmean = c?.daily?.temperature_2m_mean?.[0];
    if (typeof tmean === "number") {
      const t = Math.round(tmean);
      return { temp: t, icon: t >= 24 ? "sunny" : t >= 10 ? "partly-sunny" : "cloudy" };
    }
    return null;
  } catch (e) {
    logError(reqId, "WEATHER_ERROR", e?.message || e);
    return null;
  }
}

/* ---------------------------- SERP HELPERS --------------------------- */
// Correct signature for serpapi@1.1.1 → getJson(engine, params)
async function serpFlights({ from, to, depart_date, return_date, currency = "USD" }, reqId) {
  if (!hasSerpKey) return { error: "SERPAPI_API_KEY missing" };
  try {
    const r = await getJson("google_flights", {
      api_key: process.env.SERPAPI_API_KEY,
      hl: "en",
      gl: "us",
      currency,
      departure_id: from, // IATA code (e.g., SFO)
      arrival_id: to,     // IATA code (e.g., CDG)
      outbound_date: depart_date,
      return_date,
    });
    const best = r?.best_flights?.[0];
    if (!best) return { flights: [] };
    const f0 = best.flights?.[0] || {};
    return {
      flights: [
        {
          price: best.price,
          airline: f0.airline,
          departure: `${f0?.departure_airport?.name} (${f0?.departure_airport?.id})`,
          arrival: `${f0?.arrival_airport?.name} (${f0?.arrival_airport?.id})`,
          total_duration: best.total_duration,
        },
      ],
    };
  } catch (e) {
    logError(reqId, "SERPAPI_FLIGHTS_ERROR", e?.message || e);
    return { error: "Could not retrieve flights." };
  }
}

async function serpHotels({ location, check_in, check_out, currency = "USD" }, reqId) {
  if (!hasSerpKey) return { error: "SERPAPI_API_KEY missing" };
  try {
    const r = await getJson("google_hotels", {
      api_key: process.env.SERPAPI_API_KEY,
      hl: "en",
      gl: "us",
      currency,
      q: `hotels in ${location}`,
      check_in_date: check_in,
      check_out_date: check_out,
    });
    const hotels =
      r?.properties?.slice(0, 3).map((h) => ({
        name: h.name,
        rating: h.overall_rating,
        price: h.rate_per_night?.extracted_price,
        description: h.description,
      })) || [];
    return { hotels };
  } catch (e) {
    logError(reqId, "SERPAPI_HOTELS_ERROR", e?.message || e);
    return { error: "Could not retrieve hotels." };
  }
}

async function serpAttractions({ location, top_n = 8 }, reqId) {
  if (!hasSerpKey) return { error: "SERPAPI_API_KEY missing" };
  try {
    // Use Google Local to fetch popular attractions/landmarks
    const r = await getJson("google_local", {
      api_key: process.env.SERPAPI_API_KEY,
      hl: "en",
      gl: "us",
      q: `top sights in ${location}`,
      num: Math.min(Math.max(top_n, 3), 10),
    });
    const results =
      r?.local_results?.map((x) => ({
        name: x.title,
        rating: x.rating,
        address: x.address,
        category: x.type || x.subtitle,
        hours: x.hours,
      })) || [];
    return { attractions: results };
  } catch (e) {
    logError(reqId, "SERPAPI_ATTRACTIONS_ERROR", e?.message || e);
    return { error: "Could not retrieve attractions." };
  }
}

/* ----------------------------- OPENAI TOOLS -------------------------- */
/** Keep your same contract (request dates/guests + create_plan),
 *  but add SERP-backed tools the model can call silently to get real data for concrete itineraries.
 */
const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "Ask the user for travel dates (YYYY-MM-DD to YYYY-MM-DD).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Ask the user for number of travelers (adults/children).",
      parameters: { type: "object", properties: {} },
    },
  },

  // NEW: SERP tools (silent; do not dump raw lists unless user asks)
  {
    type: "function",
    function: {
      name: "serp_get_flights",
      description:
        "Fetch indicative flight option for itinerary realism. Use IATA codes if available.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Departure IATA, e.g., SFO" },
          to: { type: "string", description: "Arrival IATA, e.g., CDG" },
          depart_date: { type: "string", description: "YYYY-MM-DD" },
          return_date: { type: "string", description: "YYYY-MM-DD" },
          currency: { type: "string", description: "e.g., USD, EUR" },
        },
        required: ["from", "to", "depart_date", "return_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "serp_get_hotels",
      description:
        "Fetch 2-3 hotel candidates to anchor the plan. Summarize; do not list unless asked.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
          check_in: { type: "string", description: "YYYY-MM-DD" },
          check_out: { type: "string", description: "YYYY-MM-DD" },
          currency: { type: "string" },
        },
        required: ["location", "check_in", "check_out"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "serp_get_attractions",
      description:
        "Fetch top attractions/venues for concrete daily plans. Use to place real spots per day.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          top_n: { type: "number", description: "Max results (3-10)", minimum: 3, maximum: 10 },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather summary for trip start date.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          start_date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["location", "start_date"],
      },
    },
  },

  // Finalizer (same contract)
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Return a full, detailed, date-based itinerary with cost breakdown once destination, dates, and guests are known.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string", description: "YYYY-MM-DD to YYYY-MM-DD" },
          description: { type: "string" },
          image: { type: "string" },
          price: { type: "number" },
          weather: {
            type: "object",
            properties: { temp: { type: "number" }, icon: { type: "string", enum: ["sunny", "partly-sunny", "cloudy"] } },
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "YYYY-MM-DD" },
                day: { type: "string", description: "e.g., Oct 1" },
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
                iconType: { type: "string", enum: ["image", "date"] },
                iconValue: { type: "string" },
              },
              required: ["item", "provider", "details", "price", "iconType", "iconValue"],
            },
          },
        },
        required: ["location", "country", "dateRange", "description", "image", "price", "itinerary", "costBreakdown"],
      },
    },
  },
];

/* --------------------------- SYSTEM PROMPT --------------------------- */
const getSystemPrompt = (profile) => `You are a professional AI travel agent.
- Speak naturally and ask for missing slots (dates, guests) using request_dates / request_guests.
- Use SERP tools silently to ground the plan with REAL data: serp_get_flights, serp_get_hotels, serp_get_attractions, get_weather.
- Build an itinerary with actual calendar dates (YYYY-MM-DD) and also a display day like "Oct 1".
- 3–5 concrete events per day with realistic venues/areas from attractions; include meals and breaks.
- Only call create_plan when the plan is ready. Do NOT dump raw lists unless the user asks.
- Reflect the user's profile preferences in choices.

USER PROFILE:
${JSON.stringify(profile, null, 2)}
`;

/* ------------------------ NORMALIZE MESSAGES ------------------------- */
function normalizeMessages(messages = []) {
  const allowed = new Set(["system", "user", "assistant"]);
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      const role = allowed.has(m.role) ? m.role : "user";
      const content = m.content ?? m.text ?? "";
      return { role, content: String(content) };
    });
}

/* ------------------------------ ROUTE -------------------------------- */
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel OpenAI=${hasKey} Serp=${hasSerpKey} fetch=${FETCH_SOURCE} model=${OPENAI_MODEL}`);
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey || !client) {
      return res.status(500).json({ aiText: "The AI model is not configured." });
    }

    const systemPrompt = getSystemPrompt(mem.profile);
    let loopMessages = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];

    // short agent loop until create_plan is called or we have a final message
    const MAX_TURNS = 6;

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

      if (toolCalls.length === 0) {
        // Just text back to user (ask a question or give an update)
        return res.json({ aiText: msg?.content || "How can I help with your trip?" });
      }

      // mirror assistant tool call into history
      loopMessages.push({
        role: "assistant",
        content: msg.content || "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: tc.function,
        })),
      });

      // process tool calls (request_* => UI signals; serp_* => fetch; create_plan => finalize)
      for (const tc of toolCalls) {
        const fn = tc.function?.name || "";
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          args = {};
        }

        // UI ask tools
        if (fn === "request_dates") {
          return res.json({
            aiText: msg.content || "When would you like to travel? (YYYY-MM-DD to YYYY-MM-DD)",
            signal: { type: "dateNeeded" },
            assistantMessage: {
              role: "assistant",
              tool_calls: [
                { id: tc.id || `call_${reqId}`, type: "function", function: { name: "request_dates", arguments: "{}" } },
              ],
            },
          });
        }
        if (fn === "request_guests") {
          return res.json({
            aiText: msg.content || "How many people are traveling (adults / children)?",
            signal: { type: "guestsNeeded" },
            assistantMessage: {
              role: "assistant",
              tool_calls: [
                { id: tc.id || `call_${reqId}`, type: "function", function: { name: "request_guests", arguments: "{}" } },
              ],
            },
          });
        }

        // SERP tools (silent)
        if (fn === "serp_get_flights") {
          const result = await serpFlights(args, reqId);
          loopMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
          continue;
        }
        if (fn === "serp_get_hotels") {
          const result = await serpHotels(args, reqId);
          loopMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
          continue;
        }
        if (fn === "serp_get_attractions") {
          const result = await serpAttractions(args, reqId);
          loopMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
          continue;
        }
        if (fn === "get_weather") {
          const w = await fetchWeatherSummary(args.location, args.start_date, reqId);
          loopMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(w || {}) });
          continue;
        }

        // Finalize plan
        if (fn === "create_plan") {
          // ensure image + weather + real dates alignment on server side
          const plan = { ...args };
          plan.image = await pickPhoto(plan.location, reqId);

          // align itinerary dates to dateRange if present
          if (plan.dateRange && /to/i.test(plan.dateRange)) {
            const [a, b] = plan.dateRange.split(/to/i).map((s) => s.trim());
            const start = parseISO(a);
            const end = parseISO(b);
            if (start && end && Array.isArray(plan.itinerary)) {
              const days = spanDates(fmtYMD(start), fmtYMD(end));
              for (let i = 0; i < plan.itinerary.length && i < days.length; i++) {
                plan.itinerary[i].date = days[i].date;
                plan.itinerary[i].day = days[i].day;
              }
            }
            if (!plan.weather) {
              const w = await fetchWeatherSummary(plan.location, fmtYMD(start || new Date(a)), reqId);
              if (w) plan.weather = w;
            }
          }
          if (!plan.weather) plan.weather = { temp: 22, icon: "partly-sunny" };

          return res.json({
            aiText: "Here’s your personalized travel plan!",
            signal: { type: "planReady", payload: plan },
            assistantMessage: {
              role: "assistant",
              tool_calls: [
                {
                  id: `call_${reqId}`,
                  type: "function",
                  function: { name: "create_plan", arguments: JSON.stringify(plan) },
                },
              ],
            },
          });
        }
      }

      // continue loop so the model can use tool results and then call create_plan
      continue;
    }

    // If we get here, the model kept calling silent tools but never finalized
    return res.json({
      aiText:
        "I’ve pulled real flight/hotel/attraction data. Could you confirm your dates and number of guests so I can finalize your plan?",
    });
  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    return res.status(500).json({ aiText: "A critical server error occurred. Please try again." });
  }
});

export default router;
