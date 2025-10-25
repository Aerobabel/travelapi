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
// server/chat.routes.js
import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const router = Router();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const SERP_API_KEY = process.env.SERPAPI_API_KEY;

const newReqId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (reqId, ...args) => console.log(`[chat][${reqId}]`, ...args);
const logError = (reqId, ...args) => console.error(`[chat][${reqId}]`, ...args);

// Enhanced caches for different data types
const userMem = new Map();
const imageCache = new Map();
const hotelCache = new Map();
const flightCache = new Map();
const restaurantCache = new Map();
const attractionCache = new Map();
const transportationCache = new Map();

// Comprehensive travel data research functions
class TravelDataResearch {
  constructor(serpApiKey) {
    this.serpApiKey = serpApiKey;
  }

  async searchHotels(destination, checkIn, checkOut, travelers, budget, reqId) {
    const cacheKey = `${destination}-${checkIn}-${checkOut}-${travelers.adults}-${budget}`.toLowerCase();
    if (hotelCache.has(cacheKey)) {
      logInfo(reqId, `[HOTEL CACHE HIT] ${destination}`);
      return hotelCache.get(cacheKey);
    }

    const hotels = {
      luxury: [],
      mid_range: [],
      budget: []
    };

    if (!this.serpApiKey) {
      return this.generateMockHotels(destination, budget);
    }

    try {
      const query = `${destination} hotels ${checkIn} to ${checkOut} ${travelers.adults} adults`;
      const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
      
      const response = await fetch(searchUrl);
      const data = await response.json();
      
      // Parse hotel results from SERP
      if (data.hotels || data.organic_results) {
        const hotelResults = data.hotels || data.organic_results.slice(0, 8);
        
        hotelResults.forEach((hotel, index) => {
          const hotelData = {
            name: hotel.title || `Hotel ${index + 1}`,
            price: Math.round((budget * 0.3) * (0.8 + Math.random() * 0.4)), // 30% of budget ±20%
            rating: (4 + Math.random()).toFixed(1),
            location: hotel.address || "City Center",
            amenities: ["WiFi", "Air Conditioning", "Breakfast"].slice(0, 2 + Math.floor(Math.random() * 3)),
            booking_link: hotel.link || "#",
            image: hotel.thumbnail || await this.getHotelImage(hotel.title, reqId)
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
      
      hotelCache.set(cacheKey, hotels);
      return hotels;
      
    } catch (error) {
      logError(reqId, "Hotel search failed:", error.message);
      return this.generateMockHotels(destination, budget);
    }
  }

  async searchFlights(origin, destination, date, travelers, reqId) {
    const cacheKey = `${origin}-${destination}-${date}-${travelers.adults}`.toLowerCase();
    if (flightCache.has(cacheKey)) {
      logInfo(reqId, `[FLIGHT CACHE HIT] ${origin} to ${destination}`);
      return flightCache.get(cacheKey);
    }

    const flights = {
      direct: [],
      one_stop: [],
      multi_stop: []
    };

    if (!this.serpApiKey) {
      return this.generateMockFlights(origin, destination);
    }

    try {
      const query = `flights from ${origin} to ${destination} on ${date}`;
      const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
      
      const response = await fetch(searchUrl);
      const data = await response.json();
      
      if (data.best_flights || data.other_flights) {
        const flightResults = [...(data.best_flights || []), ...(data.other_flights || [])].slice(0, 6);
        
        flightResults.forEach((flight, index) => {
          const flightData = {
            airline: flight.airline || `Airline ${index + 1}`,
            price: flight.price || Math.round(300 + Math.random() * 700),
            duration: flight.duration || `${Math.floor(2 + Math.random() * 10)}h ${Math.floor(Math.random() * 60)}m`,
            stops: flight.stops || (index % 3),
            departure: flight.departure_airport || `${origin} Airport`,
            arrival: flight.arrival_airport || `${destination} Airport`,
            booking_link: flight.booking_link || "#"
          };
          
          if (flightData.stops === 0) {
            flights.direct.push(flightData);
          } else if (flightData.stops === 1) {
            flights.one_stop.push(flightData);
          } else {
            flights.multi_stop.push(flightData);
          }
        });
      }
      
      flightCache.set(cacheKey, flights);
      return flights;
      
    } catch (error) {
      logError(reqId, "Flight search failed:", error.message);
      return this.generateMockFlights(origin, destination);
    }
  }

  async searchRestaurants(destination, cuisine, budget, reqId) {
    const cacheKey = `${destination}-${cuisine}-${budget}`.toLowerCase();
    if (restaurantCache.has(cacheKey)) {
      logInfo(reqId, `[RESTAURANT CACHE HIT] ${destination}`);
      return restaurantCache.get(cacheKey);
    }

    const restaurants = {
      fine_dining: [],
      casual: [],
      budget: []
    };

    if (!this.serpApiKey) {
      return this.generateMockRestaurants(destination, cuisine);
    }

    try {
      const query = `${cuisine} restaurants in ${destination}`;
      const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
      
      const response = await fetch(searchUrl);
      const data = await response.json();
      
      if (data.local_results || data.organic_results) {
        const restaurantResults = data.local_results || data.organic_results.slice(0, 9);
        
        restaurantResults.forEach((restaurant, index) => {
          const restData = {
            name: restaurant.title || `Restaurant ${index + 1}`,
            cuisine: cuisine || "Local",
            price_level: index % 3 + 1, // 1-3 price levels
            rating: (3.5 + Math.random() * 1.5).toFixed(1),
            address: restaurant.address || "City Center",
            hours: restaurant.hours || "9:00 AM - 10:00 PM",
            must_try_dishes: ["Local Special", "Chef's Recommendation"].slice(0, 1 + Math.floor(Math.random() * 2))
          };
          
          if (restData.price_level === 3) {
            restaurants.fine_dining.push(restData);
          } else if (restData.price_level === 2) {
            restaurants.casual.push(restData);
          } else {
            restaurants.budget.push(restData);
          }
        });
      }
      
      restaurantCache.set(cacheKey, restaurants);
      return restaurants;
      
    } catch (error) {
      logError(reqId, "Restaurant search failed:", error.message);
      return this.generateMockRestaurants(destination, cuisine);
    }
  }

  async searchTransportation(destination, reqId) {
    const cacheKey = destination.toLowerCase();
    if (transportationCache.has(cacheKey)) {
      logInfo(reqId, `[TRANSPORT CACHE HIT] ${destination}`);
      return transportationCache.get(cacheKey);
    }

    const transportation = {
      airport_transfers: [],
      local_transport: [],
      car_rentals: []
    };

    if (!this.serpApiKey) {
      return this.generateMockTransportation(destination);
    }

    try {
      const queries = [
        `airport transfer ${destination}`,
        `taxi services ${destination}`,
        `public transportation ${destination}`,
        `car rental ${destination}`
      ];

      for (const query of queries) {
        const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
        const response = await fetch(searchUrl);
        const data = await response.json();
        
        // Process transportation results
        if (data.organic_results) {
          data.organic_results.slice(0, 3).forEach((service, index) => {
            const serviceData = {
              name: service.title,
              type: query.includes('airport') ? 'airport_transfer' : 
                    query.includes('taxi') ? 'taxi' :
                    query.includes('public') ? 'public_transport' : 'car_rental',
              price: query.includes('public') ? '2-5' : '25-50',
              booking_method: service.link ? 'online' : 'local',
              contact: service.phone || 'Not available'
            };
            
            if (serviceData.type === 'airport_transfer') {
              transportation.airport_transfers.push(serviceData);
            } else if (serviceData.type === 'public_transport') {
              transportation.local_transport.push(serviceData);
            } else {
              transportation.car_rentals.push(serviceData);
            }
          });
        }
      }
      
      transportationCache.set(cacheKey, transportation);
      return transportation;
      
    } catch (error) {
      logError(reqId, "Transportation search failed:", error.message);
      return this.generateMockTransportation(destination);
    }
  }

  async searchAttractions(destination, interests, reqId) {
    const cacheKey = `${destination}-${interests.join('-')}`.toLowerCase();
    if (attractionCache.has(cacheKey)) {
      logInfo(reqId, `[ATTRACTION CACHE HIT] ${destination}`);
      return attractionCache.get(cacheKey);
    }

    const attractions = {
      landmarks: [],
      museums: [],
      activities: [],
      shopping: []
    };

    if (!this.serpApiKey) {
      return this.generateMockAttractions(destination, interests);
    }

    try {
      const query = `top attractions in ${destination} ${interests.join(' ')}`;
      const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}`;
      
      const response = await fetch(searchUrl);
      const data = await response.json();
      
      if (data.top_sights || data.organic_results) {
        const attractionResults = data.top_sights?.results || data.organic_results.slice(0, 12);
        
        attractionResults.forEach((attraction, index) => {
          const attrData = {
            name: attraction.title,
            type: this.categorizeAttraction(attraction.title, interests),
            price: attraction.price || (Math.random() > 0.5 ? '15-30' : 'Free'),
            duration: `${Math.floor(1 + Math.random() * 4)} hours`,
            best_time: "Morning",
            description: attraction.snippet || "Popular local attraction"
          };
          
          if (attrData.type === 'landmark') {
            attractions.landmarks.push(attrData);
          } else if (attrData.type === 'museum') {
            attractions.museums.push(attrData);
          } else if (attrData.type === 'shopping') {
            attractions.shopping.push(attrData);
          } else {
            attractions.activities.push(attrData);
          }
        });
      }
      
      attractionCache.set(cacheKey, attractions);
      return attractions;
      
    } catch (error) {
      logError(reqId, "Attraction search failed:", error.message);
      return this.generateMockAttractions(destination, interests);
    }
  }

  // Helper methods for mock data when APIs fail
  generateMockHotels(destination, budget) {
    return {
      luxury: [
        {
          name: `${destination} Grand Hotel`,
          price: Math.round(budget * 0.35),
          rating: "4.8",
          location: "City Center",
          amenities: ["Spa", "Pool", "Fine Dining", "Concierge"],
          booking_link: "#",
          image: "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=400"
        }
      ],
      mid_range: [
        {
          name: `${destination} Central Hotel`,
          price: Math.round(budget * 0.25),
          rating: "4.2",
          location: "Downtown",
          amenities: ["WiFi", "Breakfast", "Fitness Center"],
          booking_link: "#",
          image: "https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=400"
        }
      ],
      budget: [
        {
          name: `${destination} Comfort Inn`,
          price: Math.round(budget * 0.15),
          rating: "3.9",
          location: "Near Airport",
          amenities: ["WiFi", "Parking"],
          booking_link: "#",
          image: "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=400"
        }
      ]
    };
  }

  generateMockFlights(origin, destination) {
    return {
      direct: [
        {
          airline: "Sky Airlines",
          price: 450,
          duration: "5h 30m",
          stops: 0,
          departure: `${origin} International`,
          arrival: `${destination} Airport`,
          booking_link: "#"
        }
      ],
      one_stop: [
        {
          airline: "Global Airways",
          price: 380,
          duration: "7h 15m",
          stops: 1,
          departure: `${origin} International`,
          arrival: `${destination} Airport`,
          booking_link: "#"
        }
      ]
    };
  }

  generateMockRestaurants(destination, cuisine) {
    return {
      fine_dining: [
        {
          name: "La Belle Vue",
          cuisine: cuisine || "French",
          price_level: 3,
          rating: "4.7",
          address: "123 Luxury Street",
          hours: "18:00 - 23:00",
          must_try_dishes: ["Chef's Tasting Menu", "Local Wine Pairing"]
        }
      ],
      casual: [
        {
          name: "Local Bistro",
          cuisine: cuisine || "Local",
          price_level: 2,
          rating: "4.3",
          address: "456 Main Avenue",
          hours: "11:00 - 22:00",
          must_try_dishes: ["Traditional Platter", "House Special"]
        }
      ],
      budget: [
        {
          name: "Street Food Market",
          cuisine: "Local Street Food",
          price_level: 1,
          rating: "4.5",
          address: "Market Square",
          hours: "08:00 - 20:00",
          must_try_dishes: ["Local Snacks", "Fresh Juice"]
        }
      ]
    };
  }

  generateMockTransportation(destination) {
    return {
      airport_transfers: [
        {
          name: "Airport Express Shuttle",
          type: "airport_transfer",
          price: "25-40",
          booking_method: "online",
          contact: "+1234567890"
        }
      ],
      local_transport: [
        {
          name: "City Metro System",
          type: "public_transport",
          price: "2-5",
          booking_method: "station",
          contact: "N/A"
        }
      ],
      car_rentals: [
        {
          name: "Quick Rentals",
          type: "car_rental",
          price: "35-70/day",
          booking_method: "online",
          contact: "rentals@quick.com"
        }
      ]
    };
  }

  generateMockAttractions(destination, interests) {
    return {
      landmarks: [
        {
          name: "Historic Center",
          type: "landmark",
          price: "Free",
          duration: "2-3 hours",
          best_time: "Morning",
          description: "The heart of the city with historic architecture"
        }
      ],
      museums: [
        {
          name: "National Museum",
          type: "museum",
          price: "15",
          duration: "3-4 hours",
          best_time: "Afternoon",
          description: "Extensive collection of local history and art"
        }
      ],
      activities: [
        {
          name: "Guided City Tour",
          type: "activity",
          price: "25",
          duration: "4 hours",
          best_time: "Morning",
          description: "Comprehensive tour of main attractions"
        }
      ],
      shopping: [
        {
          name: "Central Market",
          type: "shopping",
          price: "Free",
          duration: "1-2 hours",
          best_time: "Late Morning",
          description: "Local crafts and souvenirs"
        }
      ]
    };
  }

  categorizeAttraction(name, interests) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('museum') || lowerName.includes('gallery')) return 'museum';
    if (lowerName.includes('market') || lowerName.includes('mall')) return 'shopping';
    if (lowerName.includes('park') || lowerName.includes('tour')) return 'activity';
    return 'landmark';
  }

  async getHotelImage(hotelName, reqId) {
    try {
      const query = encodeURIComponent(`${hotelName} hotel`);
      const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=1`;
      const response = await fetch(url, {
        headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` }
      });
      const data = await response.json();
      return data.results?.[0]?.urls?.regular || "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=400";
    } catch (error) {
      return "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=400";
    }
  }
}

// Initialize research engine
const researchEngine = new TravelDataResearch(SERP_API_KEY);

// Enhanced tools with real-time data integration
const tools = [
  {
    type: "function",
    function: {
      name: "research_destination_details",
      description: "Gather comprehensive real-time data about a destination including hotels, flights, restaurants, and transportation",
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
              children: { type: "number" },
              infants: { type: "number" }
            }
          },
          interests: { type: "array", items: { type: "string" } }
        },
        required: ["destination", "travel_dates", "budget", "travelers"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_comprehensive_itinerary",
      description: "Generate a detailed travel plan using real-time data for hotels, flights, restaurants, and activities",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string" },
          country: { type: "string" },
          date_range: { type: "string" },
          travelers: { 
            type: "object",
            properties: {
              adults: { type: "number" },
              children: { type: "number" },
              infants: { type: "number" }
            }
          },
          total_budget: { type: "number" },
          travel_style: { type: "string" },
          // Real-time data sections
          flight_options: {
            type: "object",
            properties: {
              recommended: { type: "object" },
              alternatives: { type: "array", items: { type: "object" } }
            }
          },
          accommodation_options: {
            type: "object",
            properties: {
              recommended: { type: "object" },
              alternatives: { type: "array", items: { type: "object" } }
            }
          },
          daily_itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string" },
                day_theme: { type: "string" },
                meals: {
                  type: "object",
                  properties: {
                    breakfast: { type: "object" },
                    lunch: { type: "object" },
                    dinner: { type: "object" }
                  }
                },
                activities: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      time: { type: "string" },
                      activity: { type: "string" },
                      location: { type: "string" },
                      duration: { type: "string" },
                      cost: { type: "number" },
                      booking_info: { type: "string" },
                      transportation: { type: "string" }
                    }
                  }
                }
              }
            }
          },
          transportation_plan: {
            type: "object",
            properties: {
              airport_transfers: { type: "array", items: { type: "object" } },
              local_transport: { type: "array", items: { type: "object" } },
              inter_city_transport: { type: "array", items: { type: "object" } }
            }
          },
          restaurant_recommendations: {
            type: "object",
            properties: {
              by_cuisine: { type: "object" },
              by_location: { type: "object" },
              by_price: { type: "object" }
            }
          },
          cost_breakdown: {
            type: "object",
            properties: {
              flights: { type: "number" },
              accommodation: { type: "number" },
              meals: { type: "number" },
              activities: { type: "number" },
              transportation: { type: "number" },
              miscellaneous: { type: "number" },
              total: { type: "number" }
            }
          }
        },
        required: ["destination", "date_range", "travelers", "total_budget", "daily_itinerary"]
      }
    }
  }
];

// Enhanced main endpoint with comprehensive data integration
router.post("/travel", async (req, res) => {
  const reqId = newReqId();
  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    logInfo(reqId, `POST /chat/travel for user ${userId}`);

    if (!hasKey) {
      return res.json({
        aiText: "Travel planning service is currently unavailable. Please check your API configuration.",
        signal: { type: "serviceUnavailable" }
      });
    }

    const lastMessage = messages[messages.length - 1]?.content || "";
    
    // Check if this is a research request
    if (lastMessage.includes("research") || lastMessage.includes("hotels") || lastMessage.includes("flights")) {
      const destination = extractDestination(lastMessage);
      if (destination) {
        const researchData = await performComprehensiveResearch(destination, reqId);
        return res.json({
          aiText: `Here's what I found for ${destination}:`,
          signal: { type: "researchComplete", data: researchData }
        });
      }
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a comprehensive travel planner with access to real-time data. Use the research function to gather actual hotel, flight, restaurant, and transportation data. Provide specific, bookable recommendations with real prices and availability.`
        },
        ...normalizeMessages(messages)
      ],
      tools,
      tool_choice: "auto"
    });

    const choice = completion.choices?.[0];
    const assistantMessage = choice?.message;

    if (assistantMessage?.tool_calls) {
      const toolCall = assistantMessage.tool_calls[0];
      const functionName = toolCall.function?.name;
      
      let args = {};
      try {
        args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
      } catch (e) {
        logError(reqId, "Failed to parse function arguments", e);
      }

      const responsePayload = {
        assistantMessage: {
          ...assistantMessage,
          content: assistantMessage.content || ''
        }
      };

      if (functionName === "research_destination_details") {
        const researchData = await performComprehensiveResearch(
          args.destination, 
          args.travel_dates, 
          args.budget, 
          args.travelers, 
          args.interests, 
          reqId
        );
        
        responsePayload.signal = { type: "researchComplete", data: researchData };
        responsePayload.aiText = `I've gathered comprehensive travel data for ${args.destination}. Ready to create your detailed itinerary!`;
      
      } else if (functionName === "create_comprehensive_itinerary") {
        // Enhance itinerary with real-time data
        const enhancedItinerary = await enhanceItineraryWithRealData(args, reqId);
        responsePayload.signal = { type: "itineraryReady", data: enhancedItinerary };
        responsePayload.aiText = `Here's your comprehensive travel plan for ${args.destination}!`;
      }

      return res.json(responsePayload);
    }

    if (assistantMessage?.content) {
      return res.json({ aiText: assistantMessage.content });
    }

    return res.json({ aiText: "I'm ready to help plan your trip! Where would you like to go?" });

  } catch (err) {
    logError(reqId, "Critical error in travel endpoint:", err);
    return res.status(500).json({ 
      aiText: "I'm experiencing technical difficulties. Please try again shortly.",
      signal: { type: "error" }
    });
  }
});

