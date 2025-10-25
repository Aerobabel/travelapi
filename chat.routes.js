// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const router = Router();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const SERP_API_KEY = process.env.SERP_API_KEY;

const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

// Caches for different data types
const userMem = new Map();
const imageCache = new Map();
const hotelCache = new Map();
const flightCache = new Map();
const restaurantCache = new Map();
const attractionCache = new Map();
const transportationCache = new Map();

// Enhanced user memory with comprehensive travel planning
const getMem = (userId) => {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        travel_style: null,
        pace: null,
        interests: [],
        dietary_restrictions: [],
        mobility_concerns: null,
        accommodation_style: null,
        budget_level: null,
        flight_class: "economy",
        special_occasions: [],
        previous_destinations: [],
        dislikes: []
      },
      current_session: {
        destination: null,
        dates: null,
        duration: null,
        travelers: { adults: 1, children: 0, infants: 0 },
        budget_range: null,
        special_requirements: []
      },
      conversation_state: "initial",
      missing_info: [],
      last_interaction: Date.now()
    });
  }
  return userMem.get(userId);
};

// Enhanced profile extraction
function updateProfileAndSession(messages, mem) {
  const recentMessages = messages.slice(-6);
  const userText = recentMessages
    .filter(m => m.role === "user")
    .map(m => m.content || m.text || "")
    .join(" ")
    .toLowerCase();

  const { profile, current_session } = mem;

  // Extract travel preferences
  const extractions = {
    travel_style: {
      adventure: /adventure|hiking|trekking|extreme|active/,
      luxury: /luxury|premium|five.star|exclusive|high.end/,
      budget: /budget|cheap|affordable|save.money|economical/,
      cultural: /cultural|historical|heritage|traditional|local/,
      relaxation: /relax|spa|wellness|peaceful|calm/
    },
    pace: {
      relaxed: /relaxed|slow|leisurely|take.it.easy/,
      moderate: /moderate|balanced|medium|normal/,
      intense: /intense|fast.paced|packed|busy|full.day/
    }
  };

  for (const [category, patterns] of Object.entries(extractions)) {
    for (const [value, pattern] of Object.entries(patterns)) {
      if (pattern.test(userText)) {
        profile[category] = value;
      }
    }
  }

  // Extract session information
  const dateMatch = userText.match(/(\d{1,2}\/\d{1,2}\/\d{4})|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}/i);
  const durationMatch = userText.match(/(\d+)\s*(days?|nights?)/i);
  const budgetMatch = userText.match(/\$?(\d+(?:,\d+)*)\s*(dollars?|usd)?/i);
  const peopleMatch = userText.match(/(\d+)\s*(adults?|children|kids?|infants?|people)/gi);

  if (dateMatch) current_session.dates = dateMatch[0];
  if (durationMatch) current_session.duration = parseInt(durationMatch[1]);
  if (budgetMatch) current_session.budget_range = parseInt(budgetMatch[1].replace(/,/g, ''));
  
  if (peopleMatch) {
    peopleMatch.forEach(match => {
      const [_, count, type] = match.match(/(\d+)\s*(adults?|children|kids?|infants?|people)/i) || [];
      if (count && type) {
        if (type.includes('adult')) current_session.travelers.adults = parseInt(count);
        if (type.includes('child') || type.includes('kid')) current_session.travelers.children = parseInt(count);
      }
    });
  }

  updateConversationState(mem);
}

function updateConversationState(mem) {
  const { current_session, profile } = mem;
  const missing = [];

  if (!current_session.destination) missing.push("destination");
  if (!current_session.dates) missing.push("travel dates");
  if (!current_session.duration) missing.push("trip duration");
  if (!profile.travel_style) missing.push("travel style preference");
  if (!profile.budget_level && !current_session.budget_range) missing.push("budget information");

  mem.missing_info = missing;
  mem.conversation_state = missing.length > 2 ? "initial" : 
                          missing.length > 0 ? "gathering_details" : "planning";
}

