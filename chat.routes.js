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
const SERP_API_KEY = process.env.SERPAPI_API_KEY; // New: Environment variable for SERP API key

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

// New: Function to perform a web search
async function performSearch(query, reqId) {
  logInfo(reqId, `Performing web search for: "${query}"`);
  if (!SERP_API_KEY) {
    logError(reqId, "SERP_API_KEY is not set. Cannot perform web search.");
    return JSON.stringify({ error: "SERP API key not configured." });
  }

  // Example using Serper.dev. You might use SerpApi, Google Custom Search, etc.
  // Adjust the URL and parsing based on your chosen provider.
  const searchUrl = `https://api.serper.dev/search`; 
  
  try {
    const res = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'X-API-KEY': SERP_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query }),
    });

    if (!res.ok) {
      logError(reqId, `SERP API error: ${res.status} ${res.statusText}`);
      return JSON.stringify({ error: `SERP API error: ${res.statusText}` });
    }

    const data = await res.json();
    // Return a concise summary of results, not the whole raw dump
    // The AI's prompt will guide it to pick relevant info.
    const organicResults = data.organic?.map(item => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet
    })) || [];

    const answerBox = data.answerBox?.snippet || data.answerBox?.answer || data.answerBox?.title;
    
    // Prioritize an answer box if available, otherwise provide top organic results
    if (answerBox) {
        return JSON.stringify({ answer: answerBox, topResults: organicResults.slice(0, 3) });
    }
    return JSON.stringify({ topResults: organicResults.slice(0, 5) }); // Return top 5
  } catch (e) {
    logError(reqId, "Failed to fetch from SERP API", e.message);
    return JSON.stringify({ error: `Failed to perform search: ${e.message}` });
  }
}

