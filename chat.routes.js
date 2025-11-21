// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// -----------------------------------------------------------------------------
// GLOBAL ERROR HANDLING
// -----------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED PROMISE REJECTION]", reason);
});

// -----------------------------------------------------------------------------
// FETCH POLYFILL
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// BASIC SETUP
// -----------------------------------------------------------------------------
const router = Router();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const SERPAPI_KEY = process.env.SERPAPI_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

const newReqId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (id, ...args) => console.log(`[chat][${id}]`, ...args);
const logError = (id, ...args) => console.error(`[chat][${id}]`, ...args);

// -----------------------------------------------------------------------------
// MEMORY STORE
// -----------------------------------------------------------------------------
const userMem = new Map();
const imageCache = new Map();

function getMem(userId) {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        origin_city: null,
        nationality: null,
        budget: "balanced",
        interests: [],
      },
    });
  }
  return userMem.get(userId);
}

// -----------------------------------------------------------------------------
// PROFILE UPDATER (LIGHTWEIGHT)
// -----------------------------------------------------------------------------
function updateProfileFromHistory(messages, mem) {
  const last = messages.filter((m) => m.role === "user").pop();
  if (!last) return;

  const text = (last.text || last.content || "").toLowerCase();
  const profile = mem.profile;

  const from =
    text.match(/from\s+([a-z\s]+?)(?:\s+to|\s+on|,|\.|$)/) ||
    text.match(/flying\s+from\s+([a-z\s]+?)(?:\s+to|\s+on|,|\.|$)/);
  if (from && from[1]) profile.origin_city = from[1].trim();

  const nat =
    text.match(/i[' ]?m\s+([a-z\s]+?)\s+citizen/) ||
    text.match(/passport\s+is\s+([a-z\s]+)/);
  if (nat && nat[1]) profile.nationality = nat[1].trim();

  if (text.includes("cheap") || text.includes("budget")) profile.budget = "budget";
  if (text.includes("luxury") || text.includes("5 star")) profile.budget = "luxury";

  const interests = [];
  if (text.includes("beach")) interests.push("beaches");
  if (text.includes("nightlife")) interests.push("nightlife");
  if (text.includes("museum") || text.includes("history"))
    interests.push("culture");
  if (text.includes("hike") || text.includes("nature")) interests.push("nature");

  if (interests.length) {
    const set = new Set(profile.interests || []);
    interests.forEach((i) => set.add(i));
    profile.interests = [...set];
  }
}

// -----------------------------------------------------------------------------
// UNSPLASH IMAGE PICKER
// -----------------------------------------------------------------------------
const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&q=80";

async function pickPhoto(dest, reqId) {
  const key = dest.toLowerCase().trim();
  if (imageCache.has(key)) return imageCache.get(key);
  if (!UNSPLASH_ACCESS_KEY) return FALLBACK_IMAGE_URL;

  const q = encodeURIComponent(`${dest} skyline landmark`);
  const url = `https://api.unsplash.com/search/photos?query=${q}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
    const json = await res.json();
    const img = json?.results?.[0]?.urls?.regular || FALLBACK_IMAGE_URL;
    imageCache.set(key, img);
    return img;
  } catch (e) {
    logError(reqId, "[Unsplash error]", e);
    return FALLBACK_IMAGE_URL;
  }
}

// -----------------------------------------------------------------------------
// SERPAPI SEARCH — REAL DATA
// -----------------------------------------------------------------------------
async function performGoogleSearch(query, reqId) {
  if (!SERPAPI_KEY) {
    return "Search skipped (no SERPAPI_KEY).";
  }

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    query
  )}&api_key=${SERPAPI_KEY}&num=10`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    const out = [];

    if (data.answer_box) out.push(`AnswerBox: ${JSON.stringify(data.answer_box)}`);
    if (data.knowledge_graph)
      out.push(`KnowledgeGraph: ${JSON.stringify(data.knowledge_graph)}`);

    if (data.local_results) {
      const places =
        data.local_results.places?.slice(0, 8) || data.local_results.slice(0, 8);
      out.push(`Local: ${JSON.stringify(places)}`);
    }

    if (data.flights_results) {
      out.push(
        `Flights: ${JSON.stringify(data.flights_results.slice(0, 5) || [])}`
      );
    }

    if (data.organics_results) {
      data.organic_results?.slice(0, 6).forEach((o) =>
        out.push(`Organic: ${o.title}: ${o.snippet || ""}`)
      );
    }

    return out.join("\n") || "No details found.";
  } catch (e) {
    logError(reqId, "[SerpAPI error]", e);
    return "Search failed.";
  }
}

// -----------------------------------------------------------------------------
// TOOLS
// -----------------------------------------------------------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description:
        "MANDATORY: trigger the date picker. NEVER ask for dates via text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description:
        "MANDATORY: trigger the guest picker. NEVER ask guest count via text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description: "Search SerpAPI for real data.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Send final trip plan JSON to frontend.",
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
                date: { type: "string", description: "YYYY-MM-DD" },
                day: {
                  type: "string",
                  description: "Format: 'Nov 20'",
                },
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
                    required: [
                      "type",
                      "icon",
                      "time",
                      "duration",
                      "title",
                      "details",
                    ],
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
  },
];

// -----------------------------------------------------------------------------
// FORMATTERS
// -----------------------------------------------------------------------------
function formatToMMMDD(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const month = d
    .toLocaleString("en-US", { month: "short" })
    .replace(/^\w/, (c) => c.toUpperCase());
  const day = String(d.getDate()).padStart(2, "0");
  return `${month} ${day}`;
}