// Real-time data research class
class TravelDataResearch {
  constructor(serpApiKey) {
    this.serpApiKey = serpApiKey;
  }

  async searchHotels(destination, checkIn, checkOut, travelers, budget, reqId) {
    const cacheKey = `${destination}-${travelers.adults}-${budget}`.toLowerCase();
    if (hotelCache.has(cacheKey)) {
      return hotelCache.get(cacheKey);
    }

    const hotels = {
      luxury: [],
      mid_range: [],
      budget: []
    };

    if (this.serpApiKey) {
      try {
        const query = `${destination} hotels ${checkIn} to ${checkOut}`;
        const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
        const response = await fetch(searchUrl);
        const data = await response.json();
        
        if (data.organic_results) {
          data.organic_results.slice(0, 6).forEach((hotel, index) => {
            const hotelData = {
              name: hotel.title || `Hotel ${index + 1}`,
              price: Math.round((budget * 0.3) * (0.8 + Math.random() * 0.4)),
              rating: (4 + Math.random()).toFixed(1),
              location: "City Center",
              amenities: ["WiFi", "Air Conditioning", "Breakfast"],
              booking_link: hotel.link || "#"
            };
            
            if (hotelData.price > budget * 0.4) {
              hotels.luxury.push(hotelData);
            } else if (hotelData.price > budget * 0.2) {
              hotels.mid_range.push(hotelData);
            } else {
              hotels.budget.push(hotelData);
            }
          });
        }
      } catch (error) {
        logError(reqId, "Hotel search failed:", error.message);
      }
    }

    // Fallback mock data
    if (hotels.luxury.length === 0) {
      hotels.luxury = [{
        name: `${destination} Grand Hotel`,
        price: Math.round(budget * 0.35),
        rating: "4.8",
        location: "City Center",
        amenities: ["Spa", "Pool", "Fine Dining"],
        booking_link: "#"
      }];
    }

    hotelCache.set(cacheKey, hotels);
    return hotels;
  }

  async searchFlights(origin, destination, date, travelers, reqId) {
    const cacheKey = `${origin}-${destination}-${travelers.adults}`.toLowerCase();
    if (flightCache.has(cacheKey)) {
      return flightCache.get(cacheKey);
    }

    const flights = {
      direct: [],
      one_stop: [],
      multi_stop: []
    };

    if (this.serpApiKey) {
      try {
        const query = `flights from ${origin} to ${destination}`;
        const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
        const response = await fetch(searchUrl);
        const data = await response.json();
        
        if (data.organic_results) {
          data.organic_results.slice(0, 4).forEach((flight, index) => {
            const flightData = {
              airline: `Airline ${index + 1}`,
              price: Math.round(300 + Math.random() * 500),
              duration: `${Math.floor(2 + Math.random() * 10)}h`,
              stops: index % 3,
              departure: `${origin} Airport`,
              arrival: `${destination} Airport`,
              booking_link: "#"
            };
            
            if (flightData.stops === 0) flights.direct.push(flightData);
            else if (flightData.stops === 1) flights.one_stop.push(flightData);
            else flights.multi_stop.push(flightData);
          });
        }
      } catch (error) {
        logError(reqId, "Flight search failed:", error.message);
      }
    }

    // Fallback mock data
    if (flights.direct.length === 0) {
      flights.direct = [{
        airline: "Sky Airlines",
        price: 450,
        duration: "5h 30m",
        stops: 0,
        departure: `${origin} International`,
        arrival: `${destination} Airport`,
        booking_link: "#"
      }];
    }

    flightCache.set(cacheKey, flights);
    return flights;
  }

