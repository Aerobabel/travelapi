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

const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const hasSerpKey = Boolean(process.env.SERPAPI_API_KEY);
const client = hasOpenAIKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

/* ----------------------------- LOGGING ------------------------------- */
const newReqId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

/* --------------------------- IN-MEMORY DB ---------------------------- */
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
        budget: { prefer_comfort_or_saving: "balanced", amount_per_person: null, currency: "USD" },
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

/* -------------------------- UTIL / HELPERS --------------------------- */
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

function parseISO(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d) ? null : d;
}
function fmtYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shortMonthDay(d) {
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return fmt.format(d); // e.g., "Oct 1"
}
function expandDateRangeToDates(startYMD, endYMD) {
  const start = parseISO(startYMD);
  const end = parseISO(endYMD);
  if (!start || !end || end < start) return [];
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push({ date: fmtYMD(d), day: shortMonthDay(d) });
  }
  return days;
}

/* -------------------------- WEATHER (Open-Meteo) --------------------- */
/** Returns { temp: number, icon: "sunny"|"partly-sunny"|"cloudy" } using forecast; falls back to climate means */
async function fetchWeatherSummary(city, startYMD, reqId) {
  try {
    // 1) geocode
    const g = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
    ).then((r) => r.json());
    const loc = g?.results?.[0];
    if (!loc) return null;

    const { latitude, longitude, timezone } = loc;

    // 2) try forecast for the start date
    const d0 = startYMD;
    const forecastUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=${encodeURIComponent(
        timezone || "auto"
      )}&start_date=${d0}&end_date=${d0}`;
    const f = await fetch(forecastUrl).then((r) => r.json());

    let avg = null;
    let icon = null;
    const tmax = f?.daily?.temperature_2m_max?.[0];
    const tmin = f?.daily?.temperature_2m_min?.[0];
    const code = f?.daily?.weathercode?.[0];
    if (typeof tmax === "number" && typeof tmin === "number") {
      avg = Math.round((tmax + tmin) / 2);
    }
    if (typeof code === "number") {
      // very small mapping to requested icons
      if ([0].includes(code)) icon = "sunny";
      else if ([1, 2, 3].includes(code)) icon = "partly-sunny";
      else icon = "cloudy";
    }
    if (avg != null && icon) return { temp: avg, icon };

    // 3) fallback to monthly climate normals
    const month = new Date(startYMD).getMonth() + 1;
    const climateUrl =
      `https://climate-api.open-meteo.com/v1/climate?latitude=${latitude}&longitude=${longitude}` +
      `&start_year=1991&end_year=2020&models=ERA5&month=${month}&daily=temperature_2m_mean`;
    const c = await fetch(climateUrl).then((r) => r.json());
    const tmean = c?.daily?.temperature_2m_mean?.[0];
    if (typeof tmean === "number") {
      const t = Math.round(tmean);
      const icon2 = t >= 24 ? "sunny" : t >= 10 ? "partly-sunny" : "cloudy";
      return { temp: t, icon: icon2 };
    }
    return null;
  } catch (e) {
    logError(reqId, "WEATHER_ERROR", e?.message || e);
    return null;
  }
}

/* ---------------------------- SERP TOOLS ----------------------------- */
// We keep the conversation natural; these run silently when needed.
// Note: serpapi@1.1.1 signature is getJson(engine, params)
async function serpFlights(params, reqId) {
  if (!hasSerpKey) return { error: "Flight search unavailable." };
  try {
    const response = await getJson("google_flights", {
      api_key: process.env.SERPAPI_API_KEY,
      hl: "en",
      gl: "us",
      currency: params.currency || "USD",
      departure_id: params.departure_airport,
      arrival_id: params.arrival_airport,
      outbound_date: params.departure_date,
      return_date: params.return_date,
    });
    const best = response.best_flights?.[0];
    if (!best) return { flights: [] };
    return {
      flights: [
        {
          price: best.price,
          airline: best.flights?.[0]?.airline,
          departure: `${best.flights?.[0]?.departure_airport?.name} (${best.flights?.[0]?.departure_airport?.id})`,
          arrival: `${best.flights?.[0]?.arrival_airport?.name} (${best.flights?.[0]?.arrival_airport?.id})`,
          total_duration: best.total_duration,
        },
      ],
    };
  } catch (e) {
    logError(reqId, "SERPAPI_FLIGHTS_ERROR", e?.message || e);
    return { error: "Could not retrieve flight information." };
  }
}

