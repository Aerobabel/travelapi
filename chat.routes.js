// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

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
        desired_experience: [],
        flight_preferences: { class: "economy" },
        flight_priority: [],
        accommodation: { preferred_type: null, prefer_view: "doesn't matter" },
        budget: { prefer_comfort_or_saving: "balanced" },
        preferred_formats: [],
        liked_activities: [],
      },
      lastDest: null,
    });
  }
  return userMem.get(userId);
};

function updateProfileFromHistory(messages, mem) {
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => (m.text ?? m.content ?? ""))
    .join(" ")
    .toLowerCase();

  const { profile } = mem;
  const mappings = {
    preferred_travel_type: {
      beach: /beach/,
      active: /active|hiking|adventure/,
      urban: /city|urban/,
      relaxing: /relax|spa|leisure/,
    },
    travel_alone_or_with: {
      solo: /solo|by myself/,
      family: /family|with my kids/,
      friends: /friends|group/,
    },
    "flight_preferences.class": {
      premium_economy: /premium economy/,
      business: /business class/,
      first: /first class/,
    },
    "budget.prefer_comfort_or_saving": { comfort: /comfort|luxury/, saving: /saving|budget/ },
    liked_activities: {
      hiking: /hiking/,
      "wine tasting": /wine/,
      museums: /museum/,
      shopping: /shopping/,
      "extreme sports": /extreme sports|adrenaline/,
    },
  };

  for (const key in mappings) {
    for (const value in mappings[key]) {
      if (mappings[key][value].test(userTexts)) {
        if (key.includes(".")) {
          const [p, c] = key.split(".");
          profile[p][c] = value;
        } else if (Array.isArray(profile[key])) {
          if (!profile[key].includes(value)) profile[key].push(value);
        } else {
          profile[key] = value;
        }
      }
    }
  }
}

const cityList = [
  "Paris",
  "London",
  "Rome",
  "Barcelona",
  "Bali",
  "Tokyo",
  "New York",
  "Dubai",
  "Istanbul",
  "Amsterdam",
  "Madrid",
  "Milan",
  "Kyoto",
  "Lisbon",
  "Prague",
  "China",
];
function extractDestination(text = "") {
  const m = text.match(/\b(to|in|for|at)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (m) return m[2];
  for (const city of cityList) {
    if (new RegExp(`\\b${city}\\b`, "i").test(text)) return city;
  }
  return null;
}

const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1470&auto=format&fit=crop";

async function pickPhoto(dest, reqId) {
  const cacheKey = (dest || "").toLowerCase().trim();
  if (!cacheKey) return FALLBACK_IMAGE_URL;
  if (imageCache.has(cacheKey)) {
    logInfo(reqId, `[CACHE HIT] Serving image for "${dest}"`);
    return imageCache.get(cacheKey);
  }
  logInfo(reqId, `[CACHE MISS] Fetching new image for "${dest}"`);
  
  if (!UNSPLASH_ACCESS_KEY) {
    logError(reqId, "UNSPLASH_ACCESS_KEY is not set. Returning fallback image.");
    return FALLBACK_IMAGE_URL;
  }

  const query = encodeURIComponent(`${dest} travel`);
  const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
    if (!res.ok) {
      logError(reqId, `Unsplash API error: ${res.status} ${res.statusText}`);
      return FALLBACK_IMAGE_URL;
    }
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const imageUrl = data.results[0].urls.regular;
      logInfo(reqId, `Found image for "${dest}": ${imageUrl}`);
      imageCache.set(cacheKey, imageUrl);
      return imageUrl;
    } else {
      logInfo(reqId, `No Unsplash results found for "${dest}".`);
      return FALLBACK_IMAGE_URL;
    }
  } catch (e) {
    logError(reqId, "Failed to fetch from Unsplash API", e.message);
    return FALLBACK_IMAGE_URL;
  }
}

// --- START OF MODIFIED CODE ---
const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      // CHANGE: The description is now an explicit command for the AI.
      description: "Call this function to ask the user for their desired travel dates. Use this when dates are unknown but required for planning.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      // CHANGE: This is the key fix. The new description is a clear, direct instruction, telling the AI exactly when and why to use this tool.
      description: "Call this function to ask the user how many people are traveling (e.g., adults, children). Use this when the number of guests is unknown and you need this information to create a plan.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      // CHANGE: Slightly rephrased for clarity, ensuring it's only called when all prerequisite information is available.
      description: "Call this function ONLY when the destination, dates, and number of guests are all known. It will return a full, detailed, day-by-day travel plan with a cost breakdown.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string" },
          description: { type: "string" },
          image: { type: "string" },
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
                day: { type: "string", description: "e.g., Dec 26" },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string" },
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
                iconType: { type: "string", enum: ["image", "date"] },
                iconValue: {
                  type: "string",
                  description: "A URL for the image OR 'Month Day' for date (e.g., 'Dec 26')",
                },
              },
              required: ["item", "provider", "details", "price", "iconType", "iconValue"],
            },
          },
        },
        required: [
          "location",
          "country",
          "dateRange",
          "description",
          "image",
          "price",
          "itinerary",
          "costBreakdown",
        ],
      },
    },
  },
];
// --- END OF MODIFIED CODE ---