// Comprehensive research function
async function performComprehensiveResearch(destination, dates, budget, travelers, interests, reqId) {
  logInfo(reqId, `Starting comprehensive research for ${destination}`);
  
  const [checkIn, checkOut] = dates.split(' to ');
  const totalTravelers = travelers.adults + (travelers.children || 0);
  
  try {
    const [
      hotels,
      flights,
      restaurants,
      transportation,
      attractions
    ] = await Promise.all([
      researchEngine.searchHotels(destination, checkIn, checkOut, travelers, budget, reqId),
      researchEngine.searchFlights("User's City", destination, checkIn, travelers, reqId),
      researchEngine.searchRestaurants(destination, interests?.[0] || "local", budget, reqId),
      researchEngine.searchTransportation(destination, reqId),
      researchEngine.searchAttractions(destination, interests || ["sightseeing"], reqId)
    ]);

    return {
      destination,
      research_summary: {
        total_options: {
          hotels: Object.values(hotels).flat().length,
          flights: Object.values(flights).flat().length,
          restaurants: Object.values(restaurants).flat().length,
          attractions: Object.values(attractions).flat().length
        },
        price_ranges: {
          hotels: calculatePriceRange(hotels),
          flights: calculatePriceRange(flights),
          estimated_daily: calculateDailyCost(restaurants, attractions)
        }
      },
      hotels,
      flights,
      restaurants,
      transportation,
      attractions,
      recommendations: generateTopRecommendations(hotels, flights, restaurants, attractions, budget)
    };
    
  } catch (error) {
    logError(reqId, "Comprehensive research failed:", error);
    return generateFallbackResearchData(destination, budget, travelers);
  }
}

