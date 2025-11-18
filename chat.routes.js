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

// --- 2. STATE MANAGEMENT ---
const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

const userMem = new Map();
const imageCache = new Map();

const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        origin_city: null, // Crucial: Starts as null. We NEVER assume.
        preferred_travel_type: [],
        budget: { prefer_comfort_or_saving: "balanced" },
      },
    });
  }
  return userMem.get(userId);
};

// Enhanced Logic to catch "I'm in London" or "Flying from Paris"
function updateProfileFromHistory(messages, mem) {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) return;
    
    const text = (lastUserMsg.text || lastUserMsg.content || "").toLowerCase();
    
    // Regex to catch origins
    const fromMatch = text.match(/\bfrom\s+([a-z\s\.]+?)(?:\s+to|\s+on|\.|$)/);
    const inMatch = text.match(/\bi(?:'| a)?m\s+(?:in|at)\s+([a-z\s\.]+?)(?:\.|$)/);
    
    if (fromMatch && fromMatch[1]) mem.profile.origin_city = fromMatch[1].trim();
    else if (inMatch && inMatch[1]) mem.profile.origin_city = inMatch[1].trim();
}

// --- 3. EXTERNAL APIS ---

const FALLBACK_IMAGE_URL = "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?q=80&w=1442&auto=format&fit=crop";

async function pickPhoto(dest, reqId) {
  const cacheKey = (dest || "").toLowerCase().trim();
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
  if (!UNSPLASH_ACCESS_KEY) return FALLBACK_IMAGE_URL;

  const query = encodeURIComponent(`${dest} travel landmark`);
  const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
    if (!res.ok) return FALLBACK_IMAGE_URL;
    const data = await res.json();
    if (data.results?.[0]?.urls?.regular) {
      const img = data.results[0].urls.regular;
      imageCache.set(cacheKey, img);
      return img;
    }
    return FALLBACK_IMAGE_URL;
  } catch (e) {
    return FALLBACK_IMAGE_URL;
  }
}

async function performGoogleSearch(query, reqId) {
    if (!SERPAPI_KEY) return "Search skipped (No API Key).";
    
    // Force "Round Trip" into flight queries if not present, to ensure cost accuracy
    let finalQuery = query;
    if (query.toLowerCase().includes("flight") && !query.toLowerCase().includes("round trip")) {
        finalQuery = query + " round trip";
    }

    logInfo(reqId, `[SEARCH] "${finalQuery}"`);
    
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(finalQuery)}&api_key=${SERPAPI_KEY}&num=5`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const snippets = [];
        
        if (data.answer_box) snippets.push(`Price Answer: ${JSON.stringify(data.answer_box)}`);
        if (data.organic_results) {
            data.organic_results.slice(0, 4).forEach(r => snippets.push(`- ${r.title}: ${r.snippet}`));
        }
        
        const result = snippets.join("\n");
        logInfo(reqId, `[SEARCH RESULT] Data received.`);
        return result || "No specific details found.";
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
      name: "request_info",
      description: "Call this when ANY critical information (Dates, Guests, or Origin) is missing. Do not ask via text.",
      parameters: {
        type: "object",
        properties: {
          missing_field: { 
            type: "string", 
            enum: ["dates", "guests", "origin"],
            description: "The specific piece of information needed."
          }
        },
        required: ["missing_field"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description: "MANDATORY: Search for real-time prices. You MUST use this before creating a plan.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "e.g. 'Round trip flight London to NYC Nov 12 price'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Final Step: Generate the itinerary. Call only after search is complete.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string" },
          description: { type: "string" },
          price: { type: "number", description: "Total Trip Cost including return flights." },
          weather: {
            type: "object",
            properties: { temp: { type: "number" }, icon: { type: "string" } },
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "YYYY-MM-DD" },
                day: { type: "string", description: "STRICT Format: 'MMM DD' (e.g. 'Nov 20'). FORBIDDEN: 'Day 1', 'Friday'." },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["activity", "food", "travel", "stay"] },
                      icon: { type: "string" },
                      time: { type: "string" },
                      duration: { type: "string" },
                      title: { type: "string" },
                      details: { type: "string" },
                    },
                    required: ["type", "icon", "time", "duration", "title", "details"]
                  }
                }
              },
              required: ["date", "day", "events"]
            }
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
              required: ["item", "provider", "details", "price", "iconType", "iconValue"]
            }
          }
        },
        required: ["location", "country", "dateRange", "description", "price", "itinerary", "costBreakdown"]
      }
    }
  }
];

// --- 5. SYSTEM PROMPT (The "Constitution") ---
const getSystemPrompt = (profile) => `You are a strict Travel Computation Engine.