async function serpHotels(params, reqId) {
  if (!hasSerpKey) return { error: "Hotel search unavailable." };
  try {
    const response = await getJson("google_hotels", {
      api_key: process.env.SERPAPI_API_KEY,
      hl: "en",
      gl: "us",
      currency: params.currency || "USD",
      q: `hotels in ${params.location}`,
      check_in_date: params.check_in_date,
      check_out_date: params.check_out_date,
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
    logError(reqId, "SERPAPI_HOTELS_ERROR", e?.message || e);
    return { error: "Could not retrieve hotel information." };
  }
}

/* ---------------------------- OPENAI TOOLS --------------------------- */
/** We ask conversationally first; tools emit lightweight UI signals; no raw lists dumped. */
const tools = [
  // Slot-filling tools (UI asks)
  { type: "function", function: { name: "request_destination", description: "Ask which city/country the user wants to visit.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_dates", description: "Ask for start and end dates (YYYY-MM-DD).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_guests", description: "Ask for number of adults/children.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_departure", description: "Ask for departure city/airport (IATA if known).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_budget", description: "Ask for budget per person and currency.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_preferences", description: "Ask for style (relaxing/active/urban/beach), hotel type, interests.", parameters: { type: "object", properties: {} } } },

  // Real-data tools (silent usage)
  {
    type: "function",
    function: {
      name: "search_flights",
      description: "Look up flights via SerpAPI (silent). Do not dump results; summarize into plan later.",
      parameters: {
        type: "object",
        properties: {
          departure_airport: { type: "string" },
          arrival_airport: { type: "string" },
          departure_date: { type: "string" },
          return_date: { type: "string" },
          currency: { type: "string" },
        },
        required: ["departure_airport", "arrival_airport", "departure_date", "return_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_hotels",
      description: "Look up hotels via SerpAPI (silent). Do not dump results; summarize into plan later.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          check_in_date: { type: "string" },
          check_out_date: { type: "string" },
          currency: { type: "string" },
        },
        required: ["location", "check_in_date", "check_out_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Fetch weather summary for the start date (Open-Meteo).",
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

  // Finalizer
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Create the final plan only after all key slots are known (destination, dates, guests, budget, departure, preferences).",
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
            required: ["temp", "icon"],
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
        required: ["location", "country", "dateRange", "description", "image", "price", "weather", "itinerary", "costBreakdown"],
      },
    },
  },
];

/* --------------------------- SYSTEM PROMPT --------------------------- */
const getSystemPrompt = (profile) => `
You are an empathetic, world-class AI travel agent. Speak naturally and helpfully like a human concierge.

CORE PRINCIPLES
- CONVERSATION FIRST: Ask one friendly question at a time to fill missing info: destination, dates, guests, budget (amount & currency) per person, departure city/airport, and preferences (style, interests, hotel vibe).
- NO DUMPING: Do not list raw flights/hotels unless user asks. Use results silently to craft a plan.
- DATES: In the itinerary, use actual calendar dates (YYYY-MM-DD) and also a display field like "Oct 1".
- WEATHER: Always include a weather.summary for the start date using get_weather (icon ∈ {sunny, partly-sunny, cloudy} + average temp in °C).
- ITINERARY QUALITY: For EACH day, 3–5 concrete events with times, realistic venues/areas, breaks/meals, and intra-city transfers. Vary activities based on preferences.
- PROFILE ADAPTATION: Reflect user's profile in the plan; mention how it influenced choices in the description.
- FINALIZATION: Only call create_plan when all key slots are captured.

USER PROFILE:
${JSON.stringify(profile, null, 2)}
`;

/* ------------------------ MESSAGE NORMALIZATION ---------------------- */
function normalizeMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m.hidden) continue;
    if (m.role === "system") continue;
    const role = m.role === "assistant" || m.role === "ai" ? "assistant" : "user";
    out.push({ role, content: String(m.content ?? m.text ?? "") });
  }
  return out;
}

