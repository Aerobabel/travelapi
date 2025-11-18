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
        preferred_travel_type: [],
        travel_alone_or_with: null,
        budget: { prefer_comfort_or_saving: "balanced" },
        liked_activities: [],
      },
    });
  }
  return userMem.get(userId);
};

function updateProfileFromHistory(messages, mem) {
  // Simple logic to keep memory fresh (abbreviated for clarity)
}

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

// --- 3. TOOLS (Strict Format Enforcement) ---
const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "MANDATORY: Call this immediately if the user has not provided a specific timeframe or dates.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "MANDATORY: Call this immediately if the user has not specified the number of people traveling.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Call this ONLY when Destination, Dates, and Guest Count are all known.",
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
                // FIX: Strict date formatting instruction
                day: { type: "string", description: "Strict Format: 'MMM DD' (e.g., 'Nov 02', 'Oct 14'). Do NOT use 'Day 1' or 'Friday'." },
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
                    required: ["type", "icon", "time", "duration", "title", "details"],
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
              required: ["item", "provider", "details", "price", "iconType", "iconValue"],
            },
          },
        },
        required: ["location", "country", "dateRange", "description", "price", "itinerary", "costBreakdown"],
      },
    },
  },
];

// --- 4. SYSTEM PROMPT (Gatekeeper Logic) ---
const getSystemPrompt = (profile) => `You are a high-end AI Travel Architect.

**GATEKEEPER RULES (FOLLOW STRICTLY):**
1. **Check Information:** Do you know the user's DESTINATION? Do you know the DATES? Do you know the GUEST COUNT?
2. **Missing Dates?** -> STOP. Call \`request_dates\`. Do not generate a plan yet.
3. **Missing Guests?** -> STOP. Call \`request_guests\`. Do not generate a plan yet.
4. **Have All Data?** -> Call \`create_plan\`.

**ITINERARY GUIDELINES:**
- **Concrete Details:** Do not say "Visit a cafe". Say "Coffee at *Cafe Pouchkine* ($12)".
- **Date Format:** You MUST use "MMM DD" format for the 'day' field (e.g., "Nov 02", "Dec 25"). NEVER use "Day 1" or "Monday".
- **Weather:** Estimate realistic weather for the season.

**USER PROFILE:**
${JSON.stringify(profile, null, 2)}
`;

// --- 5. Route Handler ---

function normalizeMessages(messages = []) {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
        if (m.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: m.tool_call_id,
                content: m.content
            };
        }
        const role = allowedRoles.has(m.role) ? m.role : 'user';
        // Convert plan payloads to text summaries so the AI remembers previous plans
        let content = m.content ?? m.text ?? '';
        if (!content && m.payload) {
            content = `[System: I previously created a plan for ${m.payload.location}. New request?]`;
        }
        
        return { role, content: String(content) };
    });
}

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey) return res.json({ aiText: "API Key missing. Cannot plan." });

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];

    try {
      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: convo,
        tools,
        tool_choice: "auto",
        temperature: 0.2, // Lower temperature reduces hallucination of dates/guests
      });

      const choice = completion.choices?.[0];
      const assistantMessage = choice?.message;

      // --- HANDLE TOOLS ---
      if (assistantMessage?.tool_calls) {
        const toolCall = assistantMessage.tool_calls[0];
        const fnName = toolCall.function?.name;
        let args = {};
        try { args = JSON.parse(toolCall.function.arguments); } catch (e) {}

        const responsePayload = {
            assistantMessage: {
                ...assistantMessage,
                content: assistantMessage.content || '', 
            }
        };

        if (fnName === "request_dates") {
          responsePayload.signal = { type: "dateNeeded" };
          responsePayload.aiText = "When are you planning to travel?"; 
          return res.json(responsePayload);
        }

        if (fnName === "request_guests") {
          responsePayload.signal = { type: "guestsNeeded" };
          responsePayload.aiText = "Who is traveling with you?";
          return res.json(responsePayload);
        }

        if (fnName === "create_plan") {
          args.image = await pickPhoto(args.location, reqId);
          
          if (args.weather && !["sunny", "partly-sunny", "cloudy"].includes(args.weather.icon)) {
             args.weather.icon = "sunny";
          }

          responsePayload.signal = { type: "planReady", payload: args };
          responsePayload.aiText = `I've planned your trip to ${args.location}!`;
          return res.json(responsePayload);
        }
      }

      // --- HANDLE TEXT ---
      if (assistantMessage?.content) {
        return res.json({ aiText: assistantMessage.content });
      }

      return res.json({ aiText: "I'm ready to plan. Where would you like to go?" });

    } catch (e) {
      logError(reqId, "OpenAI Error", e);
      return res.json({ aiText: "I'm currently offline. Please try again later." });
    }
  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    return res.status(500).json({ aiText: "Server error." });
  }
});

export default router;
