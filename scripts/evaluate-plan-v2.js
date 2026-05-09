import assert from "node:assert/strict";
import { createMapsProvider } from "../maps.provider.js";
import { enrichPlanV2 } from "../plan-v2.js";

const mapsProvider = createMapsProvider({ env: {} });

const samplePlan = {
  location: "Paris",
  country: "France",
  currency: "USD",
  itinerary: [
    {
      date: "2026-06-01",
      day: "2026-06-01",
      events: [
        {
          type: "activity",
          time: "09:00",
          title: "Eiffel Tower",
          details: "Morning visit",
          provider: "Eiffel Tower",
          latitude: 48.8584,
          longitude: 2.2945,
        },
        {
          type: "food",
          time: "12:30",
          title: "Cafe de Flore",
          details: "Lunch in Saint-Germain-des-Pres",
          provider: "Cafe de Flore",
          latitude: 48.8542,
          longitude: 2.332,
        },
        {
          type: "activity",
          time: "15:00",
          title: "Louvre Museum",
          details: "Collection highlights",
          provider: "Louvre Museum",
          latitude: 48.8606,
          longitude: 2.3376,
        },
      ],
    },
  ],
  costBreakdown: [
    {
      item: "Museum ticket",
      provider: "Louvre Museum",
      price: 24,
      booking_url: "https://www.louvre.fr/en",
    },
  ],
};

const fallbackPlan = {
  location: "Tokyo",
  itinerary: [
    {
      date: "2026-07-10",
      day: "2026-07-10",
      events: [
        {
          type: "activity",
          time: "10:00",
          title: "Neighborhood walk",
          details: "Explore a local area",
          provider: "Local guide",
        },
      ],
    },
  ],
  costBreakdown: [],
};

await enrichPlanV2(samplePlan, { mapsProvider });
await enrichPlanV2(fallbackPlan, { mapsProvider });

assert.equal(samplePlan.schemaVersion, "plan.v2");
assert.equal(samplePlan.itinerary[0].routeLegs.length, 2);
assert.ok(samplePlan.mapBounds);
assert.ok(samplePlan.planQuality.score >= 75);
assert.equal(samplePlan.exactPlaceCount, 3);

assert.equal(fallbackPlan.schemaVersion, "plan.v2");
assert.equal(fallbackPlan.placeCount, 1);
assert.equal(fallbackPlan.exactPlaceCount, 0);
assert.ok(fallbackPlan.planQuality.warnings.some((w) => w.includes("exact place-level coordinates")));

const mockPlacesProvider = {
  provider: "mock_google",
  hasGeocoding: false,
  hasRouting: false,
  hasPlaces: true,
  async findPlace(query) {
    if (!query.includes("Imaginary Museum")) return null;
    return {
      provider: "google_places",
      placeId: "mock-place-1",
      name: "Imaginary Museum",
      address: "1 Test Street, Test City",
      latitude: 10,
      longitude: 20,
      rating: 4.8,
      userRatingsTotal: 1200,
      priceLevel: 2,
      openingHours: ["Monday: 9:00 AM - 6:00 PM"],
      googleMapsUrl: "https://www.google.com/maps/place/?q=place_id:mock-place-1",
      photoUrl: "https://example.com/photo.jpg",
      neighborhood: "Central",
      confidence: "provider",
    };
  },
  async routeLeg() {
    return null;
  },
};

const placesPlan = {
  location: "Test City",
  itinerary: [
    {
      date: "2026-08-01",
      day: "2026-08-01",
      events: [
        {
          type: "activity",
          time: "11:00",
          title: "Imaginary Museum",
          details: "Gallery visit",
          provider: "Local provider",
        },
      ],
    },
  ],
  costBreakdown: [],
};

await enrichPlanV2(placesPlan, { mapsProvider: mockPlacesProvider });

const enrichedEvent = placesPlan.itinerary[0].events[0];
assert.equal(enrichedEvent.placeId, "mock-place-1");
assert.equal(enrichedEvent.rating, 4.8);
assert.equal(enrichedEvent.address, "1 Test Street, Test City");
assert.equal(enrichedEvent.neighborhood, "Central");
assert.equal(enrichedEvent.coordinateSource, "google_places");
assert.equal(placesPlan.exactPlaceCount, 1);

console.log("Plan v2 evaluation passed");
