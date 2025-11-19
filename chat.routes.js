// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// Optional: catch unhandled promise rejections globally (very useful in dev)
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED PROMISE REJECTION]", reason);
});

// --- 1. SETUP ---
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

const router = Router();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const SERPAPI_KEY = process.env.SERPAPI_API_KEY;

// --- 2. HELPERS ---
const newReqId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

const userMem = new Map();
const imageCache = new Map();

const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        origin_city: null,
        nationality: null,
        preferred_travel_type: [],
        interests: [],
        budget: { level: "balanced" }, // "budget" | "balanced" | "luxury"
      },
    });
  }
  return userMem.get(userId);
};

// Extract profile info from conversation (very lightweight)
function updateProfileFromHistory(messages, mem) {
  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  if (!lastUserMsg) return;
  const text = (lastUserMsg.text || lastUserMsg.content || "").toLowerCase();

  // Origin: "from X to Y", "flying from X", "leaving from X"
  const fromMatch =
    text.match(/from\s+([a-z\s]+?)(?:\s+to|\s+on|,|\.|$)/) ||
    text.match(/flying\s+from\s+([a-z\s]+?)(?:\s+to|\s+on|,|\.|$)/) ||
    text.match(/leaving\s+from\s+([a-z\s]+?)(?:\s+to|\s+on|,|\.|$)/);
  if (fromMatch && fromMatch[1]) {
    mem.profile.origin_city = fromMatch[1].trim();
  }

  // Nationality / passport
  const nationalityMatch =
    text.match(/i[' ]?m\s+([a-z\s]+?)\s+citizen/) ||
    text.match(/i\s+have\s+a\s+([a-z\s]+?)\s+passport/) ||
    text.match(/my\s+passport\s+is\s+([a-z\s]+)/);
  if (nationalityMatch && nationalityMatch[1]) {
    mem.profile.nationality = nationalityMatch[1].trim();
  }

  // Very rough budget hints
  if (text.includes("cheap") || text.includes("low budget")) {
    mem.profile.budget.level = "budget";
  } else if (
    text.includes("luxury") ||
    text.includes("5 star") ||
    text.includes("five star")
  ) {
    mem.profile.budget.level = "luxury";
  }

  // Very rough interest tags
  const interests = [];
  if (text.includes("beach") || text.includes("island")) interests.push("beaches");
  if (text.includes("nightlife") || text.includes("party"))
    interests.push("nightlife");
  if (text.includes("museum") || text.includes("history"))
    interests.push("culture");
  if (text.includes("hike") || text.includes("trek") || text.includes("nature"))
    interests.push("nature");

  if (interests.length) {
    const existing = new Set(mem.profile.interests || []);
    interests.forEach((i) => existing.add(i));
    mem.profile.interests = Array.from(existing);
  }
}

// --- 3. EXTERNAL APIS ---

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
    if (data.results?.[0]?.urls?.regular) {
      const img = data.results[0].urls.regular;
      imageCache.set(cacheKey, img);
      return img;
    }
    return FALLBACK_IMAGE_URL;
  } catch (e) {
    logError(reqId, "Unsplash Error", e?.message);
    return FALLBACK_IMAGE_URL;
  }
}

