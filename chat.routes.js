import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import Amadeus from 'amadeus';

dotenv.config();

// --- SETUP: EXPRESS, OPENAI, AMADEUS ---
const router = Router();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const amadeus = (process.env.AMADEUS_API_KEY && process.env.AMADEUS_API_SECRET) 
    ? new Amadeus({
        clientId: process.env.AMADEUS_API_KEY,
        clientSecret: process.env.AMADEUS_API_SECRET,
      })
    : null;

// --- LOGGING & CACHING HELPERS ---
const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);
const imageCache = new Map();

// --- USER PROFILE MANAGEMENT (Unchanged) ---
const userMem = new Map();
const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        preferred_travel_type: [], travel_alone_or_with: null, desired_experience: [],
        flight_preferences: { class: "economy" }, flight_priority: [],
        accommodation: { preferred_type: null, prefer_view: "doesn't matter" },
        budget: { prefer_comfort_or_saving: "balanced" }, preferred_formats: [], liked_activities: [],
      },
    });
  }
  return userMem.get(userId);
};
function updateProfileFromHistory(messages, mem) { /* Your existing function here, unchanged */ }

// --- DATA PARSING HELPERS ---
function deriveGuestCount(messages) {
    const userTexts = messages.filter(m => m.role === 'user').map(m => m.text ?? m.content ?? '').join('\n').toLowerCase();
    const match = userTexts.match(/(\d+)\s*(adults|guests|people|person)/);
    return match ? parseInt(match[1], 10) : 1;
}

// --- EXTERNAL API SERVICES ---

const getCityCode = async (cityName) => {
  if (!amadeus) return null;
  if (!cityName) return null;
  try {
    const response = await amadeus.referenceData.locations.get({ keyword: cityName, subType: Amadeus.location.city });
    return response.data[0]?.iataCode;
  } catch (err) {
    console.error("[Amadeus] Failed to get city code:", err?.description || err);
    return null;
  }
};

const TravelData = {
  async find_flights(origin_airport, destination, departure_date, return_date, num_adults) {
    if (!amadeus) return "Amadeus API is not configured.";
    logInfo(`[Amadeus] Searching flights: ${origin_airport} -> ${destination} for ${num_adults} adults.`);
    const destinationCode = await getCityCode(destination);
    if (!destinationCode) return `Could not find a valid airport code for the destination: ${destination}.`;
    
    try {
      const response = await amadeus.shopping.flightOffersSearch.get({
        originLocationCode: origin_airport,
        destinationLocationCode: destinationCode,
        departureDate: departure_date,
        ...(return_date && { returnDate: return_date }), // Conditionally add returnDate
        adults: String(num_adults),
        max: 5,
        currencyCode: 'USD',
      });
      if (!response.data || response.data.length === 0) {
        return "No flights found for the specified route and dates.";
      }
      return response.data.map(offer => ({
        price: parseFloat(offer.price.total),
        airline: offer.validatingAirlineCodes[0],
        outbound_summary: `Departs: ${offer.itineraries[0].segments[0].departure.at}, Arrives: ${offer.itineraries[0].segments[offer.itineraries[0].segments.length - 1].arrival.at}`,
        return_summary: offer.itineraries[1] ? `Departs: ${offer.itineraries[1].segments[0].departure.at}, Arrives: ${offer.itineraries[1].segments[offer.itineraries[1].segments.length - 1].arrival.at}` : 'N/A',
      }));
    } catch (err) {
      console.error("[Amadeus] Flight search error:", err?.description || err);
      return `Flight search failed: ${err?.description?.detail || "An error occurred."}`;
    }
  },
  async find_hotels(location, check_in, check_out, num_adults) {
    if (!amadeus) return "Amadeus API is not configured.";
    logInfo(`[Amadeus] Searching hotels in ${location} for ${num_adults} adults.`);
    const cityCode = await getCityCode(location);
    if (!cityCode) return `Could not find a valid city code for the location: ${location}.`;

    try {
      const response = await amadeus.shopping.hotelOffersSearch.get({ cityCode, checkInDate: check_in, checkOutDate: check_out, adults: String(num_adults), bestRateOnly: true });
      if (!response.data || response.data.length === 0) {
        return "No hotels found for the specified location and dates.";
      }
      return response.data.map(hotelOffer => ({
        name: hotelOffer.hotel.name,
        price_per_night: parseFloat(hotelOffer.offers[0].price.total),
        rating: hotelOffer.hotel.rating,
      }));
    } catch (err) {
      console.error("[Amadeus] Hotel search error:", err?.description || err);
      return `Hotel search failed: ${err?.description?.detail || "An error occurred."}`;
    }
  }
};

async function pickPhoto(dest, reqId) { /* Your existing function here, unchanged */ }

// --- AI CONFIGURATION: TOOLS AND SYSTEM PROMPT ---