const getSystemPrompt = (profile) => `You are a world-class, professional AI travel agent. Your goal is to create inspiring, comprehensive, and highly personalized travel plans.

**CRITICAL RULES:**
1.  **USE THE PROFILE:** Meticulously analyze the user profile below. Every part of the plan—activities, hotel style, flight class, budget—must reflect their stated preferences. In the plan's 'description' field, explicitly mention how you used their preferences (e.g., "An active solo trip focusing on museums, as requested.").
2.  **HANDLE NEW REQUESTS:** After a plan is created (the user history will contain "[PLAN_SNAPSHOT]"), you MUST treat the next user message as a **brand new request**. Forget the previous destination and start the planning process over. If they say "now to China," you must start planning a trip to China.
3.  **BE COMPREHENSIVE:** A real plan covers everything. Your generated itinerary must be detailed, spanning multiple days with at least 3-5 varied events per day (e.g., flights, transfers, meals at real local restaurants, tours, museum visits, relaxation time).
4.  **STRICT DATA FORMAT:** You must call a function to get information or to create a plan. Never respond with just text if a function call is appropriate. Adhere perfectly to the function's JSON schema.
    -   \`weather.icon\`: Must be one of: "sunny", "partly-sunny", "cloudy".
    -   \`itinerary.date\`: MUST be in 'YYYY-MM-DD' format.
    -   \`itinerary.day\`: MUST be in 'Mon Day' format (e.g., 'Dec 26').

**USER PROFILE:**
${JSON.stringify(profile, null, 2)}
`;

const lastSnapshotIdx = (h = []) => {
  for (let i = h.length - 1; i >= 0; i--) if (/\[plan_snapshot\]/i.test(h[i]?.text || "")) return i;
  return -1;
};

function deriveSlots(history = []) {
  const relevantHistory = history.slice(lastSnapshotIdx(history) + 1);
  const userTexts = relevantHistory
    .filter((m) => m.role === "user")
    .map((m) => (m.text ?? m.content ?? ""))
    .join("\n")
    .toLowerCase();
  const datesKnown = /📅|from\s+\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(userTexts);
  const guestsKnown = /👤|adult|children|kids|guests?|people/i.test(userTexts) && /\d/.test(userTexts);
  const destination = extractDestination(userTexts);
  return { destinationKnown: !!destination, destination, datesKnown, guestsKnown };
}

function normalizeMessages(messages = []) {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
        // The new `tool` role has a different structure
        if (m.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: m.tool_call_id,
                content: m.content
            };
        }
        const role = allowedRoles.has(m.role) ? m.role : 'user';
        const content = m.content ?? m.text ?? '';
        return { role, content: String(content) };
    });
}

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel, user=${userId}, hasKey=${hasKey}, fetch=${FETCH_SOURCE}`);
    const mem = getMem(userId);

    updateProfileFromHistory(messages, mem);

    const runFallbackFlow = async () => {
      const slots = deriveSlots(messages);
      logInfo(reqId, "Running fallback flow. Slots:", slots);
      if (!slots.destinationKnown)
        return { aiText: "Where would you like to go on your next adventure?" };
      if (!slots.datesKnown)
        return {
          aiText: `Sounds exciting! When would you like to go to ${slots.destination}?`,
          signal: { type: "dateNeeded" },
        };
      if (!slots.guestsKnown)
        return { aiText: "And how many people will be traveling?", signal: { type: "guestsNeeded" } };

      const payload = {
        location: slots.destination,
        country: "Unavailable",
        dateRange: "N/A",
        description: "This is a fallback plan. The AI planner is currently unavailable.",
        image: await pickPhoto(slots.destination, reqId),
        price: 0,
        itinerary: [],
        costBreakdown: [],
      };
      return { aiText: "The AI planner is temporarily unavailable, but here is a basic outline.", signal: { type: "planReady", payload } };
    };

    if (!hasKey) {
      logInfo(reqId, "No API key found. Responding with fallback flow.");
      return res.json(await runFallbackFlow());
    }

    const systemPrompt = getSystemPrompt(mem.profile);
    const convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];

    try {
      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: convo,
        tools,
        tool_choice: "auto",
      });

      const choice = completion.choices?.[0];
      const assistantMessage = choice?.message;

      // Check for tool calls first
      if (assistantMessage?.tool_calls) {
        const toolCall = assistantMessage.tool_calls[0];
        const functionName = toolCall.function?.name;
        logInfo(reqId, `AI called tool: ${functionName}`);

        let args = {};
        try {
          args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        } catch (e) {
          logError(reqId, "Failed to parse AI arguments, using fallback.", e);
          return res.json(await runFallbackFlow());
        }

        // We need to return the assistant's message so the frontend can add it to the history
        // for the subsequent tool response message.
        const responsePayload = {
            assistantMessage: {
                ...assistantMessage,
                content: assistantMessage.content || '', // Ensure content is not null
            }
        };

        if (functionName === "create_plan") {
          args.image = await pickPhoto(args.location, reqId);
          if (args.weather && !["sunny", "partly-sunny", "cloudy"].includes(args.weather.icon)) {
            args.weather.icon = "sunny";
          }
          responsePayload.signal = { type: "planReady", payload: args };
          responsePayload.aiText = "Here is your personalized plan!";
          return res.json(responsePayload);
        }
        if (functionName === "request_dates") {
          responsePayload.signal = { type: "dateNeeded" };
          responsePayload.aiText = "When would you like to travel?";
          return res.json(responsePayload);
        }
        if (functionName === "request_guests") {
          responsePayload.signal = { type: "guestsNeeded" };
          responsePayload.aiText = "How many people are traveling?";
          return res.json(responsePayload);
        }
      }

      // If no tool call, but there is content, return it
      if (assistantMessage?.content) {
        return res.json({ aiText: assistantMessage.content });
      }

      // If neither tool call nor content, use fallback
      logInfo(reqId, "AI did not call a tool or return text. Using fallback.");
      return res.json(await runFallbackFlow());

    } catch (e) {
      logError(reqId, "OpenAI API call failed. Responding with fallback flow.", e);
      return res.json(await runFallbackFlow());
    }
  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    return res.status(500).json({ aiText: "A critical server error occurred. Please try again." });
  }
});

export default router;
