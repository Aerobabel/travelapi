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

// Quick logic to save origin city if user types "flying from London"
function updateProfileFromHistory(messages, mem) {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) return;
    const text = (lastUserMsg.text || lastUserMsg.content || "").toLowerCase();
    const match = text.match(/from\s+([a-z\s]+)/);
    if (match && match[1]) mem.profile.origin_city = match[1].trim();
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
  if (!SERPAPI_KEY) return "System Error: SERPAPI_KEY missing. Cannot search.";
  
  logInfo(reqId, `[AGENT SEARCH] "${query}"`);
  // We use Google Flights engine if query contains 'flight', else standard search
  const engine = query.toLowerCase().includes("flight") ? "google_flights" : "google";
  
  // Simplified URL for standard search
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=4`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    
    const snippets = [];
    
    // 1. Attempt to grab Flight info specifically
    if (data.flights) {
       // If using flights engine (requires complex parsing, sticking to organic for simplicity in this snippet)
    }
    
    // 2. Knowledge Graph (Quick answers)
    if (data.knowledge_graph) snippets.push(`Fact: ${data.knowledge_graph.title} - ${data.knowledge_graph.description}`);
    
    // 3. Answer Box (Prices often appear here)
    if (data.answer_box) snippets.push(`Direct Answer: ${JSON.stringify(data.answer_box)}`);
    
    // 4. Organic Results
    if (data.organic_results) {
      data.organic_results.slice(0, 4).forEach(r => {
        snippets.push(`- ${r.title}: ${r.snippet} ${r.rich_snippet?.top?.extensions?.join(", ") || ""}`);
      });
    }

    const result = snippets.join("\n");
    logInfo(reqId, `[SEARCH RESULT] Found ${snippets.length} snippets.`);
    return result || "No relevant search results found.";
  } catch (e) {
    logError(reqId, "SerpApi Failed", e);
    return "Search failed.";
  }
}

// --- 4. STRICT TOOLS ---
const tools = [
  {
    type: "function",
    function: {
      name: "search_google",
      description: "MANDATORY Step 1: Search for real-time data. Use this for: Flight prices (from Origin to Destination), Hotel costs for specific dates, Weather, or Reviews of specific venues.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "e.g. 'Flight London to Paris Nov 2 price', 'Best boutique hotel in Kyoto under $200'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_origin",
      description: "MANDATORY Step 0: If the user has not said where they are flying FROM, call this tool.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "MANDATORY Step 0: If dates are unknown, call this tool.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "MANDATORY Step 0: If guest count is unknown, call this tool.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "MANDATORY Final Step: Call this ONLY after you have run `search_google` and have concrete details.",
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
                date: { type: "string", description: "YYYY-MM-DD" },
                day: { type: "string", description: "STRICT Format: 'MMM DD' (e.g. Nov 02). Do NOT use 'Day 1' or 'Friday'." },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["activity", "food", "travel", "stay"] },
                      icon: { type: "string" },
                      time: { type: "string" },
                      duration: { type: "string" },
                      title: { type: "string", description: "Specific Name (e.g. 'Flight UA924', 'Dinner at Nobu')" },
                      details: { type: "string", description: "Real Address / Price / Note" },
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

// --- 5. THE AGENT BRAIN (SYSTEM PROMPT) ---
const getSystemPrompt = (profile) => `You are a headless Travel Agent Backend. You DO NOT talk. You ONLY execute logic.

**YOUR EXECUTION LOOP:**
1. **Analyze Input:** Check if Destination, Origin, Dates, and Guests are known.
2. **Missing Data?** -> Call \`request_origin\`, \`request_dates\`, or \`request_guests\`. STOP.
3. **Have Data but No Prices?** -> Call \`search_google\`. Search for "Flights from [Origin] to [Dest] [Dates]" and "Hotels in [Dest] [Dates]". STOP.
4. **Have Search Results?** -> Call \`create_plan\`. Use the data found to fill the JSON.

**RULES:**
- **NEVER** output a text summary. If you have a plan, call the function.
- **NEVER** make up flight prices. If you didn't search, call \`search_google\`.
- **Date Format:** Always use "MMM DD" (e.g., "Nov 12") for the 'day' field.

**USER CONTEXT:**
${JSON.stringify(profile, null, 2)}
`;