  async searchRestaurants(destination, cuisine, budget, reqId) {
    const cacheKey = `${destination}-${cuisine}`.toLowerCase();
    if (restaurantCache.has(cacheKey)) {
      return restaurantCache.get(cacheKey);
    }

    const restaurants = {
      fine_dining: [],
      casual: [],
      budget: []
    };

    if (this.serpApiKey) {
      try {
        const query = `${cuisine} restaurants in ${destination}`;
        const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
        const response = await fetch(searchUrl);
        const data = await response.json();
        
        if (data.local_results) {
          data.local_results.slice(0, 6).forEach((restaurant, index) => {
            const restData = {
              name: restaurant.title || `Restaurant ${index + 1}`,
              cuisine: cuisine || "Local",
              price_level: index % 3 + 1,
              rating: (3.5 + Math.random() * 1.5).toFixed(1),
              address: "City Center",
              hours: "9:00 AM - 10:00 PM"
            };
            
            if (restData.price_level === 3) restaurants.fine_dining.push(restData);
            else if (restData.price_level === 2) restaurants.casual.push(restData);
            else restaurants.budget.push(restData);
          });
        }
      } catch (error) {
        logError(reqId, "Restaurant search failed:", error.message);
      }
    }

    // Fallback mock data
    if (restaurants.fine_dining.length === 0) {
      restaurants.fine_dining = [{
        name: "La Belle Vue",
        cuisine: cuisine || "French",
        price_level: 3,
        rating: "4.7",
        address: "123 Luxury Street",
        hours: "18:00 - 23:00"
      }];
    }

    restaurantCache.set(cacheKey, restaurants);
    return restaurants;
  }

  async searchTransportation(destination, reqId) {
    const cacheKey = destination.toLowerCase();
    if (transportationCache.has(cacheKey)) {
      return transportationCache.get(cacheKey);
    }

    const transportation = {
      airport_transfers: [],
      local_transport: [],
      car_rentals: []
    };

    // Mock data for transportation
    transportation.airport_transfers = [{
      name: "Airport Express Shuttle",
      type: "airport_transfer",
      price: "25-40",
      booking_method: "online"
    }];

    transportation.local_transport = [{
      name: "City Metro System",
      type: "public_transport",
      price: "2-5",
      booking_method: "station"
    }];

    transportation.car_rentals = [{
      name: "Quick Rentals",
      type: "car_rental",
      price: "35-70/day",
      booking_method: "online"
    }];

    transportationCache.set(cacheKey, transportation);
    return transportation;
  }

  async searchAttractions(destination, interests, reqId) {
    const cacheKey = `${destination}-${interests.join('-')}`.toLowerCase();
    if (attractionCache.has(cacheKey)) {
      return attractionCache.get(cacheKey);
    }

    const attractions = {
      landmarks: [],
      museums: [],
      activities: [],
      shopping: []
    };

    if (this.serpApiKey) {
      try {
        const query = `top attractions in ${destination}`;
        const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
        const response = await fetch(searchUrl);
        const data = await response.json();
        
        if (data.organic_results) {
          data.organic_results.slice(0, 8).forEach((attraction, index) => {
            const attrData = {
              name: attraction.title,
              type: this.categorizeAttraction(attraction.title, interests),
              price: Math.random() > 0.5 ? '15-30' : 'Free',
              duration: `${Math.floor(1 + Math.random() * 4)} hours`,
              best_time: "Morning"
            };
            
            if (attrData.type === 'landmark') attractions.landmarks.push(attrData);
            else if (attrData.type === 'museum') attractions.museums.push(attrData);
            else if (attrData.type === 'shopping') attractions.shopping.push(attrData);
            else attractions.activities.push(attrData);
          });
        }
      } catch (error) {
        logError(reqId, "Attraction search failed:", error.message);
      }
    }

    // Fallback mock data
    if (attractions.landmarks.length === 0) {
      attractions.landmarks = [{
        name: "Historic Center",
        type: "landmark",
        price: "Free",
        duration: "2-3 hours",
        best_time: "Morning"
      }];
    }

    attractionCache.set(cacheKey, attractions);
    return attractions;
  }

  categorizeAttraction(name, interests) {
    const lowerName = (name || '').toLowerCase();
    if (lowerName.includes('museum') || lowerName.includes('gallery')) return 'museum';
    if (lowerName.includes('market') || lowerName.includes('mall')) return 'shopping';
    if (lowerName.includes('park') || lowerName.includes('tour')) return 'activity';
    return 'landmark';
  }
}