/* ------------------------------ ROUTE -------------------------------- */
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(
      reqId,
      `POST /chat/travel, user=${userId}, OpenAI=${hasOpenAIKey}, SerpAPI=${hasSerpKey}, fetch=${FETCH_SOURCE}, model=${OPENAI_MODEL}`
    );

    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasOpenAIKey || !client) {
      return res.status(500).json({ aiText: "The AI model is not configured." });
    }

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];

    // Agent loop (multi-step tool usage)
    const MAX_TURNS = 8;
    let loopMessages = [...convo];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: loopMessages,
        tools,
        tool_choice: "auto",
        temperature: 0.7,
      });

      const msg = completion.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls || [];

      // Handle tool calls
      if (toolCalls.length > 0) {
        // First, UI prompt tools (emit signals)
        for (const tc of toolCalls) {
          const fn = tc.function?.name;

          if (fn === "request_destination") {
            return res.json({
              aiText: msg.content || "Where would you like to go?",
              signal: { type: "destinationNeeded" },
              assistantMessage: { role: "assistant" },
            });
          }
          if (fn === "request_dates") {
            return res.json({
              aiText: msg.content || "What are your start and end dates?",
              signal: { type: "dateNeeded" },
              assistantMessage: { role: "assistant" },
            });
          }
          if (fn === "request_guests") {
            return res.json({
              aiText: msg.content || "How many adults and children are traveling?",
              signal: { type: "guestsNeeded" },
              assistantMessage: { role: "assistant" },
            });
          }
          if (fn === "request_departure") {
            return res.json({
              aiText: msg.content || "What city/airport are you departing from?",
              signal: { type: "departureNeeded" },
              assistantMessage: { role: "assistant" },
            });
          }
          if (fn === "request_budget") {
            return res.json({
              aiText: msg.content || "What’s your budget per person, and in which currency?",
              signal: { type: "budgetNeeded" },
              assistantMessage: { role: "assistant" },
            });
          }
          if (fn === "request_preferences") {
            return res.json({
              aiText:
                msg.content ||
                "What style do you want (relaxing, active, urban, beach)? Any interests or hotel vibe?",
              signal: { type: "preferencesNeeded" },
              assistantMessage: { role: "assistant" },
            });
          }
        }

        // If not a UI tool, we run back-end tools and feed results back to the model.
        // Add assistant tool-call marker so the model sees its own request
        loopMessages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: tc.function,
          })),
        });

        for (const tc of toolCalls) {
          const fn = tc.function?.name;
          const rawArgs = tc.function?.arguments || "{}";
          let args = {};
          try {
            args = JSON.parse(rawArgs);
          } catch (e) {
            logError(reqId, `Bad tool args for ${fn}`, rawArgs);
          }

          // Execute
          let result = null;
          if (fn === "search_flights") {
            result = await serpFlights(args, reqId);
          } else if (fn === "search_hotels") {
            result = await serpHotels(args, reqId);
          } else if (fn === "get_weather") {
            result = await fetchWeatherSummary(args.location, args.start_date, reqId);
          } else if (fn === "create_plan") {
            // Post-process server-side: enforce dates & day labels; ensure weather; add hero image.
            const { dateRange, location } = args || {};
            let start = null, end = null;
            if (dateRange && /to/i.test(dateRange)) {
              const [a, b] = dateRange.split(/to/i).map((s) => s.trim());
              start = parseISO(a);
              end = parseISO(b);
            }
            const image = await pickPhoto(location, reqId);

            // Ensure weather present (or try fetch)
            let weather = args.weather;
            if (!weather || typeof weather.temp !== "number" || !["sunny", "partly-sunny", "cloudy"].includes(weather.icon)) {
              if (start) {
                const w = await fetchWeatherSummary(location, fmtYMD(start), reqId);
                if (w) weather = w;
              }
              if (!weather) weather = { temp: 22, icon: "partly-sunny" }; // graceful default
            }

            // Normalize itinerary dates/days
            let itinerary = Array.isArray(args.itinerary) ? args.itinerary : [];
            if (start && end && itinerary.length) {
              const days = expandDateRangeToDates(fmtYMD(start), fmtYMD(end));
              // If model returned "Day 1" etc., align with real dates
              for (let i = 0; i < itinerary.length && i < days.length; i++) {
                itinerary[i].date = days[i].date;
                itinerary[i].day = days[i].day; // e.g., "Oct 1"
              }
            } else {
              // If no dates, still ensure correct display shape
              itinerary = itinerary.map((d) => ({
                ...d,
                date: d.date || fmtYMD(new Date()),
                day: d.day || shortMonthDay(new Date()),
              }));
            }

            const payload = {
              ...args,
              image,
              weather,
              itinerary,
            };

            return res.json({
              aiText: "Here’s your personalized travel plan!",
              signal: { type: "planReady", payload },
            });
          }

          // Feed tool result back to model (if not finalized already)
          loopMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result ?? {}),
          });
        }

        // Continue next turn (model will incorporate tool outputs)
        continue;
      }

      // No tools called → just say what the assistant said
      const finalText = msg?.content?.trim();
      if (finalText) return res.json({ aiText: finalText });

      // Safety net
      return res.json({
        aiText:
          "Could you share a bit more—destination, dates, guests, budget, and departure city—so I can craft a perfect plan?",
      });
    }

    logError(reqId, "Agent loop exceeded max turns.");
    return res.status(500).json({
      aiText:
        "I'm having trouble creating the plan right now. Could you share one detail at a time (destination, dates, guests, budget, departure)?",
    });
  } catch (err) {
    logError(reqId, "Critical handler error:", err);
    return res.status(500).json({ aiText: "A critical server error occurred. Please try again." });
  }
});

export default router;