// Generic travel-related search with SerpAPI
async function performGoogleSearch(query, reqId) {
  if (!SERPAPI_KEY) return "Search skipped (No API Key).";
  logInfo(reqId, `[SEARCH] "${query}"`);

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    query
  )}&api_key=${SERPAPI_KEY}&num=10`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const snippets = [];

    // Answer box / knowledge graph
    if (data.answer_box) {
      snippets.push(`AnswerBox: ${JSON.stringify(data.answer_box)}`);
    }
    if (data.knowledge_graph) {
      snippets.push(`KnowledgeGraph: ${JSON.stringify(data.knowledge_graph)}`);
    }

    // Flights (if present)
    if (data.flights_results) {
      snippets.push(
        `FlightsResults: ${JSON.stringify(
          data.flights_results.slice(0, 5)
        )}`
      );
    }

    // Hotels (if present)
    if (data.hotels_results) {
      snippets.push(
        `HotelsResults: ${JSON.stringify(
          data.hotels_results.slice(0, 5)
        )}`
      );
    }

    // Local results (restaurants, attractions, activities)
    if (data.local_results) {
      const places =
        data.local_results.places?.slice(0, 8) || data.local_results.slice(0, 8);
      snippets.push(`LocalResults: ${JSON.stringify(places)}`);
    }

    // Shopping / tickets / tours
    if (data.shopping_results && data.shopping_results.length) {
      snippets.push(
        `Shopping: ${JSON.stringify(
          data.shopping_results.slice(0, 6).map((s) => ({
            title: s.title,
            price: s.price,
            source: s.source,
          }))
        )}`
      );
    }

    // Organic results
    if (data.organic_results) {
      data.organic_results.slice(0, 8).forEach((r) => {
        const snip = r.snippet || r.title || "";
        snippets.push(`Organic: ${r.title}: ${snip}`);
      });
    }

    const result = snippets.join("\n");
    logInfo(reqId, `[SEARCH RESULT] Payload length: ${result.length}`);
    return result || "No details found.";
  } catch (e) {
    logError(reqId, "SerpApi Error", e);
    return "Search failed.";
  }
}

// --- 4. TOOLS ---
const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description:
        "MANDATORY: In trip-planning mode, if the user has NOT specified exact or approximate travel dates, you MUST call this tool immediately instead of asking via text. The UI will show a date picker.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description:
        "MANDATORY: In trip-planning mode, if the user has NOT specified how many people are traveling, you MUST call this tool instead of asking via text. The UI will show a guest picker.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description:
        "Search the web (real data via SerpAPI). Use this for: flight prices, hotel costs, typical trip budgets, visa requirements, safety, best time to visit, weather, local attractions, activities, and restaurants. " +
        "For pricing, ALWAYS include origin, destination, and dates when known in the query. For visa, include nationality and destination country. You are allowed to call this multiple times per trip for more realism.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Concrete search query, e.g. 'Round trip flight Berlin to Dubai 12-19 March 2025 price Emirates Qatar Turkish' or 'visa requirements German citizen to Thailand 2025'.",
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
        "Generate the final JSON plan for a specific trip, using realistic price estimates based on the search results you have already seen.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string" },
          description: { type: "string" },
          price: {
            type: "number",
            description:
              "Total realistic trip cost per booking (including flights, hotels, and core activities) based on web results, not random guesses.",
          },
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
                  description: "YYYY-MM-DD",
                },
                day: {
                  type: "string",
                  description:
                    "STRICT FORMAT: 'MMM DD' (e.g., 'Nov 20', 'Oct 05'). FORBIDDEN: 'Friday', 'Day 1', 'Saturday'.",
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
                price: {
                  type: "number",
                  description:
                    "Realistic numeric price, inspired by web search results (e.g., flight, hotel, activity cost).",
                },
                iconType: { type: "string", enum: ["image", "date"] },
                iconValue: { type: "string" },
              },
              required: [
                "item",
                "provider",
                "details",
                "price",
                "iconType",
                "iconValue",
              ],
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

// --- 5. SYSTEM PROMPT ---
const getSystemPrompt = (profile) => `
You are a strict, logic-driven Travel Agent that helps the user plan and price trips realistically.
You can operate in two modes: TRIP PLANNING mode and INFO mode.

==================================================
CORE MEMORY
==================================================
- Origin city (if known): ${profile.origin_city || "UNKNOWN"}
- Nationality (if known): ${profile.nationality || "UNKNOWN"}
- Budget level: ${profile.budget?.level || "balanced"}
- Interests: ${(profile.interests || []).join(", ") || "none stored"}

==================================================
GENERAL RULES
==================================================
1. If the user is clearly asking to PLAN or PRICE a trip (e.g. "plan a trip", "how much would it cost to go to...", "book for me"), you are in TRIP PLANNING mode.
2. If the user only asks for information (e.g. "Do I need a visa for X?", "Is Y safe?"), you are in INFO mode.