**USER PROFILE:**
- Origin City: ${profile.origin_city ? profile.origin_city : "UNKNOWN"}
- Preferences: ${JSON.stringify(profile)}

**PROTOCOL (EXECUTE IN ORDER):**

1.  **MISSING DATA CHECK:**
    - IF Origin City is "UNKNOWN" -> Call \`request_info(missing_field: "origin")\`. STOP.
    - IF Dates are unknown -> Call \`request_info(missing_field: "dates")\`. STOP.
    - IF Guest Count is unknown -> Call \`request_info(missing_field: "guests")\`. STOP.

2.  **SEARCH PHASE (When all data is present):**
    - Call \`search_google\`.
    - Query 1: "Round trip flight from [Origin] to [Dest] [Dates] price"
    - Query 2: "Hotel prices in [Dest] [Dates]"

3.  **PLANNING PHASE (After Search):**
    - Do NOT summarize findings in text. Call \`create_plan\` immediately.
    - **COST CALCULATION:** Total Price = (Round Trip Flight Price * Guests) + (Hotel Nightly Rate * Nights) + (Daily Food/Activity * Days * Guests).
    - **DATE FORMAT:** You MUST use "MMM DD" (e.g. "Nov 20").
    - **RETURN FLIGHT:** Ensure the cost breakdown explicitly accounts for the flight back.

**BEHAVIOR:**
- Do NOT assume New York is the origin. Ask.
- Do NOT talk. Act.
`;

// --- 6. ROUTE HANDLER ---
function normalizeMessages(messages = []) {
  return messages.filter(m => !m.hidden).map(m => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      
      // Collapse large plan payloads to save tokens
      let content = m.content ?? m.text ?? '';
      if (m.role === 'plan' || (m.role === 'assistant' && m.payload)) content = "[Previous Plan Created]";
      
      return { role: m.role === 'ai' ? 'assistant' : (m.role === 'plan' ? 'assistant' : m.role), content: String(content) };
  });
}

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey) return res.json({ aiText: "Service Unavailable" });

    // Recursive Loop (Thinking Process)
    const runConversation = async (history, depth = 0) => {
        if (depth > 4) return { aiText: "I'm processing your request. Please hold on." };

        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: history,
            tools,
            tool_choice: "auto", 
            temperature: 0.1, // Strict logic
        });

        const msg = completion.choices[0].message;

        if (msg.tool_calls) {
            const tool = msg.tool_calls[0];
            const name = tool.function.name;
            const args = JSON.parse(tool.function.arguments);

            logInfo(reqId, `[Tool] ${name}`, args);

            // 1. SEARCH -> Internal Recursion
            if (name === "search_google") {
                const result = await performGoogleSearch(args.query, reqId);
                const newHistory = [...history, msg, { role: "tool", tool_call_id: tool.id, content: result }];
                return runConversation(newHistory, depth + 1);
            }

            // 2. MISSING INFO -> Return to Frontend
            if (name === "request_info") {
                let aiText = "";
                let signal = null;

                if (args.missing_field === "dates") {
                    aiText = "When are you planning to travel?";
                    signal = { type: "dateNeeded" };
                } else if (args.missing_field === "guests") {
                    aiText = "How many people are traveling?";
                    signal = { type: "guestsNeeded" };
                } else if (args.missing_field === "origin") {
                    // Frontend has no sheet for this, so we ask in text.
                    // We do NOT send a signal, just the question.
                    aiText = "To calculate flight costs, I need to know: Where are you flying from?";
                }

                return { aiText, signal, assistantMessage: msg };
            }

            // 3. FINAL PLAN -> Sanitize & Return
            if (name === "create_plan") {
                args.image = await pickPhoto(args.location, reqId);
                if (!args.weather || !args.weather.icon) args.weather = { temp: 25, icon: "sunny" };
                if (!Array.isArray(args.itinerary)) args.itinerary = [];

                return { 
                    aiText: `I've planned a trip to ${args.location}. Total cost (incl. flights): $${args.price}.`, 
                    signal: { type: "planReady", payload: args },
                    assistantMessage: msg 
                };
            }
        }

        // B. TEXT RESPONSE
        // If the AI is just talking (likely asking for origin if tool wasn't used, or clarification)
        return { aiText: msg.content };
    };

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];
    
    const response = await runConversation(convo);
    res.json(response);

  } catch (err) {
    logError(reqId, "Error", err);
    res.status(500).json({ aiText: "System error." });
  }
});

export default router;