const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description: "Call this function to ask the user for their desired travel dates. Use this when dates are unknown but required for planning.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description: "Call this function to ask the user how many people are traveling (e.g., adults, children). Use this when the number of guests is unknown and you need this information to create a plan.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web", // New: Web search tool
      description: "Search the web for specific, factual information to enhance the travel plan. Use this for current weather, popular activities, specific restaurant suggestions, local transport options, or estimated prices for tours/activities. Always formulate concise, highly relevant queries.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The specific search query (e.g., 'weather in Paris in July', 'best museums in London', 'cost of Tokyo Tower tickets', 'family friendly restaurants in Rome')."
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
      // CHANGE: Emphasize the need for detailed and researched plans.
      description: "Call this function ONLY when the destination, dates, and number of guests are all known, AND you have gathered sufficient details via search_web to create a highly detailed, day-by-day travel plan with specific events (at least 3-5 per day), realistic times, specific suggestions (e.g., restaurant names, tour companies, exact attractions), and a comprehensive cost breakdown. Only call this when you have rich information.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "The city or primary travel location." },
          country: { type: "string", description: "The country of the travel location." },
          dateRange: { type: "string", description: "The start and end dates of the trip (e.g., 'July 10-17, 2024')." },
          description: { type: "string", description: "A summary of the trip, highlighting how it aligns with user preferences." },
          image: { type: "string", description: "URL of a relevant image for the destination." },
          price: { type: "number", description: "Estimated total cost of the trip." },
          weather: {
            type: "object",
            properties: { temp: { type: "number", description: "Average temperature in Celsius." }, icon: { type: "string", enum: ["sunny", "partly-sunny", "cloudy"], description: "Weather icon based on conditions." } },
            required: ["temp", "icon"]
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "Date in YYYY-MM-DD format." },
                day: { type: "string", description: "Day description, e.g., 'Dec 26'." },
                events: {
                  type: "array",
                  description: "A detailed list of events for the day, including specific activities, meals, and timings.",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", description: "Type of event (e.g., 'flight', 'activity', 'meal', 'relaxation')." },
                      icon: { type: "string", description: "An icon representing the event type." },
                      time: { type: "string", description: "Time of the event (e.g., '09:00 AM', 'Lunch', 'Evening')." },
                      duration: { type: "string", description: "Estimated duration (e.g., '2 hours', 'Overnight')." },
                      title: { type: "string", description: "Concise title for the event (e.g., 'Eiffel Tower Visit', 'Dinner at Le Jules Verne')." },
                      details: { type: "string", description: "Detailed description of the event, including specifics, addresses, booking info, or recommendations found via search." },
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
                item: { type: "string", description: "Item name (e.g., 'Flight', 'Hotel', 'Eiffel Tower Ticket')." },
                provider: { type: "string", description: "Service provider (e.g., 'Air France', 'The Ritz', 'Official Website')." },
                details: { type: "string", description: "Specific details about the cost item (e.g., 'Round trip, economy class', '3 nights, city view room')." },
                price: { type: "number", description: "Estimated price in USD." },
                iconType: { type: "string", enum: ["image", "date"], description: "Type of icon for the cost item." },
                iconValue: { type: "string", description: "URL for an image icon OR 'Month Day' for a date icon (e.g., 'Dec 26')." },
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


const getSystemPrompt = (profile) => `You are a world-class, professional AI travel agent. Your goal is to create inspiring, comprehensive, and highly personalized travel plans.

**CRITICAL RULES:**
1.  **USE THE PROFILE:** Meticulously analyze the user profile below. Every part of the plan—activities, hotel style, flight class, budget—must reflect their stated preferences. In the plan's 'description' field, explicitly mention how you used their preferences (e.g., "An active solo trip focusing on museums, as requested.").
2.  **HANDLE NEW REQUESTS:** After a plan is created (the user history will contain "[PLAN_SNAPSHOT]"), you MUST treat the next user message as a **brand new request**. Forget the previous destination and start the planning process over. If they say "now to China," you must start planning a trip to China.
3.  **BE COMPREHENSIVE & DETAILED:** A real plan covers everything. Your generated itinerary must be highly detailed, spanning multiple days with at least 3-5 varied events per day. For each event, provide specific, realistic details: actual activity names, real restaurant suggestions, estimated times, durations, and helpful descriptions.
4.  **UTILIZE SEARCH_WEB:** Before calling \`create_plan\`, you MUST use the \`search_web\` tool to gather concrete, up-to-date information for your plan. This includes:
    *   Current or historical weather for the travel dates/location.
    *   Popular attractions, tours, and activities matching the user's preferences.
    *   Specific, well-reviewed local restaurants or dining experiences.
    *   Estimated costs for flights, accommodation, specific activities, and transport.
    *   Any other factual details needed to make the plan realistic and compelling.
    When using \`search_web\`, create focused queries to get precise results. Do not just dump raw search results; synthesize the information to enrich the \`create_plan\` arguments.
5.  **STRICT DATA FORMAT:** You must call a function to get information or to create a plan. Never respond with just text if a function call is appropriate. Adhere perfectly to the function's JSON schema.
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
      if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
        // Handle multiple tool calls if the model generates them
        const toolOutputs = [];
        const assistantToolCalls = []; // To store tool calls from the assistant for the responsePayload

        for (const toolCall of assistantMessage.tool_calls) {
          const functionName = toolCall.function?.name;
          logInfo(reqId, `AI called tool: ${functionName}`);

          let args = {};
          try {
            args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
          } catch (e) {
            logError(reqId, `Failed to parse AI arguments for ${functionName}, using fallback.`, e);
            return res.json(await runFallbackFlow()); // Critical error, fallback
          }

          if (functionName === "create_plan") {
            args.image = await pickPhoto(args.location, reqId);
            if (args.weather && !["sunny", "partly-sunny", "cloudy"].includes(args.weather.icon)) {
              args.weather.icon = "sunny"; // Default if not valid
            }
            // For create_plan, we directly return the signal and don't need a tool_output to the AI
            return res.json({ 
                assistantMessage: {
                    ...assistantMessage, // Pass the original assistant message including tool_calls
                    content: assistantMessage.content || '',
                },
                signal: { type: "planReady", payload: args },
                aiText: "Here is your personalized plan!" 
            });
          } else if (functionName === "request_dates") {
            return res.json({ 
                assistantMessage: { ...assistantMessage, content: assistantMessage.content || '' },
                signal: { type: "dateNeeded" }, 
                aiText: "When would you like to travel?" 
            });
          } else if (functionName === "request_guests") {
            return res.json({ 
                assistantMessage: { ...assistantMessage, content: assistantMessage.content || '' },
                signal: { type: "guestsNeeded" }, 
                aiText: "How many people are traveling?" 
            });
          } else if (functionName === "search_web") {
            const searchResult = await performSearch(args.query, reqId);
            toolOutputs.push({
              tool_call_id: toolCall.id,
              output: searchResult,
            });
            assistantToolCalls.push(toolCall); // Store this toolCall
          }
        }

        // If search_web was called, send the tool outputs back to the model
        if (toolOutputs.length > 0) {
            const responseToToolCall = await client.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    ...convo, // Include previous conversation
                    {
                        role: "assistant",
                        tool_calls: assistantToolCalls // Include the actual tool calls made by the assistant
                    },
                    ...toolOutputs.map(output => ({
                        role: "tool",
                        tool_call_id: output.tool_call_id,
                        content: output.output // Send the stringified JSON output
                    }))
                ],
                tools,
                tool_choice: "auto",
            });
            
            const nextAssistantMessage = responseToToolCall.choices?.[0]?.message;
            if (nextAssistantMessage?.tool_calls && nextAssistantMessage.tool_calls.length > 0) {
                // If the AI makes another tool call (e.g., create_plan after search),
                // we'll process it in the next iteration or handle here.
                // For simplicity, let's just re-call the main handler with updated messages.
                // In a real-world scenario, you might want to manage state more explicitly.
                logInfo(reqId, "AI made another tool call after search. Re-processing.");
                // Add the assistant's previous tool calls and the tool outputs to the messages for the next call
                const updatedMessages = [
                    ...messages,
                    { role: 'assistant', tool_calls: assistantToolCalls, content: '' }, // Original tool call
                    ...toolOutputs.map(output => ({ role: 'tool', tool_call_id: output.tool_call_id, content: output.output })) // Tool results
                ];
                // Now, add the new assistant message (which might contain another tool_call or final text)
                if (nextAssistantMessage.tool_calls) {
                    updatedMessages.push({ role: 'assistant', tool_calls: nextAssistantMessage.tool_calls, content: nextAssistantMessage.content || '' });
                } else {
                     updatedMessages.push({ role: 'assistant', content: nextAssistantMessage.content || '' });
                }

                // Recursively call the route handler with the updated messages
                // This simulates the turn-taking with the AI
                req.body.messages = updatedMessages; 
                return router.handle(req, res); // Re-invoke the router for next step
            } else if (nextAssistantMessage?.content) {
                // If after search, the AI just responds with text, return it.
                return res.json({ aiText: nextAssistantMessage.content });
            }
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