3. You MUST ask short, high-value clarifying questions if they are missing and relevant:
   - Origin city (only if not in memory): "Where will you be traveling from?"
   - Nationality (for visas): "What nationality is your passport?"
   - Budget level: "Do you prefer budget, balanced, or luxury options?"
   - Interests: "What are you into on this trip: beaches, nightlife, food, culture, nature, or something else?"
   Keep questions concise and focused. Ask them as simple, single questions, not huge paragraphs.

4. DATES and GUEST COUNT are SPECIAL and handled by tools ONLY:
   - You are FORBIDDEN to ask about dates or guest counts via text questions.
   - Do NOT write things like "When do you want to travel?" or "How many people are coming?".
   - Instead, use the tools below.

==================================================
TRIP PLANNING MODE
==================================================
You are in trip planning mode when the user wants a plan, an estimate, or a booking-style proposal.

STEP 1: CHECK REQUIRED INFO
- Destination: If destination is unclear, ask a brief clarifying question.
- Origin:
  - If an origin city is available in memory, use it.
  - If not, ask: "Where will you be traveling from?"
- Nationality: If the user mentions visas or if destination likely has visa requirements, ask for nationality.
- Budget & Interests: Ask simple, single-sentence questions if missing.

STEP 2: USE TOOLS FOR DATES & GUESTS (NO TEXT QUESTIONS)
- Check: Do I know the travel dates? Do I know the guest count?
- If travel DATES are missing => IMMEDIATELY call \`request_dates\`. DO NOT ask via text.
- If GUEST COUNT is missing => IMMEDIATELY call \`request_guests\`. DO NOT ask via text.
- NEVER combine date and guest questions into a text message. They are handled by tools only.

STEP 3: MAXIMUM-REALISM RESEARCH
Once you know:
  - destination, AND
  - origin, AND
  - dates, AND
  - guest count
you SHOULD call \`search_google\` MULTIPLE TIMES to get REALISTIC data (flights, hotels, activities, restaurants, visa, safety, weather, typical daily costs).
Group related information where possible; don't spam the tool unnecessarily.

STEP 4: PLAN CREATION (REAL ENTITIES)
After getting enough search results for pricing and concrete options:
- Do NOT summarize the search results in plain text first.
- IMMEDIATELY call \`create_plan\`.
- In \`create_plan\`, base all prices (total and breakdown) on the numbers and ranges you saw in the search results.
  - If you see multiple different prices, pick realistic mid-range values.
  - DO NOT invent completely random numbers without grounding them in search snippets.

- Total cost (\`price\`) = flights + hotels + core activities (for the full trip).

Date format in the itinerary:
- \`date\`: "YYYY-MM-DD"
- \`day\`: STRICT "MMM DD" (e.g. "Nov 20", "Oct 05"), NEVER "Friday" or "Day 1".

==================================================
REAL-WORLD ITINERARY REQUIREMENTS (MANDATORY)
==================================================
All itinerary items MUST reference **real, verifiable-sounding** entities. 
Generic items are FORBIDDEN.

Flights:
- MUST use a real airline name.
- MUST include a flight number that looks real (e.g. EK134, QR906, TK246).
- MUST include a departure airport code (IATA) and arrival airport code.
- Example title: "Flight EK134 from DME (Moscow Domodedovo) to MLE (Velana International)"
- In details, mention approximate departure and arrival time and duration.

Hotels:
- MUST choose a real hotel name, preferably one that appears in search results.
- MUST include hotel category (e.g., "4★" or "5★").
- Example: "Check in at Ocean Grand Hulhumale (4★)".

Activities:
- MUST reference real tours, real operators, or real attractions.
- Example: "Snorkeling excursion with Secret Paradise Maldives (group tour)".

Restaurants / Food:
- MUST include real restaurant or venue names.
- Example: "Dinner at Seagull Café House, Malé".

Forbidden (do NOT use as titles or details):
- "Stay at a midrange hotel"
- "Flight from A to B"
- "Beach day"
- "Explore the city"
- "Eat local food"
- "Nice restaurant"
- "Generic activity"

All items must follow strict formatting:
- **Itinerary.day**: "MMM DD"
- **Itinerary.date**: "YYYY-MM-DD"
- Every event must have: type, icon, time, duration, title, details.

==================================================
INFO MODE
==================================================
If the user is NOT asking for a custom trip plan/price but only for information (visa, safety, where to go, etc.):

1. For anything factual and travel-related (visa, safety, best time to visit, typical costs, entry rules, etc.),
   you SHOULD call \`search_google\` with a specific query first.
2. Then, answer the user in clear text, grounded in the search results.
3. In INFO mode, do NOT call \`create_plan\`.

==================================================
FRONTEND INTEGRATION
==================================================
- The frontend relies on:
  - \`request_dates\` => triggers date picker.
  - \`request_guests\` => triggers guest picker.
  - \`create_plan\` => sends structured JSON plan and cost breakdown.
- If you break the rules about dates/guests and ask them via text, THE APP WILL BREAK.
  Therefore, ALWAYS use the tools for dates and guest counts.
`;