function normalizeMessages(messages = []) {
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      const role =
        m.role === "ai"
          ? "assistant"
          : m.role === "plan"
          ? "assistant"
          : m.role;

      let content = m.content ?? m.text ?? "";
      if (role === "assistant" && m.payload) {
        content = "[Previous Trip Plan]";
      }

      return { role, content: String(content) };
    });
}

// -----------------------------------------------------------------------------
// SYSTEM PROMPT — STRICT BEHAVIOR, REAL ITINERARIES, SHORT MESSAGES
// -----------------------------------------------------------------------------
function getSystemPrompt(profile) {
  return `
You are a **STRICT TRAVEL AGENT**.

==================================================
CONVERSATION STYLE
==================================================
- NEVER send long paragraphs.  
- Respond in **small, WhatsApp-sized messages**.  
- 1–3 short sentences MAX unless using a tool.  
- NEVER dump large chunks of info.  
- When unsure, ask **one short question at a time**.

==================================================
DATES & GUESTS — TOOL ONLY
==================================================
- NEVER ask for dates via text.  
- NEVER ask for guest count via text.  
- ALWAYS call request_dates or request_guests.

==================================================
ITINERARY RULES (MANDATORY)
==================================================
You must produce itineraries like this:

date: "2025-03-10"  
day: "Mar 10"  
events:
  - type: "activity"
    icon: "🎟️"
    time: "09:00"
    duration: "2h"
    title: "Louvre Museum — Skip-the-Line"
    details: "Guided tour booked via ParisCityVision"

STRICT REQUIREMENTS:
- Day format MUST be like: **"Nov 20"**  
- NO weekday names.  
- NO "Day 1".  
- ALL events must have:
  - real business names (restaurants, tours, hotels)
  - real attractions
  - real tours
  - realistic times & durations
- NO generic items EVER:
  - "explore city"
  - "nice restaurant"
  - "midrange hotel"
  - "beach day"
  - "generic activity"

==================================================
SEARCH USAGE
==================================================
Before creating a plan:
- Call search_google for real data (hotels, restaurants, activities, flights).  
- Base itinerary events on real search results.

==================================================
MEMORY
==================================================
Origin: ${profile.origin_city || "unknown"}  
Nationality: ${profile.nationality || "unknown"}  
Budget: ${profile.budget}  
Interests: ${(profile.interests || []).join(", ") || "none"}  

==================================================
FRONTEND BEHAVIOR
==================================================
- request_dates → triggers date picker  
- request_guests → triggers guest picker  
- create_plan → sends complete JSON to app  
`;
}

// -----------------------------------------------------------------------------
// MAIN ROUTE — /travel
// -----------------------------------------------------------------------------
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body;
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey) {
      return res.json({ aiText: "Service temporarily unavailable." });
    }

    const systemPrompt = getSystemPrompt(mem.profile);

    const run = async (history, depth = 0) => {
      if (depth > 8) {
        return { aiText: "I’m having trouble completing this plan." };
      }

      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: history,
        tools,
        tool_choice: "auto",
        temperature: 0.2,
      });

      const msg = completion.choices[0].message;

      // ------------------ TOOL CALLS -----------------------
      if (msg.tool_calls?.length) {
        const tool = msg.tool_calls[0];
        const name = tool.function.name;

        let args = {};
        try {
          args = JSON.parse(tool.function.arguments || "{}");
        } catch (e) {
          return {
            aiText: "I hit a formatting issue. Please rephrase your request.",
          };
        }

        // search_google
        if (name === "search_google") {
          const result = await performGoogleSearch(args.query, reqId);
          return run(
            [
              ...history,
              msg,
              { role: "tool", tool_call_id: tool.id, content: result },
            ],
            depth + 1
          );
        }

        // date picker
        if (name === "request_dates") {
          return {
            aiText: "Pick your travel dates.",
            signal: { type: "dateNeeded" },
            assistantMessage: msg,
          };
        }

        // guest picker
        if (name === "request_guests") {
          return {
            aiText: "How many people are going?",
            signal: { type: "guestsNeeded" },
            assistantMessage: msg,
          };
        }

        // create_plan
        if (name === "create_plan") {
          // Validate itinerary
          try {
            for (const day of args.itinerary || []) {
              day.day = formatToMMMDD(day.date);

              for (const ev of day.events || []) {
                const t = ev.title.toLowerCase();
                const d = ev.details.toLowerCase();

                const bad =
                  t.includes("generic") ||
                  t.includes("restaurant") && !ev.title.includes(" ") ||
                  t.includes("beach day") ||
                  t.includes("explore") ||
                  t.includes("hotel") && !t.includes("★") ||
                  d.includes("generic") ||
                  d.includes("restaurant") && ev.details.split(" ").length < 2;

                if (bad) {
                  ev.title =
                    "INVALID_GENERIC_EVENT — Please regenerate with real names";
                }
              }
            }
          } catch (e) {}

          // Attach image
          args.image = await pickPhoto(args.location, reqId);

          // Normalize weather
          if (!args.weather) args.weather = { temp: 24, icon: "sunny" };

          return {
            aiText: `Your trip plan to ${args.location} is ready.`,
            signal: { type: "planReady", payload: args },
            assistantMessage: msg,
          };
        }
      }

      // ------------------ NORMAL TEXT -----------------------
      let text = msg.content || "";

      // Anti-dump: shorten long assistant replies
      if (text.length > 320) {
        text = text.slice(0, 300) + "…";
      }

      return { aiText: text };
    };

    const response = await run([
      { role: "system", content: systemPrompt },
      ...normalizeMessages(messages),
    ]);

    res.json(response);
  } catch (err) {
    logError(reqId, "[ROUTE ERROR]", err);
    res.status(500).json({ aiText: "Internal server error." });
  }
});

export default router;
