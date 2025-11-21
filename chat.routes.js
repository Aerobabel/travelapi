// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// Optional: catch unhandled promise rejections globally
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
        nationality: null,
        preferred_travel_type: [],
        interests: [],
        budget: { level: "balanced" },
      },
    });
  }
  return userMem.get(userId);
};

// Extract profile info from conversation
function updateProfileFromHistory(messages, mem) {
  // Logic to update memory based on user text (Restored from your original code)
  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  if (!lastUserMsg) return;
  
  // Handle both string text and array content (for images)
  let text = "";
  if (typeof lastUserMsg.content === 'string') text = lastUserMsg.content;
  else if (Array.isArray(lastUserMsg.content)) {
      const textPart = lastUserMsg.content.find(c => c.type === 'text');
      if(textPart) text = textPart.text;
  } else if (lastUserMsg.text) text = lastUserMsg.text;

  text = text.toLowerCase();

  const fromMatch = text.match(/from\s+([a-z\s]+?)(?:\s+to|\s+on|,|\.|$)/);
  if (fromMatch && fromMatch[1]) mem.profile.origin_city = fromMatch[1].trim();

  if (text.includes("cheap") || text.includes("low budget")) mem.profile.budget.level = "budget";
  if (text.includes("luxury") || text.includes("5 star")) mem.profile.budget.level = "luxury";
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

// Generic travel-related search with SerpAPI (UPDATED FOR SOCIAL LINKS)
async function performGoogleSearch(query, reqId) {
  if (!SERPAPI_KEY) return "Search skipped (No API Key).";
  logInfo(reqId, `[SEARCH] "${query}"`);

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=10`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const snippets = [];

    // Answer box / knowledge graph
    if (data.answer_box) snippets.push(`AnswerBox: ${JSON.stringify(data.answer_box)}`);
    if (data.knowledge_graph) snippets.push(`KnowledgeGraph: ${JSON.stringify(data.knowledge_graph)}`);

    // *** NEW: Handle Video/Social Results ***
    if (data.video_results) {
       const vids = data.video_results.slice(0, 3).map(v => `Video Title: ${v.title}, Link: ${v.link}, Snippet: ${v.snippet}`);
       snippets.push(`Social/Video Context: ${vids.join('\n')}`);
    }

    // Flights / Hotels / Local
    if (data.flights_results) snippets.push(`Flights: ${JSON.stringify(data.flights_results.slice(0, 5))}`);
    if (data.local_results) snippets.push(`Local: ${JSON.stringify(data.local_results.slice(0, 8))}`);
    
    // Organic
    if (data.organic_results) {
      data.organic_results.slice(0, 8).forEach((r) => {
        snippets.push(`Organic: ${r.title}: ${r.snippet || ""}`);
      });
    }

    const result = snippets.join("\n");
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
      description: "MANDATORY: If dates are missing, call this tool. DO NOT ask via text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "MANDATORY: If guest count is missing, call this tool. DO NOT ask via text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description: "Search the web. Use this for prices, weather, visas. ALSO use this for SOCIAL LINKS: if user pastes a TikTok/Instagram URL, search for it here to find the location/context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query or the Social URL to analyze." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Generate the final JSON plan using realistic prices found via search.",
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
                    required: ["type", "title", "details"]
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
              }
            }
          },
        },
        required: ["location", "price", "itinerary"],
      },
    },
  },
];

// --- 5. SYSTEM PROMPT ---
const getSystemPrompt = (profile) => `
You are a smart AI Travel Assistant.
Core Memory: Origin: ${profile.origin_city || "Unknown"}, Budget: ${profile.budget?.level || "balanced"}.

MODES:
1. **Trip Planning**: User wants a plan. USE TOOLS.
2. **Visual Analysis**: User sends an IMAGE. Analyze the landmark/vibe and suggest a trip there.
3. **Social Analysis**: User sends a LINK (TikTok/Insta/YouTube).
   - You cannot watch videos.
   - You MUST call 'search_google' with the link or keywords to find the location/price/activity.
   - Then plan a trip around that social content.

RULES:
- **Dates/Guests**: NEVER ask via text. Use 'request_dates' or 'request_guests'.
- **Realism**: Use 'search_google' to find real prices and flight numbers.
- **Itinerary**: "MMM DD" format. No generic titles like "Nice Hotel". Use real names.
`;

// --- 6. ROUTE HANDLER ---
function normalizeMessages(messages = []) {
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
      }

      // *** CRITICAL UPDATE: Handle Image Arrays for GPT-4o ***
      if (m.role === "user" && Array.isArray(m.content)) {
         // Pass the array (text + image_url) directly to OpenAI
         return { role: "user", content: m.content };
      }

      // Handle legacy text or plan objects
      let content = m.content || m.text || "";
      if (m.role === "plan" || (m.role === "assistant" && m.payload)) {
        content = "[Previous Plan Created]";
      }

      const role = m.role === "ai" ? "assistant" : m.role === "plan" ? "assistant" : m.role;
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

    const runConversation = async (history, depth = 0) => {
      try {
        if (depth > 8) return { aiText: "I'm having trouble finalizing. Please try again." };

        const completion = await client.chat.completions.create({
          model: "gpt-4o", // Required for Vision (images)
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
          
          let args = {};
          try { args = JSON.parse(tool.function.arguments || "{}"); } catch (e) { /* ignore */ }

          logInfo(reqId, `[Tool] ${name}`, args);

          // 1. SEARCH (Recursive)
          if (name === "search_google") {
            const result = await performGoogleSearch(args.query, reqId);
            const newHistory = [...history, msg, { role: "tool", tool_call_id: tool.id, content: result }];
            return runConversation(newHistory, depth + 1);
          }

          // 2. UI SIGNALS
          if (name === "request_dates") return { aiText: "Dates?", signal: { type: "dateNeeded" }, assistantMessage: msg };
          if (name === "request_guests") return { aiText: "Guests?", signal: { type: "guestsNeeded" }, assistantMessage: msg };

          // 3. PLAN CREATION
          if (name === "create_plan") {
            // Sanitization (Simplified for brevity but keeps core logic)
            if (!Array.isArray(args.itinerary)) args.itinerary = [];
            try {
                args.image = await pickPhoto(args.location, reqId); // Use Unsplash
            } catch (e) { args.image = FALLBACK_IMAGE_URL; }

            // Fallback data
            if (!args.weather) args.weather = { temp: 25, icon: "sunny" };
            if (!args.price) args.price = 0;

            return {
              aiText: `I've planned a trip to ${args.location} ($${args.price}).`,
              signal: { type: "planReady", payload: args },
              assistantMessage: msg,
            };
          }
        }

        // TEXT RESPONSE
        return { aiText: msg.content };

      } catch (err) {
        logError(reqId, "[runConversation ERROR]", err);
        return { aiText: "Internal error building trip." };
      }
    };

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];

    const response = await runConversation(convo);
    res.json(response);
  } catch (err) {
    logError(reqId, "[ROUTE ERROR]", err);
    res.status(500).json({ aiText: "System error." });
  }
});

export default router;