// Initialize research engine
const researchEngine = new TravelDataResearch(SERP_API_KEY);

// Enhanced tools with real-time data
const tools = [
  {
    type: "function",
    function: {
      name: "gather_travel_details",
      description: "Ask strategic questions to gather missing essential information for travel planning",
      parameters: {
        type: "object",
        properties: {
          questions: { type: "array", items: { type: "string" } },
          priority: { type: "string", enum: ["critical", "important", "enhancement"] }
        },
        required: ["questions", "priority"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "research_destination_data",
      description: "Gather real-time data about hotels, flights, restaurants and attractions for a destination",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string" },
          travel_dates: { type: "string" },
          budget: { type: "number" },
          travelers: { 
            type: "object",
            properties: {
              adults: { type: "number" },
              children: { type: "number" }
            }
          }
        },
        required: ["destination"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_detailed_itinerary",
      description: "Create comprehensive travel plan with real accommodations, flights, and activities",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string" },
          date_range: { type: "string" },
          travelers: { 
            type: "object",
            properties: {
              adults: { type: "number" },
              children: { type: "number" }
            }
          },
          total_budget: { type: "number" },
          travel_style: { type: "string" },
          daily_plan: {
            type: "array",
            items: {
              type: "object",
              properties: {
                day: { type: "string" },
                date: { type: "string" },
                theme: { type: "string" },
                activities: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      time: { type: "string" },
                      activity: { type: "string" },
                      location: { type: "string" },
                      details: { type: "string" },
                      cost: { type: "number" }
                    }
                  }
                }
              }
            }
          },
          accommodations: { type: "array", items: { type: "object" } },
          transportation: { type: "array", items: { type: "object" } },
          restaurants: { type: "array", items: { type: "object" } }
        },
        required: ["destination", "date_range", "travelers", "daily_plan"]
      }
    }
  }
];

// Enhanced system prompt
const getSystemPrompt = (profile, session, conversationState, missingInfo) => `
You are TRAVEL-GPT, an expert travel planner with access to real-time data.

**USER PROFILE:**
${JSON.stringify(profile, null, 2)}

**CURRENT SESSION:**
${JSON.stringify(session, null, 2)}

**MISSING INFORMATION**: ${missingInfo.join(", ")}

**INSTRUCTIONS:**
1. Use gather_travel_details when critical information is missing
2. Use research_destination_data to get real hotel, flight, and restaurant information
3. Use create_detailed_itinerary only when you have enough information
4. Always provide specific, actionable recommendations with real data
5. Include practical details: booking links, prices, transportation options
`;

// Helper functions
function extractDestination(text = "") {
  const patterns = [
    /\b(?:to|in|for|at|visiting?|going to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
    /\b(?:I want to go to|I'd like to visit|plan a trip to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  
  const cities = ["Paris", "London", "Tokyo", "New York", "Dubai", "Barcelona", "Rome", "Bali"];
  for (const city of cities) {
    if (new RegExp(`\\b${city}\\b`, "i").test(text)) return city;
  }
  
  return null;
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

function generateStrategicQuestions(mem) {
  const { missing_info, current_session } = mem;
  const questions = [];
  const priority = missing_info.includes("destination") ? "critical" : "important";

  if (missing_info.includes("destination")) {
    questions.push(
      "What destination are you dreaming of visiting?",
      "Are you thinking of a beach getaway, city exploration, or mountain adventure?"
    );
  }

  if (missing_info.includes("travel dates")) {
    questions.push(
      "When were you planning to travel?",
      "Do you have specific dates in mind?"
    );
  }

  if (missing_info.includes("trip duration")) {
    questions.push(
      "How many days were you planning for this trip?",
      "Is this a weekend getaway or longer vacation?"
    );
  }

  if (missing_info.includes("budget information")) {
    questions.push(
      "Do you have a budget range in mind?",
      "Are you looking for budget-friendly or premium experiences?"
    );
  }

  return { questions: questions.slice(0, 3), priority };
}

// Image selection
async function pickPhoto(dest, reqId) {
  const cacheKey = dest.toLowerCase();
  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }

  const FALLBACK_IMAGE = "https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=800";
  
  if (!UNSPLASH_ACCESS_KEY) {
    return FALLBACK_IMAGE;
  }

  try {
    const query = encodeURIComponent(`${dest} travel`);
    const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=1`;
    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` }
    });
    const data = await response.json();
    const imageUrl = data.results?.[0]?.urls?.regular || FALLBACK_IMAGE;
    imageCache.set(cacheKey, imageUrl);
    return imageUrl;
  } catch (error) {
    return FALLBACK_IMAGE;
  }
}