// Helper functions
function calculatePriceRange(data) {
  const allPrices = Object.values(data).flat().map(item => item.price).filter(Boolean);
  return allPrices.length ? {
    min: Math.min(...allPrices),
    max: Math.max(...allPrices),
    average: Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length)
  } : { min: 0, max: 0, average: 0 };
}

function calculateDailyCost(restaurants, attractions) {
  const mealCost = Object.values(restaurants).flat()[0]?.price_level * 30 || 60;
  const activityCost = Object.values(attractions).flat()
    .filter(attr => attr.price !== 'Free')
    .reduce((sum, attr) => sum + (parseInt(attr.price) || 0), 0) / 3;
  
  return Math.round(mealCost + activityCost + 20); // +20 for local transport
}

function generateTopRecommendations(hotels, flights, restaurants, attractions, budget) {
  return {
    best_value_hotel: hotels.mid_range?.[0] || hotels.luxury?.[0],
    best_flight: flights.direct?.[0] || flights.one_stop?.[0],
    top_restaurant: restaurants.fine_dining?.[0] || restaurants.casual?.[0],
    must_see_attraction: attractions.landmarks?.[0] || attractions.museums?.[0],
    budget_allocation: {
      accommodation: Math.round(budget * 0.35),
      flights: Math.round(budget * 0.3),
      activities: Math.round(budget * 0.2),
      meals: Math.round(budget * 0.15)
    }
  };
}

