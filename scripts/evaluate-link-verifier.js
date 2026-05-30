import assert from "node:assert/strict";
import { verifyPlanLinks, verifyUrl } from "../link-verifier.js";

function routeKey(method, rawUrl) {
  const url = new URL(rawUrl);
  return `${method.toUpperCase()} ${url.origin}${url.pathname}`;
}

function makeFetch(routes, calls = []) {
  return async function fakeFetch(rawUrl, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const key = routeKey(method, rawUrl);
    calls.push(key);
    const route = routes[key] || routes[`${method} *`];
    if (!route) {
      return new Response(method === "HEAD" ? null : "Not found", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    }
    if (route.error) throw route.error;
    return new Response(method === "HEAD" ? null : route.body || "<title>OK</title>", {
      status: route.status,
      headers: route.headers || { "content-type": "text/html" },
    });
  };
}

function planWith(item) {
  return {
    location: "Abuja",
    country: "Nigeria",
    currency: "USD",
    costBreakdown: [item],
  };
}

function item(label, provider, url, type) {
  return {
    item: label,
    provider,
    booking_url: url,
    bookingAction: {
      type,
      label: "Book",
      url,
    },
  };
}

{
  const fetchImpl = makeFetch({
    "HEAD https://www.zenhotels.com/hotel/nigeria/abuja/missing_property/": { status: 200 },
    "GET https://www.zenhotels.com/hotel/nigeria/abuja/missing_property/": {
      status: 200,
      body: "<html><h1>Looks like this page doesn't exist</h1></html>",
    },
  });

  const result = await verifyUrl(
    "https://www.zenhotels.com/hotel/nigeria/abuja/missing_property/",
    { fetchImpl, cache: false }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "soft_not_found");
}

{
  const calls = [];
  const fetchImpl = makeFetch({
    "HEAD https://www.zenhotels.com/hotel/nigeria/abuja/broken": { status: 404 },
    "HEAD https://www.zenhotels.com/hotels/": { status: 200 },
    "GET https://www.zenhotels.com/hotels/": {
      status: 200,
      body: "<title>Abuja hotels</title><main>Available hotels in Abuja</main>",
    },
  }, calls);

  const plan = await verifyPlanLinks(planWith(item(
    "Selected hotel",
    "ZenHotels",
    "https://www.zenhotels.com/hotel/nigeria/abuja/broken",
    "hotel"
  )), { fetchImpl, cache: false, concurrency: 2 });

  const action = plan.costBreakdown[0].bookingAction;
  assert.equal(plan.linkVerification.replaced, 1);
  assert.equal(action.label, "Search hotels");
  assert.equal(action.liveVerified, true);
  assert.equal(action.verified, false);
  assert.equal(action.exactProperty, false);
  assert.match(action.url, /^https:\/\/www\.zenhotels\.com\/hotels\/\?/);
  assert.ok(calls.includes("GET https://www.zenhotels.com/hotels/"));
  assert.equal(calls.includes("GET https://www.zenhotels.com/hotel/nigeria/abuja/broken"), false);
}

{
  const calls = [];
  const fetchImpl = makeFetch({
    "HEAD https://www.skyscanner.com/transport/flights/abv/lon/260601": { status: 405 },
    "GET https://www.skyscanner.com/transport/flights/abv/lon/260601": {
      status: 200,
      body: "<title>Flights from Abuja to London</title>",
    },
  }, calls);

  const result = await verifyUrl(
    "https://www.skyscanner.com/transport/flights/abv/lon/260601",
    { fetchImpl, cache: false }
  );

  assert.equal(result.ok, true);
  assert.equal(result.method, "GET");
  assert.deepEqual(calls, [
    "HEAD https://www.skyscanner.com/transport/flights/abv/lon/260601",
    "GET https://www.skyscanner.com/transport/flights/abv/lon/260601",
  ]);
}

{
  const fetchImpl = makeFetch({
    "HEAD https://www.airbnb.com/experiences/123": { status: 200 },
    "GET https://www.airbnb.com/experiences/123": {
      status: 200,
      body: "<html><title>Page not found</title><h1>This page does not exist</h1></html>",
    },
    "HEAD https://www.airbnb.com/s/experiences": { status: 200 },
    "GET https://www.airbnb.com/s/experiences": {
      status: 200,
      body: "<title>Experiences in Abuja</title>",
    },
  });

  const plan = await verifyPlanLinks(planWith(item(
    "Cooking experience",
    "Airbnb Experiences",
    "https://www.airbnb.com/experiences/123",
    "activity"
  )), { fetchImpl, cache: false });

  const action = plan.costBreakdown[0].bookingAction;
  assert.equal(plan.linkVerification.replaced, 1);
  assert.match(action.url, /^https:\/\/www\.airbnb\.com\/s\/experiences\?/);
  assert.equal(action.liveVerified, true);
  assert.equal(action.linkVerification.reason, "ok");
}

{
  const fetchImpl = makeFetch({
    "HEAD https://www.axa-schengen.com/broken": { status: 403 },
    "GET https://www.axa-schengen.com/broken": { status: 403 },
    "HEAD https://www.axa-schengen.com/": { status: 200 },
    "GET https://www.axa-schengen.com/": {
      status: 200,
      body: "<title>Travel insurance</title>",
    },
  });

  const plan = await verifyPlanLinks(planWith(item(
    "Travel insurance",
    "AXA",
    "https://www.axa-schengen.com/broken",
    "insurance"
  )), { fetchImpl, cache: false });

  const action = plan.costBreakdown[0].bookingAction;
  assert.equal(plan.linkVerification.replaced, 1);
  assert.equal(action.url, "https://www.axa-schengen.com");
  assert.equal(action.label, "Get insurance");
  assert.equal(action.liveVerified, true);
}

{
  const fetchImpl = makeFetch({
    "HEAD https://example.com/event": { status: 404 },
  });

  const plan = await verifyPlanLinks({
    location: "Abuja",
    costBreakdown: [],
    itinerary: [
      {
        events: [
          {
            title: "Museum visit",
            booking_url: "https://example.com/event",
          },
        ],
      },
    ],
  }, { fetchImpl, cache: false });

  assert.equal(plan.linkVerification.cleared, 1);
  assert.equal(plan.itinerary[0].events[0].booking_url, undefined);
}

console.log("Link verifier eval passed");