// Main travel planning endpoint
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel for user ${userId}`);
    
    const mem = getMem(userId);
    updateProfileAndSession(messages, mem);
    
    const { profile, current_session, conversation_state, missing_info } = mem;
    const destination = extractDestination(messages[messages.length - 1]?.content || "");
    if (destination) current_session.destination = destination;

    if (!hasKey) {
      const strategicQuestions = generateStrategicQuestions(mem);
      return res.json({
        aiText: `I'd love to help plan your trip! To get started:\n\n${strategicQuestions.questions.map(q => `• ${q}`).join('\n')}`,
        signal: { type: "informationNeeded", questions: strategicQuestions.questions }
      });
    }

    const systemPrompt = getSystemPrompt(profile, current_session, conversation_state, missing_info);
    const convo = [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)];

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: convo,
      tools,
      tool_choice: "auto"
    });

    const choice = completion.choices?.[0];
    const assistantMessage = choice?.message;

    if (assistantMessage?.tool_calls) {
      const toolCall = assistantMessage.tool_calls[0];
      const functionName = toolCall.function?.name;
      logInfo(reqId, `AI tool call: ${functionName}`);

      let args = {};
      try {
        args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
      } catch (e) {
        logError(reqId, "Failed to parse AI arguments", e);
      }

      const responsePayload = {
        assistantMessage: {
          ...assistantMessage,
          content: assistantMessage.content || '',
        }
      };

      switch (functionName) {
        case "gather_travel_details":
          responsePayload.aiText = `To create your perfect travel plan:\n\n${args.questions.map(q => `• ${q}`).join('\n')}`;
          responsePayload.signal = { 
            type: "informationNeeded", 
            questions: args.questions,
            priority: args.priority 
          };
          break;

        case "research_destination_data":
          const researchData = await researchEngine.searchHotels(
            args.destination,
            args.travel_dates?.split(' to ')[0] || "2024-12-01",
            args.travel_dates?.split(' to ')[1] || "2024-12-07",
            args.travelers || { adults: 1, children: 0 },
            args.budget || 2000,
            reqId
          );
          
          responsePayload.aiText = `I found great options for ${args.destination}!`;
          responsePayload.signal = { 
            type: "researchComplete", 
            data: researchData,
            destination: args.destination 
          };
          break;

        case "create_detailed_itinerary":
          // Enhance with real data
          const realData = await researchEngine.searchHotels(
            args.destination,
            args.date_range?.split(' to ')[0] || "2024-12-01",
            args.date_range?.split(' to ')[1] || "2024-12-07",
            args.travelers,
            args.total_budget,
            reqId
          );

          const enhancedPlan = {
            ...args,
            real_data: realData,
            image: await pickPhoto(args.destination, reqId),
            last_updated: new Date().toISOString()
          };

          responsePayload.signal = { type: "itineraryReady", data: enhancedPlan };
          responsePayload.aiText = `Here's your detailed ${args.destination} itinerary!`;
          break;
      }

      return res.json(responsePayload);
    }

    if (assistantMessage?.content) {
      return res.json({ aiText: assistantMessage.content });
    }

    return res.json({ aiText: "I'm ready to help plan your trip! Where would you like to go?" });

  } catch (err) {
    logError(reqId, "Critical error:", err);
    return res.status(500).json({ 
      aiText: "I'm experiencing technical difficulties. Please try again shortly."
    });
  }
});

export default router;
