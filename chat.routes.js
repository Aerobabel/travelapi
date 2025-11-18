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
        preferred_travel_type: [],
        budget: { prefer_comfort_or_saving: "balanced" },
        // Add other profile fields as needed
      },
    });
  }
  return userMem.get(userId);
};

// (Keep your existing profile update logic - abbreviated here for clarity)
function updateProfileFromHistory(messages, mem) {
  // ... logic to extract preferences from text ...
}

// --- 3. EXTERNAL API HANDLERS ---

// A. Unsplash (Images)
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

// B. SerpApi (Real-Time Intelligence)
async function performGoogleSearch(query, reqId) {
  if (!SERPAPI_KEY) return "Error: SERPAPI_API_KEY not configured.";
  
  logInfo(reqId, `Performing Live Search: "${query}"`);
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=5`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    // Extract meaningful bits to save token space
    const snippets = [];
    
    // 1. Knowledge Graph (Quick answers)
    if (data.knowledge_graph) {
      snippets.push(`Fact: ${data.knowledge_graph.description || data.knowledge_graph.title}`);
    }

    // 2. Organic Results (General Info)
    if (data.organic_results) {
      data.organic_results.slice(0, 4).forEach(r => {
        snippets.push(`Source (${r.title}): ${r.snippet} ${r.rich_snippet?.top?.extensions?.join(", ") || ""}`);
      });
    }

    // 3. Flights/Hotels specific data often appears in 'answer_box' or specific widgets
    // For a basic Google Search, we rely on snippets. 
    // (To get deep flight data, you'd use the google_flights engine in SerpApi, but standard search works for general pricing).

    return snippets.join("\n\n") || "No search results found.";
  } catch (e) {
    logError(reqId, "SerpApi Failed", e);
    return "Search request failed.";
  }
}

// --- 4. TOOL DEFINITIONS ---
const tools = [
  {
    type: "function",
    function: {
      name: "search_google",
      description: "REQUIRED for real-world data. Use this to find: flight prices, hotel costs, current weather, opening hours, or specific restaurant reviews. Do not guess prices.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Targeted search query, e.g., 'Flights New York to Paris Dec 25 price' or 'Best boutique hotels in Kyoto under $200'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "Ask the user for dates if they are missing.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Ask the user for guest count if missing.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "The Final Output. Call this ONLY when you have researched specific places and costs using Google Search.",
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

// --- 5. SYSTEM PROMPT ---
const getSystemPrompt = (profile) => `You are a Billion-Dollar Travel Agent. You do not guess—you verify.

**CORE BEHAVIOR:**
1. **Consultant First:** If the user is vague, ask clarifying questions.
2. **Researcher Second:** BEFORE generating a plan, use the \`search_google\` tool to find REAL flight prices, hotel availability, and specific venue details. 
   - *Example:* Don't say "Visit a museum." Search for "Best museums in Rome opening hours" and say "Visit the Borghese Gallery (Ticket: $22, Book 2 weeks ahead)."
3. **Architect Third:** Assemble the data into the \`create_plan\` function.

**USER PROFILE:**
${JSON.stringify(profile, null, 2)}

**RULES:**
- Prices must be realistic estimates based on search data.
- Itineraries must be concrete (Real names, real addresses).
- If you lack dates/guests, ask for them immediately.
`;

// --- 6. ROUTE HANDLER (THE AGENT LOOP) ---
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
            role: m.role === 'ai' ? 'assistant' : (m.role === 'plan' ? 'assistant' : m.role), // Normalize roles
            content: typeof m.content === 'string' ? m.content : (m.text || JSON.stringify(m.payload || ''))
        })).filter(m => m.role !== 'tool') // Filter out old frontend tool artifacts if any
    ];

    // 2. Run the Agent Loop (Max 3 turns to prevent timeout)
    let finalResponseSent = false;
    let turns = 0;
    const MAX_TURNS = 3;

    while (!finalResponseSent && turns < MAX_TURNS) {
      turns++;
      logInfo(reqId, `Agent Loop Turn ${turns}`);

      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: convo,
        tools,
        tool_choice: "auto",
      });

      const message = completion.choices[0].message;

      // A. Does the AI want to talk or call a tool?
      if (message.tool_calls) {
        convo.push(message); // Add AI's intent to history

        for (const toolCall of message.tool_calls) {
          const fnName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          logInfo(reqId, `Tool Call: ${fnName}`, args);

          // CASE 1: Search (The "Billion Dollar" feature)
          if (fnName === "search_google") {
            const searchResult = await performGoogleSearch(args.query, reqId);
            convo.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: searchResult
            });
            // Loop continues... AI sees result in next turn and refines.
          }

          // CASE 2: Information Gathering (Dates/Guests)
          else if (fnName === "request_dates" || fnName === "request_guests") {
            const signalType = fnName === "request_dates" ? "dateNeeded" : "guestsNeeded";
            const aiText = fnName === "request_dates" ? "When are you looking to travel?" : "How many guests?";
            
            res.json({ aiText, signal: { type: signalType } });
            finalResponseSent = true;
            return; // Break loop, wait for user input
          }

          // CASE 3: Final Plan Creation
          else if (fnName === "create_plan") {
            // Enhance with Image
            args.image = await pickPhoto(args.location, reqId);
            
            // Validate Weather Icon
            if (args.weather && !["sunny", "cloudy", "partly-sunny"].includes(args.weather.icon)) {
              args.weather.icon = "sunny";
            }

            res.json({
              aiText: `I've crafted a detailed itinerary for ${args.location}.`,
              signal: { type: "planReady", payload: args },
              assistantMessage: message // Pass back for frontend history
            });
            finalResponseSent = true;
            return;
          }
        }
      } else {
        // B. AI just wants to talk (text response)
        res.json({ aiText: message.content });
        finalResponseSent = true;
        return;
      }
    }

    // Fallback if loop exhausts without final tool call
    if (!finalResponseSent) {
        res.json({ aiText: "I'm processing a lot of data. Could you clarify your main priority?" });
    }

  } catch (err) {
    logError(reqId, "Critical Error", err);
    res.status(500).json({ aiText: "I encountered a system error while planning. Please try again." });
  }
});

export default router;