// --- 6. ROUTE HANDLER (AGENT LOOP) ---
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey) return res.json({ aiText: "Service offline (Missing API Key)." });

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [
        { role: "system", content: systemPrompt }, 
        ...messages.map(m => ({
            role: m.role === 'ai' ? 'assistant' : (m.role === 'plan' ? 'assistant' : m.role),
            content: typeof m.content === 'string' ? m.content : (m.text || JSON.stringify(m.payload || ''))
        })).filter(m => m.role !== 'tool')
    ];

    let finalResponseSent = false;
    let turns = 0;
    const MAX_TURNS = 4; // Limit loops to prevent timeout

    // --- THE LOOP ---
    while (!finalResponseSent && turns < MAX_TURNS) {
      turns++;
      logInfo(reqId, `[TURN ${turns}] Thinking...`);

      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: convo,
        tools,
        tool_choice: "auto",
        temperature: 0.1, // Strict logic
      });

      const message = completion.choices[0].message;

      // A. TOOL CALL (Desired Behavior)
      if (message.tool_calls) {
        convo.push(message); // Add intent to memory

        // Handle the FIRST tool call (sequential logic)
        const toolCall = message.tool_calls[0]; 
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        logInfo(reqId, `[ACTION] ${fnName}`, args);

        // 1. INTERNAL SEARCH (Keep Looping)
        if (fnName === "search_google") {
          const searchResult = await performGoogleSearch(args.query, reqId);
          convo.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: searchResult
          });
          // Loop continues -> AI sees result -> Calls create_plan next
        }

        // 2. USER INTERACTION (Break Loop)
        else {
          const responsePayload = { 
             // Return the tool call message so frontend can add it to history
             assistantMessage: { ...message, content: "" } 
          };

          if (fnName === "request_origin") {
             // No UI sheet for origin, so we ask in text. 
             // Note: We strip the tool call here and just send text to avoid UI errors if frontend doesn't handle 'request_origin' signal
             return res.json({ aiText: "Where are you flying from?" });
          }
          else if (fnName === "request_dates") {
             responsePayload.signal = { type: "dateNeeded" };
             responsePayload.aiText = "When are you planning to go?";
             return res.json(responsePayload);
          }
          else if (fnName === "request_guests") {
             responsePayload.signal = { type: "guestsNeeded" };
             responsePayload.aiText = "Who is traveling with you?";
             return res.json(responsePayload);
          }
          else if (fnName === "create_plan") {
             // Enhance final output
             args.image = await pickPhoto(args.location, reqId);
             if (args.weather && !args.weather.icon) args.weather.icon = "sunny";

             responsePayload.signal = { type: "planReady", payload: args };
             responsePayload.aiText = `I've planned a trip to ${args.location} based on current prices.`;
             return res.json(responsePayload);
          }
        }
      } 
      
      // B. TEXT RESPONSE (Undesired but possible)
      else {
        const text = message.content;
        logInfo(reqId, `[TEXT OUTPUT] ${text}`);
        
        // If it output text but we are in the middle of a loop (e.g. clarifying question), return it.
        // But if it tried to dump a plan in text, it broke the rules. 
        // With Temp 0.1, strict prompts, and "Headless Backend" persona, this acts as a Clarifying Question handler.
        return res.json({ aiText: text });
      }
    }

    if (!finalResponseSent) {
        return res.json({ aiText: "I'm digging through a lot of data. Could you narrow down your request?" });
    }

  } catch (err) {
    logError(reqId, "Critical Error", err);
    res.status(500).json({ aiText: "Server error." });
  }
});

export default router;
