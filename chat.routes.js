// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// --- 1. Polyfills & Setup ---
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
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const SERPAPI_KEY = process.env.SERPAPI_API_KEY;

// --- 2. Helpers ---
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
        travel_alone_or_with: null,
        budget: { prefer_comfort_or_saving: "balanced" },
      },
    });
  }
  return userMem.get(userId);
};

function updateProfileFromHistory(messages, mem) {
  // Basic profile extraction
  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (!lastUserMsg) return;
  const text = (lastUserMsg.text || lastUserMsg.content || "").toLowerCase();
  
  // Capture origin city (essential for flights)
  if (text.includes("from")) {
    const match = text.match(/from\s+([a-z\s]+?)(?:\s+to|\s+on|\.|$)/);
    if (match && match[1]) mem.profile.origin_city = match[1].trim();
  }
}

// --- 3. External APIs ---

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
    if (!SERPAPI_KEY) return "Search unavailable (No API Key).";
    logInfo(reqId, `[SEARCH] "${query}"`);
    
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=4`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const snippets = [];
        
        if (data.knowledge_graph) snippets.push(`Fact: ${data.knowledge_graph.title} - ${data.knowledge_graph.description}`);
        if (data.organic_results) {
            data.organic_results.slice(0, 3).forEach(r => snippets.push(`- ${r.title}: ${r.snippet}`));
        }
        
        const result = snippets.join("\n");
        logInfo(reqId, `[SEARCH RESULT] Found ${snippets.length} items.`);
        return result || "No specific details found.";
    } catch (e) {
        logError(reqId, "SerpApi Error", e);
        return "Search failed.";
    }
}

// --- 4. Tools (The "Action" Layer) ---
const tools = [
  {
    type: "function",
    function: {
      name: "search_google",
      description: "Use this to find prices and place details. Required before creating a plan.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "e.g. 'Round trip flight London to Dubai Nov 12 price'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "Call if the user hasn't given travel dates.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Call if the user hasn't said how many people are going.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Generate the final itinerary. Only call this after searching for prices.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string" },
          description: { type: "string" },
          price: { type: "number", description: "TOTAL COST = Flight + (Hotel * Nights) + Activities." },
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
                day: { type: "string", description: "Format: 'MMM DD' (e.g. 'Nov 02')" },
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
                iconType: { type: "string" },
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

// --- 5. System Prompt (The Logic) ---
const getSystemPrompt = (profile) => `You are an expert Travel Planner.

**Current User Context:**
- Origin City: ${profile.origin_city || "Unknown (Ask user if needed for flights)"}
- Preferences: ${JSON.stringify(profile)}

**LOGIC PROTOCOL:**
1. **Missing Dates?** -> Call \`request_dates\`.
2. **Missing Guests?** -> Call \`request_guests\`.
3. **Missing Prices?** -> Call \`search_google\`. Search for flights from Origin, hotels, and activity costs.
4. **Ready?** -> Call \`create_plan\`.

**RULES:**
- **Total Price:** The \`price\` field MUST be the SUM of (Flight + Hotel*Nights + Activities). Do NOT just put the flight cost.
- **Date Format:** Use "MMM DD" (e.g. "Nov 12").
- **Origins:** If you don't know the Origin City, ask for it in plain text before searching flights.
`;

// --- 6. Route Handler (Recursive) ---
function normalizeMessages(messages = []) {
  // Standard cleanup to keep context clean
  return messages.filter(m => !m.hidden).map(m => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      // Filter plan payloads to save tokens
      let content = m.content ?? m.text ?? '';
      if (m.role === 'plan' || (!content && m.payload)) content = "[Previous Plan Generated]";
      return { role: m.role === 'ai' ? 'assistant' : 'user', content: String(content) };
  });
}

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey) return res.json({ aiText: "Service Unavailable" });

    // Recursive function to handle "Think -> Search -> Plan" in one go
    const runConversation = async (history, depth = 0) => {
        if (depth > 3) return { aiText: "I'm processing too much data. Can you narrow it down?" };

        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: history,
            tools,
            tool_choice: "auto", 
            temperature: 0.3,
        });

        const msg = completion.choices[0].message;

        // 1. Handle Tool Calls
        if (msg.tool_calls) {
            const tool = msg.tool_calls[0];
            const name = tool.function.name;
            const args = JSON.parse(tool.function.arguments);

            logInfo(reqId, `[Tool] ${name}`, args);

            // A. SEARCH -> Execute & Recurse
            if (name === "search_google") {
                const result = await performGoogleSearch(args.query, reqId);
                
                // Create new history with the tool call and the result
                const newHistory = [
                    ...history,
                    msg,
                    { role: "tool", tool_call_id: tool.id, content: result }
                ];
                
                // RECURSE: Call OpenAI again immediately with the new info
                return runConversation(newHistory, depth + 1);
            }

            // B. UI SIGNALS (Dates/Guests)
            if (name === "request_dates") return { aiText: "When are you planning to travel?", signal: { type: "dateNeeded" } };
            if (name === "request_guests") return { aiText: "How many people are traveling?", signal: { type: "guestsNeeded" } };

            // C. FINAL PLAN
            if (name === "create_plan") {
                args.image = await pickPhoto(args.location, reqId);
                if (args.weather && !args.weather.icon) args.weather.icon = "sunny";
                
                return { 
                    aiText: `I've built a plan for ${args.location}. Total estimated cost: $${args.price}.`, 
                    signal: { type: "planReady", payload: args },
                    assistantMessage: msg // Save plan to history
                };
            }
        }

        // 2. Handle Text (Clarifying Questions or "What is your origin?")
        return { aiText: msg.content };
    };

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];
    
    const response = await runConversation(convo);
    res.json(response);

  } catch (err) {
    logError(reqId, "Error", err);
    res.status(500).json({ aiText: "Something went wrong." });
  }
});

export default router;
