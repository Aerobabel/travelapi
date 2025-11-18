// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// --- 1. SETUP & POLYFILLS ---
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
const hasSerp = Boolean(process.env.SERPAPI_API_KEY);

const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const SERPAPI_KEY = process.env.SERPAPI_API_KEY;

// --- 2. HELPERS & STATE ---
const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

const userMem = new Map();
const imageCache = new Map();

const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        origin_city: null, // NEW: We need to know where they live
        preferred_travel_type: [],
        budget: { prefer_comfort_or_saving: "balanced" },
      },
    });
  }
  return userMem.get(userId);
};

// Capture origin city if mentioned in passing
function updateProfileFromHistory(messages, mem) {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) return;
    const text = (lastUserMsg.text || lastUserMsg.content || "").toLowerCase();
    
    // Simple regex to catch explicit "flying from X" (The AI tool request_origin handles the specific case better)
    if (text.includes("flying from")) {
        const match = text.match(/from\s+([a-z\s]+)/);
        if (match && match[1]) mem.profile.origin_city = match[1].trim();
    }
}

// --- 3. EXTERNAL API HANDLERS ---

const FALLBACK_IMAGE_URL = "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?q=80&w=1470&auto=format&fit=crop";

async function pickPhoto(dest, reqId) {
  const cacheKey = (dest || "").toLowerCase().trim();
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
  if (!UNSPLASH_ACCESS_KEY) return FALLBACK_IMAGE_URL;

  const query = encodeURIComponent(`${dest} travel scenic`);
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
  if (!SERPAPI_KEY) return "Error: SERPAPI_API_KEY not configured.";
  
  logInfo(reqId, `Performing Live Search: "${query}"`);
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=5`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    // We prioritize "knowledge_graph" (facts) and "organic_results" (snippets)
    // We also check for "answer_box" which often contains flight prices in snippets
    const snippets = [];
    if (data.answer_box) snippets.push(`Direct Answer: ${JSON.stringify(data.answer_box)}`);
    if (data.knowledge_graph) snippets.push(`Fact: ${data.knowledge_graph.description || data.knowledge_graph.title}`);
    if (data.organic_results) {
      data.organic_results.slice(0, 4).forEach(r => {
        snippets.push(`Source (${r.title}): ${r.snippet}`);
      });
    }

    return snippets.join("\n\n") || "No search results found.";
  } catch (e) {
    logError(reqId, "SerpApi Failed", e);
    return "Search request failed.";
  }
}

// --- 4. STRICT TOOL DEFINITIONS ---
const tools = [
  {
    type: "function",
    function: {
      name: "search_google",
      description: "REQUIRED. Search for real-time flight prices, hotel costs, or specific venues. Query MUST include the Origin City for flights (e.g., 'Flights from London to Paris price').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "Call this if the user has NOT specified travel dates.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Call this if the user has NOT specified the number of travelers.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "request_origin",
      description: "CRITICAL: Call this if the user has not said where they are flying FROM. You cannot plan flights without this.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "The Final Output. Call this ONLY when you have: Destination, Origin, Dates, Guests, and Real Search Data. Do NOT output text when you are ready to call this.",
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
            properties: { temp: { type: "number" }, icon: { type: "string", enum: ["sunny", "cloudy", "partly-sunny"] } },
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string" },
                day: { type: "string" },
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

// --- 5. STRICT GATEKEEPER PROMPT ---
const getSystemPrompt = (profile) => `You are an automated Travel Planning Engine. You are NOT a conversational chatbot.

**STATE MACHINE RULES:**
You must evaluate the "Current State" and execute the EXACT corresponding action.

**STATE 1: MISSING CRITICAL DATA**
Check these variables:
1. **Destination:** (Known?)
2. **Origin City:** (Known? If user didn't say "flying from X", it is UNKNOWN.)
3. **Dates:** (Known?)
4. **Guest Count:** (Known?)

> ACTION: If ANY are missing, immediately call the corresponding tool: \`request_origin\`, \`request_dates\`, or \`request_guests\`. Do NOT guess. Do NOT search yet.

**STATE 2: GATHERING INTELLIGENCE**
If all variables in State 1 are known, but you haven't searched for prices yet:
> ACTION: Call \`search_google\`.
> Query Examples: 
> - "Round trip flight from ${profile.origin_city || 'USER_ORIGIN'} to DESTINATION dates..."
> - "Hotel prices in DESTINATION for 2 adults..."
> - "Top rated restaurants in DESTINATION..."

**STATE 3: FINALIZING**
If you have the user data AND the search results:
> ACTION: Call \`create_plan\`.
> **CRITICAL:** Do NOT summarize the plan in text. Do NOT say "Here is your plan." JUST CALL THE FUNCTION.

**USER CONTEXT:**
${JSON.stringify(profile, null, 2)}
`;

// --- 6. ROUTE HANDLER ---
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    // 1. Prepare Conversation
    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [
        { role: "system", content: systemPrompt }, 
        ...messages.map(m => ({
            role: m.role === 'ai' ? 'assistant' : (m.role === 'plan' ? 'assistant' : m.role),
            content: typeof m.content === 'string' ? m.content : (m.text || JSON.stringify(m.payload || ''))
        })).filter(m => m.role !== 'tool')
    ];

    // 2. Agent Loop (Max 5 turns to allow for Asking -> Answering -> Searching -> Planning)
    let finalResponseSent = false;
    let turns = 0;
    const MAX_TURNS = 5;

    while (!finalResponseSent && turns < MAX_TURNS) {
      turns++;
      logInfo(reqId, `Agent Loop Turn ${turns}`);

      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: convo,
        tools,
        tool_choice: "auto", // We rely on the strict prompt to force tools
        temperature: 0.2, // Low temperature to force strict logic
      });

      const message = completion.choices[0].message;

      // A. Does the AI want to call a tool?
      if (message.tool_calls) {
        convo.push(message); // Add intent to history

        // We only handle the FIRST tool call to keep state clean, or handle all if parallel
        // For simplicity/safety in this flow, let's handle the first critical one
        const toolCall = message.tool_calls[0]; 
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        logInfo(reqId, `Tool Call: ${fnName}`, args);

        // CASE 1: SEARCH (Internal Agent Action)
        if (fnName === "search_google") {
          const searchResult = await performGoogleSearch(args.query, reqId);
          convo.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: searchResult
          });
          // Loop continues... AI receives data in next turn
        }

        // CASE 2: MISSING DATA (Ask User)
        else if (["request_dates", "request_guests", "request_origin"].includes(fnName)) {
          let signalType = "";
          let aiText = "";

          if (fnName === "request_origin") {
             // There isn't a UI sheet for origin yet, so we ask via text
             aiText = "To find the best flights, I need to know: where are you flying from?";
             // We don't send a signal because we want a text reply
          } else if (fnName === "request_dates") {
             signalType = "dateNeeded";
             aiText = "When are you planning to travel?";
          } else if (fnName === "request_guests") {
             signalType = "guestsNeeded";
             aiText = "How many people are in your group?";
          }

          res.json({ aiText, signal: signalType ? { type: signalType } : undefined });
          finalResponseSent = true;
          return;
        }

        // CASE 3: FINAL PLAN
        else if (fnName === "create_plan") {
          args.image = await pickPhoto(args.location, reqId);
          
          // Safety: If origin was never captured, update profile now for future
          if (!mem.profile.origin_city && args.costBreakdown) {
             // Simple heuristic: did it guess an origin in the plan?
          }

          if (args.weather && !["sunny", "cloudy", "partly-sunny"].includes(args.weather.icon)) {
            args.weather.icon = "sunny";
          }

          res.json({
            aiText: `I've prepared a trip to ${args.location} from ${mem.profile.origin_city || 'your location'}.`,
            signal: { type: "planReady", payload: args },
            assistantMessage: message
          });
          finalResponseSent = true;
          return;
        }
      } else {
        // B. AI responded with text
        // Because of our strict prompt, if it responds with text, it's likely a clarifying question
        // OR it failed to follow instructions.
        
        // If it wrote a giant text wall despite having data, we failed.
        // But usually, with temp 0.2 and strict prompt, this only happens for "Clarifying questions"
        res.json({ aiText: message.content });
        finalResponseSent = true;
        return;
      }
    }

    if (!finalResponseSent) {
        res.json({ aiText: "I'm taking a bit too long to research. Could you try narrowing down your request?" });
    }

  } catch (err) {
    logError(reqId, "Critical Error", err);
    res.status(500).json({ aiText: "Server error during planning." });
  }
});

export default router;