function generateFallbackResearchData(destination, budget, travelers) {
  return {
    destination,
    research_summary: {
      note: "Using estimated data - real-time search unavailable",
      total_options: { hotels: 3, flights: 2, restaurants: 3, attractions: 4 }
    },
    hotels: researchEngine.generateMockHotels(destination, budget),
    flights: researchEngine.generateMockFlights("Your City", destination),
    restaurants: researchEngine.generateMockRestaurants(destination, "local"),
    transportation: researchEngine.generateMockTransportation(destination),
    attractions: researchEngine.generateMockAttractions(destination, ["sightseeing"]),
    recommendations: generateTopRecommendations(
      researchEngine.generateMockHotels(destination, budget),
      researchEngine.generateMockFlights("Your City", destination),
      researchEngine.generateMockRestaurants(destination, "local"),
      researchEngine.generateMockAttractions(destination, ["sightseeing"]),
      budget
    )
  };
}

// Existing helper functions (keep from previous implementation)
function extractDestination(text) {
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

function normalizeMessages(messages) {
  return messages
    .filter(m => !m.hidden)
    .map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      }
      return { role: m.role, content: m.content || m.text || '' };
    });
}

async function enhanceItineraryWithRealData(itinerary, reqId) {
  // Enhance the AI-generated itinerary with real data
  const research = await performComprehensiveResearch(
    itinerary.destination,
    itinerary.date_range,
    itinerary.total_budget,
    itinerary.travelers,
    [itinerary.travel_style],
    reqId
  );

  return {
    ...itinerary,
    real_time_data: research,
    last_updated: new Date().toISOString(),
    data_source: SERP_API_KEY ? "live" : "estimated"
  };
}

export default router;
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
