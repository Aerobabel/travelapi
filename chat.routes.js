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
const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

const userMem = new Map();
const imageCache = new Map();

const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        origin_city: null,
        preferred_travel_type: [],
        budget: { prefer_comfort_or_saving: "balanced" },
      },
    });
  }
  return userMem.get(userId);
};

// Extract "Flying from X" logic
function updateProfileFromHistory(messages, mem) {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) return;
    const text = (lastUserMsg.text || lastUserMsg.content || "").toLowerCase();
    const match = text.match(/from\s+([a-z\s]+?)(?:\s+to|\s+on|\.|$)/);
    if (match && match[1]) mem.profile.origin_city = match[1].trim();
}

// --- 3. EXTERNAL APIS ---

const FALLBACK_IMAGE_URL = "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?q=80&w=1442&auto=format&fit=crop";

async function pickPhoto(dest, reqId) {
  const cacheKey = (dest || "").toLowerCase().trim();
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
  if (!UNSPLASH_ACCESS_KEY) return FALLBACK_IMAGE_URL;

  // Simple, reliable query
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
    logInfo(reqId, `[SEARCH] "${query}"`);
    
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=5`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const snippets = [];
        
        if (data.answer_box) snippets.push(`Answer: ${JSON.stringify(data.answer_box)}`);
        if (data.organic_results) {
            data.organic_results.slice(0, 3).forEach(r => snippets.push(`- ${r.title}: ${r.snippet}`));
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
      description: "Call if travel dates are missing from the conversation.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Call if the exact number of travelers is unknown.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description: "Search for flight prices and hotel costs. Use ONLY after dates/guests are known.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "e.g. 'Flight London to Dubai Nov 12 price'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Generate the final JSON plan.",
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
            properties: { temp: { type: "number" }, icon: { type: "string" } },
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string" },
                day: { type: "string" }, // e.g. "Nov 02"
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

// --- 5. SYSTEM PROMPT (Strict Phased Logic) ---
const getSystemPrompt = (profile) => `You are an advanced Travel Agent.

**PHASE 1: LOGISTICS CHECK (Highest Priority)**
Before searching or planning, you MUST confirm:
1. **Dates:** If unknown, call \`request_dates\`.
2. **Guests:** If unknown, call \`request_guests\`. (Do NOT assume 1 person).
3. **Origin:** If unknown (and needed for flight search), ask in text.

**PHASE 2: RESEARCH**
Once Phase 1 is complete, call \`search_google\` to find real prices for flights and hotels.

**PHASE 3: PLANNING**
Once research is done, call \`create_plan\`.
- **Total Price:** Must sum up Flights + Hotels + Activities.
- **Dates:** Format as "MMM DD" (e.g. Nov 12).

**Context:**
Origin: ${profile.origin_city || "Unknown"}
`;

// --- 6. ROUTE HANDLER ---
function normalizeMessages(messages = []) {
  return messages.filter(m => !m.hidden).map(m => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      
      // Collapse large plan payloads to save tokens/confusion
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

    // Recursive Agent Loop
    // We allow up to 3 turns in one request (e.g. Search -> Result -> Plan)
    const runConversation = async (history, depth = 0) => {
        if (depth > 3) return { aiText: "I'm processing your request. Please wait a moment." };

        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: history,
            tools,
            tool_choice: "auto", 
            temperature: 0.2, // Low temp to ensure logic sequence
        });

        const msg = completion.choices[0].message;

        // A. TOOL CALLS
        if (msg.tool_calls) {
            const tool = msg.tool_calls[0];
            const name = tool.function.name;
            const args = JSON.parse(tool.function.arguments);

            logInfo(reqId, `[Tool] ${name}`, args);

            // 1. SEARCH -> Recurse
            if (name === "search_google") {
                const result = await performGoogleSearch(args.query, reqId);
                const newHistory = [...history, msg, { role: "tool", tool_call_id: tool.id, content: result }];
                return runConversation(newHistory, depth + 1);
            }

            // 2. LOGISTICS -> Return to Frontend
            // Note: We return the tool call as 'assistantMessage' so frontend history stays in sync
            if (name === "request_dates") {
                return { 
                    aiText: "When are you planning to travel?", 
                    signal: { type: "dateNeeded" },
                    assistantMessage: msg 
                };
            }
            if (name === "request_guests") {
                return { 
                    aiText: "How many people are traveling?", 
                    signal: { type: "guestsNeeded" },
                    assistantMessage: msg 
                };
            }

            // 3. PLAN -> Sanitize & Return
            if (name === "create_plan") {
                // [SAFETY 1] Fetch Image
                args.image = await pickPhoto(args.location, reqId);
                
                // [SAFETY 2] Ensure Weather
                if (!args.weather || !args.weather.icon) {
                    args.weather = { temp: 25, icon: "sunny" };
                }

                // [SAFETY 3] Ensure Itinerary Array
                if (!Array.isArray(args.itinerary)) args.itinerary = [];

                return { 
                    aiText: `I've planned a trip to ${args.location}. Total estimated cost: $${args.price}.`, 
                    signal: { type: "planReady", payload: args },
                    assistantMessage: msg 
                };
            }
        }

        // B. TEXT RESPONSE
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