const tools = [
  { type: "function", function: { name: "request_dates", description: "Use this if you need the user's desired travel dates.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "request_guests", description: "Use this if you need to know how many people are traveling.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: {
      name: "find_flights", description: "Search for real-time flight availability and pricing. You must call this before creating a plan.",
      parameters: { type: "object", properties: {
          origin_airport: { type: "string", description: "The 3-letter IATA code for the departure airport (e.g., JFK, LAX). You must ask the user for this if you don't have it." },
          destination: { type: "string", description: "The destination city name (e.g., Paris, Tokyo)." },
          departure_date: { type: "string", description: "Format: YYYY-MM-DD" },
          return_date: { type: "string", description: "Format: YYYY-MM-DD. Optional for one-way trips." },
      }, required: ["origin_airport", "destination", "departure_date"] },
  }},
  { type: "function", function: {
      name: "find_hotels", description: "Search for real-time hotel availability and pricing. You must call this before creating a plan.",
      parameters: { type: "object", properties: {
          location: { type: "string", description: "The city where to search for hotels." },
          check_in: { type: "string", description: "Format: YYYY-MM-DD" },
          check_out: { type: "string", description: "Format: YYYY-MM-DD" },
      }, required: ["location", "check_in", "check_out"] },
  }},
  { type: "function", function: {
      name: "create_plan", description: "Return a full travel plan ONLY after gathering all necessary real-time flight and hotel data.",
      parameters: { /* Your original, large schema from your first post, unchanged */ },
  }},
];

const getSystemPrompt = (profile) => `You are a world-class, professional AI travel agent.
**CRITICAL EXECUTION PATH:**
1.  **GATHER INFO:** If destination, dates, guest count, or origin airport are missing, ask for them. You MUST have the origin airport's 3-letter IATA code. Use your tools \`request_dates\` or \`request_guests\` for this.
2.  **SEARCH REAL DATA:** Once you have the basics, you **MUST** call \`find_flights\` and \`find_hotels\` to get real-time data. DO NOT make up prices or details.
3.  **ANALYZE & SELECT:** Review the search results from the tools. Based on the user's profile (e.g., 'budget' vs 'comfort'), select the most suitable flight and hotel. If the search tools return no results, inform the user and ask them to try different dates or locations.
4.  **CREATE FINAL PLAN:** Only after getting successful results from the search tools, call \`create_plan\` using the **specific, real details** you found.
USER PROFILE: ${JSON.stringify(profile, null, 2)}`;


// --- MAIN ROUTE: THE AGENT LOOP ---

const normalizeMessages = (messages = []) => {
    // This function ensures all message formats are consistent with the OpenAI API
    return messages
      .filter(m => !m.hidden) // Filter out hidden messages
      .map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
        }
        if (m.role === 'ai') { // Convert 'ai' role to 'assistant'
          return { role: 'assistant', content: m.text };
        }
        // Handle user messages that might have text or content
        return { role: m.role, content: m.text ?? m.content };
      });
};

router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    if (!hasKey || !amadeus) return res.status(500).json({ aiText: "Server is not configured correctly." });
    
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel, user=${userId}, messages=${messages.length}`);
    
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    let convo = [
      { role: "system", content: getSystemPrompt(mem.profile) },
      ...normalizeMessages(messages)
    ];
    
    let maxTurns = 5;
    
    while (maxTurns > 0) {
      maxTurns--;

      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: convo,
        tools,
        tool_choice: "auto",
      });

      const message = completion.choices[0].message;
      convo.push(message); // Add assistant's response to history immediately

      if (!message.tool_calls) {
        // The AI responded with a simple text message. We are done.
        logInfo(reqId, "Agent responded with text. Ending loop.");
        return res.json({ aiText: message.content });
      }

      // --- Process Tool Calls ---
      const toolCall = message.tool_calls[0];
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      logInfo(reqId, `Agent wants to call tool: ${functionName}`, args);
      
      // These tools require user interaction and thus break the loop to respond to the frontend.
      if (functionName === "request_dates" || functionName === "request_guests") {
        logInfo(reqId, `Asking frontend for info: ${functionName}`);
        return res.json({
          aiText: message.content || `I need some more information.`,
          assistantMessage: message, // CRITICAL: Send the message with the tool_call_id
          signal: { type: functionName === "request_dates" ? "dateNeeded" : "guestsNeeded" },
        });
      }

      if (functionName === "create_plan") {
        logInfo(reqId, "Agent is creating the final plan.");
        args.image = await pickPhoto(args.location, reqId);
        return res.json({
          aiText: message.content || "Here is your personalized, real-time plan!",
          signal: { type: "planReady", payload: args },
        });
      }

      // These tools are internal; the loop continues after they run.
      let toolResult;
      const numAdults = deriveGuestCount(messages);

      if (functionName === "find_flights") {
        toolResult = await TravelData.find_flights(args.origin_airport, args.destination, args.departure_date, args.return_date, numAdults);
      } else if (functionName === "find_hotels") {
        toolResult = await TravelData.find_hotels(args.location, args.check_in, args.check_out, numAdults);
      } else {
        toolResult = { error: "Unknown tool called" };
      }

      logInfo(reqId, `Tool ${functionName} returned:`, toolResult);
      convo.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
      // Continue loop to let AI process the tool's result
    }
    
    logError(reqId, "Agent loop timed out.");
    return res.status(500).json({ aiText: "I'm having trouble creating a plan right now. Please try again." });

  } catch (err) {
    logError(reqId, `Critical handler error:`, err);
    return res.status(500).json({ aiText: "A critical server error occurred. Please try again." });
  }
});

export default router;
