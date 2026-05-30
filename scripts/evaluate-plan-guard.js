import assert from "node:assert/strict";
import {
  classifyBookingItem,
  guardPlan,
  isZenHotelsHotelPageUrl,
  isZenHotelsSearchUrl,
} from "../plan-guard.js";

function item(label, provider, url, extra = {}) {
  return {
    item: label,
    provider,
    price: 100,
    bookingAction: {
      type: extra.type,
      label: "Book",
      url,
    },
    booking_url: url,
    ...extra,
  };
}

const plan = guardPlan({
  location: "Abuja",
  country: "Nigeria",
  currency: "USD",
  costBreakdown: [
    item(
      "Hotel to airport transfer",
      "Airbnb Experiences",
      "https://www.airbnb.com/s/experiences?query=transfer%20egypt",
      { type: "transfer" }
    ),
    item(
      "Travel insurance",
      "AXA",
      "https://www.airbnb.com/s/experiences?query=insurance",
      { type: "insurance" }
    ),
    item(
      "Selected hotel",
      "ZenHotels",
      "https://www.zenhotels.com/hotels/?q=Abuja%20hotel",
      { type: "hotel" }
    ),
    item(
      "Transcorp Hilton Abuja",
      "ZenHotels",
      "https://www.zenhotels.com/hotel/nigeria/abuja/mid123456/transcorp_hilton_abuja/",
      { type: "hotel" }
    ),
    item(
      "Cooking experience",
      "Airbnb Experiences",
      "https://www.airbnb.com/experiences/123456",
      { type: "activity" }
    ),
  ],
  itinerary: [
    {
      day: 1,
      events: [
        {
          title: "Flight segment",
          details: "Private airport transfer from Nnamdi Azikiwe International Airport to hotel.",
          booking_url: "https://www.airbnb.com/s/experiences?query=transfer",
        },
      ],
    },
  ],
});

const [transfer, insurance, hotelSearch, hotelExact, activity] = plan.costBreakdown;

assert.equal(classifyBookingItem(transfer), "transfer");
assert.equal(transfer.bookingAction.type, "transfer");
assert.equal(transfer.bookingAction.label, "Book transfer");
assert.equal(transfer.bookingAction.url, "https://gettransfer.com");
assert.equal(transfer.bookingAction.corrected, true);

assert.equal(insurance.bookingAction.type, "insurance");
assert.equal(insurance.bookingAction.label, "Get insurance");
assert.match(insurance.bookingAction.url, /^https:\/\/www\.(axa-schengen|allianz-travel)\.com/);
assert.equal(insurance.bookingAction.corrected, true);

assert.equal(hotelSearch.bookingAction.type, "hotel");
assert.equal(hotelSearch.bookingAction.label, "Search hotels");
assert.equal(isZenHotelsSearchUrl(hotelSearch.bookingAction.url), true);
assert.equal(hotelSearch.bookingAction.exactProperty, false);
assert.equal(hotelSearch.bookingAction.verified, false);

assert.equal(hotelExact.bookingAction.type, "hotel");
assert.equal(hotelExact.bookingAction.label, "Book hotel");
assert.equal(isZenHotelsHotelPageUrl(hotelExact.bookingAction.url), true);
assert.equal(hotelExact.bookingAction.exactProperty, true);
assert.equal(hotelExact.bookingAction.verified, true);

assert.equal(activity.bookingAction.type, "activity");
assert.equal(activity.bookingAction.url, "https://www.airbnb.com/experiences/123456");
assert.equal(activity.bookingAction.corrected, false);

assert.equal(plan.itinerary[0].events[0].type, "transfer");
assert.equal(plan.itinerary[0].events[0].icon, "transfer");
assert.equal(plan.itinerary[0].events[0].title, "Private transfer");
assert.equal(plan.itinerary[0].events[0].booking_url, undefined);

assert.equal(plan.bookingActionSummary.total, 5);
assert.equal(plan.bookingActionSummary.actionable, 5);
assert.ok(plan.guardrails.correctedCount >= 3);
assert.ok(plan.guardrails.issues.some((issue) => issue.code === "booking_url_category_mismatch"));
assert.ok(plan.guardrails.issues.some((issue) => issue.code === "event_url_category_mismatch"));

console.log("Plan guard eval passed");