// --- 6. ROUTE HANDLER ---
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

      let content = m.content ?? m.text ?? "";
      if (m.role === "plan" || (m.role === "assistant" && m.payload)) {
        content = "[Previous Plan Created]";
      }

      const role =
        m.role === "ai" ? "assistant" : m.role === "plan" ? "assistant" : m.role;

      return { role, content: String(content) };
    });
}

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey) {
      return res.json({ aiText: "Service Unavailable" });
    }

    const runConversation = async (history, depth = 0) => {
      try {
        if (depth > 8) {
          logError(reqId, "Max depth exceeded");
          return {
            aiText:
              "I'm having trouble finalizing your trip. Please try adjusting your request or starting again.",
          };
        }

        const completion = await client.chat.completions.create({
          model: "gpt-4o", // upgrade here when you move to GPT-5.1
          messages: history,
          tools,
          tool_choice: "auto",
          temperature: 0.2,
        });

        const msg = completion.choices[0].message;

        // TOOL CALLS
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const tool = msg.tool_calls[0];
          const name = tool.function.name;

          // SAFE JSON PARSE
          let args = {};
          try {
            const raw = tool.function.arguments || "{}";
            args = typeof raw === "string" ? JSON.parse(raw) : raw || {};
          } catch (e) {
            logError(
              reqId,
              "[JSON PARSE ERROR]",
              e?.message,
              tool.function.arguments
            );
            // Don't crash; tell frontend something went wrong
            return {
              aiText:
                "I ran into a formatting issue while building your plan. Please rephrase your request slightly and try again.",
            };
          }

          logInfo(reqId, `[Tool] ${name}`, args);

          // 1. SEARCH -> Recurse immediately (No UI text yet)
          if (name === "search_google") {
            const result = await performGoogleSearch(args.query, reqId);
            const newHistory = [
              ...history,
              msg,
              { role: "tool", tool_call_id: tool.id, content: result },
            ];
            return runConversation(newHistory, depth + 1);
          }

          // 2. UI SIGNALS -> Return to Frontend
          if (name === "request_dates") {
            return {
              aiText: "Please choose your travel dates.",
              signal: { type: "dateNeeded" },
              assistantMessage: msg,
            };
          }

          if (name === "request_guests") {
            return {
              aiText: "Please specify how many people are traveling.",
              signal: { type: "guestsNeeded" },
              assistantMessage: msg,
            };
          }

          // 3. PLAN -> Sanitize & Return
          if (name === "create_plan") {
            try {
              // Normalize arrays
              if (!Array.isArray(args.itinerary)) args.itinerary = [];
              if (!Array.isArray(args.costBreakdown)) args.costBreakdown = [];

              // Defensive itinerary sanitization
              for (const day of args.itinerary) {
                if (!day || !Array.isArray(day.events)) continue;

                for (const ev of day.events) {
                  if (!ev || typeof ev.title !== "string") continue;

                  const t = ev.title.toLowerCase();
                  const d = (ev.details || "").toLowerCase();

                  const isGeneric =
                    t.includes("midrange hotel") ||
                    t.includes("hotel in") ||
                    t.includes("flight from") ||
                    t.includes("beach day") ||
                    t.includes("explore the city") ||
                    t.includes("nice restaurant") ||
                    t.includes("local food") ||
                    t.includes("generic activity") ||
                    d.includes("midrange hotel") ||
                    d.includes("hotel in") ||
                    d.includes("flight from") ||
                    d.includes("beach day") ||
                    d.includes("explore the city") ||
                    d.includes("nice restaurant") ||
                    d.includes("local food") ||
                    d.includes("generic activity");

                  if (isGeneric) {
                    ev.title =
                      "INVALID_GENERIC_EVENT — PLEASE REGENERATE WITH REAL NAMES";
                  }
                }
              }
            } catch (e) {
              logError(reqId, "[SANITIZE ERROR]", e?.message, args);
              // Do not fail the whole request because of one bad event
            }

            // Ensure image
            try {
              args.image = await pickPhoto(args.location, reqId);
            } catch (e) {
              logError(reqId, "[IMAGE PICK ERROR]", e?.message);
              args.image = FALLBACK_IMAGE_URL;
            }

            // Fallback weather
            if (!args.weather || typeof args.weather !== "object") {
              args.weather = { temp: 25, icon: "sunny" };
            } else if (!args.weather.icon) {
              args.weather.icon = "sunny";
            }

            // Fallback core fields
            if (typeof args.price !== "number" || Number.isNaN(args.price)) {
              args.price = 0;
            }
            if (!args.location) args.location = "Destination";
            if (!args.country) args.country = "Unknown";
            if (!args.dateRange) args.dateRange = "Dates not specified";
            if (!args.description) {
              args.description = `Trip to ${args.location}`;
            }

            return {
              aiText: `I've prepared a trip plan to ${args.location} with an estimated total cost of $${args.price}.`,
              signal: { type: "planReady", payload: args },
              assistantMessage: msg,
            };
          }
        }

        // TEXT-ONLY RESPONSE HANDLING
        let text = msg.content || "";

        // Safety net: intercept date/guest text questions and convert to signals
        const lower = text.toLowerCase();
        const asksDates =
          lower.includes("when") &&
          (lower.includes("travel") ||
            lower.includes("trip") ||
            lower.includes("go"));
        const asksGuests =
          lower.includes("how many") &&
          (lower.includes("people") || lower.includes("guests"));

        if (asksDates) {
          logInfo(
            reqId,
            "[Guardrail] Intercepted text question about dates. Triggering request_dates signal."
          );
          return {
            aiText: "Please choose your travel dates.",
            signal: { type: "dateNeeded" },
            assistantMessage: msg,
          };
        }

        if (asksGuests) {
          logInfo(
            reqId,
            "[Guardrail] Intercepted text question about guests. Triggering request_guests signal."
          );
          return {
            aiText: "Please specify how many people are traveling.",
            signal: { type: "guestsNeeded" },
            assistantMessage: msg,
          };
        }

        // Otherwise this is a normal clarifying / info response
        return { aiText: text };
      } catch (err) {
        logError(reqId, "[runConversation ERROR]", err);
        // Do NOT throw here; return a safe response instead of 500
        return {
          aiText:
            "I ran into an internal issue while building your trip. Please tweak your request slightly and try again.",
        };
      }
    };

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [
      { role: "system", content: systemPrompt },
      ...normalizeMessages(messages),
    ];

    const response = await runConversation(convo);
    res.json(response);
  } catch (err) {
    logError(reqId, "[ROUTE ERROR]", err);
    res.status(500).json({ aiText: "System error." });
  }
});

export default router;
