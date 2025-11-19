// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

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
        preferred_travel_type: [], // e.g. "backpacking", "luxury"
        interests: [], // e.g. "beaches", "nightlife"
        budget: { level: "balanced" }, // "budget" | "balanced" | "luxury"
      },
    });
  }
  return userMem.get(userId);
};

// Extract profile info from conversation (very lightweight, safe)
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
  )}&api_key=${SERPAPI_KEY}&num=8`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const snippets = [];

    // Price boxes / answer boxes (often contain more structured info)
    if (data.answer_box) {
      snippets.push(`AnswerBox: ${JSON.stringify(data.answer_box)}`);
    }
    if (data.shopping_results && data.shopping_results.length) {
      snippets.push(
        `Shopping: ${JSON.stringify(
          data.shopping_results.slice(0, 3).map((s) => ({
            title: s.title,
            price: s.price,
            source: s.source,
          }))
        )}`
      );
    }

    // Organic results – short, price-related if possible
    if (data.organic_results) {
      data.organic_results.slice(0, 5).forEach((r) => {
        const snip = r.snippet || r.title || "";
        snippets.push(`- ${r.title}: ${snip}`);
      });
    }

    const result = snippets.join("\n");
    logInfo(reqId, `[SEARCH RESULT] Found data.`);
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
        "Search the web (real data via SerpAPI). Use this for: flight prices, hotel costs, typical trip budgets, visa requirements, safety, best time to visit, weather, and local attractions. " +
        "For pricing, ALWAYS include origin, destination, and dates when known in the query. For visa, include nationality and destination country.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Concrete search query, e.g. 'Round trip flight Berlin to Dubai 12-19 March 2025 price' or 'visa requirements German citizen to Thailand 2025'.",
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
                // STRICT DATE FORMATTING INSTRUCTION
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
   Keep questions concise and focused.

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

STEP 3: REALISTIC RESEARCH (PRICE + VISA + SAFETY)
Once you know:
  - destination, AND
  - origin, AND
  - dates, AND
  - guest count
you MUST call \`search_google\` to get REALISTIC pricing data.

For pricing use queries like:
  - "round trip flight [ORIGIN] to [DESTINATION] [DATES] price per person"
  - "hotel [DESTINATION] [DATES] average nightly price for [guest count] people"
Optionally:
  - "average daily cost in [DESTINATION] for [budget level] traveler"
  - "popular paid activities in [DESTINATION] with prices"

If visas or safety were mentioned, call \`search_google\` for:
  - "visa requirements [NATIONALITY] citizen to [COUNTRY] 2025"
  - "is [DESTINATION] safe for tourists 2025"

You can call \`search_google\` multiple times if needed, but keep it efficient.

STEP 4: PLAN CREATION
After getting enough search results for pricing:
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

    if (!hasKey) return res.json({ aiText: "Service Unavailable" });

    // Recursive Agent Loop (Max 4 turns to allow: tool -> search -> plan)
    const runConversation = async (history, depth = 0) => {
      if (depth > 4) return { aiText: "I'm working on your trip details..." };

      const completion = await client.chat.completions.create({
        model: "gpt-4o", // you can upgrade this model name when you switch to GPT-5.1
        messages: history,
        tools,
        tool_choice: "auto",
        temperature: 0.2, // low, but not zero, to allow robust reasoning
      });

      const msg = completion.choices[0].message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // We only handle one tool call at a time to keep control simple
        const tool = msg.tool_calls[0];
        const name = tool.function.name;
        const args =
          typeof tool.function.arguments === "string"
            ? JSON.parse(tool.function.arguments || "{}")
            : tool.function.arguments || {};

        logInfo(reqId, `[Tool] ${name}`, args);

        // 1. SEARCH -> Recurse immediately (Don't talk to user yet)
        if (name === "search_google") {
          const result = await performGoogleSearch(args.query, reqId);
          const newHistory = [
            ...history,
            msg,
            { role: "tool", tool_call_id: tool.id, content: result },
          ];
          // Recurse: The AI sees the result and may call create_plan or answer text
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
          // Ensure image
          args.image = await pickPhoto(args.location, reqId);
          // Fallback weather
          if (!args.weather || !args.weather.icon) {
            args.weather = { temp: 25, icon: "sunny" };
          }
          if (!Array.isArray(args.itinerary)) args.itinerary = [];
          if (!Array.isArray(args.costBreakdown)) args.costBreakdown = [];

          return {
            aiText: `I've prepared a trip plan to ${args.location} with an estimated total cost of $${args.price}.`,
            signal: { type: "planReady", payload: args },
            assistantMessage: msg,
          };
        }
      }

      // B. TEXT RESPONSE HANDLING
      let text = msg.content || "";

      // Safety net: If the model accidentally asks about dates or guests via text,
      // we intercept and convert it into the proper tool-based flow.
      const lower = text.toLowerCase();
      const asksDates =
        lower.includes("when") &&
        (lower.includes("travel") ||
          lower.includes("trip") ||
          lower.includes("go"));
      const asksGuests =
        lower.includes("how many") &&
        (lower.includes("people") || lower.includes("guests"));

      // If both are asked in one sentence, prefer date tool first, then guests via next turn.
      if (asksDates) {
        logInfo(
          reqId,
          "[Guardrail] Intercepted text question about dates. Triggering request_dates tool signal."
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
          "[Guardrail] Intercepted text question about guests. Triggering request_guests tool signal."
        );
        return {
          aiText: "Please specify how many people are traveling.",
          signal: { type: "guestsNeeded" },
          assistantMessage: msg,
        };
      }

      // Otherwise this is a normal clarifying / info response
      return { aiText: text };
    };

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [
      { role: "system", content: systemPrompt },
      ...normalizeMessages(messages),
    ];

    const response = await runConversation(convo);
    res.json(response);
  } catch (err) {
    logError(reqId, "Error", err);
    res.status(500).json({ aiText: "System error." });
  }
});

export default router;
