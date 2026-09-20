# Travel API recovery — September 20, 2026

This is a fresh copy of https://github.com/Aerobabel/travelapi on branch `recovery/airport-lookup-2026-09-20`. The laptop's original backend copy was preserved.

## Verified service behavior

- `https://travelapi-34zi.onrender.com/health` responds successfully.
- Before repair, airport lookups for LON/LHR and hotel destination lookup for PAR returned empty arrays.
- A flight search from LHR to JFK on October 20, 2026 returned 112 merged offers. Provider diagnostics reported Duffel successful and Amadeus failed. This was a search only; no booking or payment was made. Live versus test inventory was not established.
- The affected lookup routes used Amadeus exclusively and turn provider errors into empty arrays. Render's logs confirmed Amadeus HTTP 503 / ServerError responses containing an Incapsula request-failure page. Amadeus's [developer portal retirement notice](https://developers.amadeus.com/self-service/category/hotels) says its Self-Service portal was decommissioned on July 17; this is a likely contributor, but does not by itself establish the account-specific cause.

## Airport repair deployed and verified

`GET /airports` now uses the existing Duffel provider's [Places suggestions endpoint](https://duffel.com/docs/api/places/schema), with an eight-second request timeout. City results expand into airports; duplicate and missing airport codes are filtered out. Responses retain the mobile app's `{ city, code, country }` format and 12-result limit. The existing Amadeus lookup remains a fallback when Duffel fails. No new account or token is required if the deployed Duffel token has access to Places.

Validation passed: `npm run test:airports` covers provider mapping and the actual HTTP route; `npm run check` passes the repository's syntax and evaluation checks. Commit `322702e` was pushed to the backend's main branch and deployed successfully to the existing Render service on September 20, 2026. The previous live commit was `24796d2`, matching the tested base. Production checks confirmed LHR returns Heathrow, LON returns London airports, and LOS includes Lagos. Installed dependencies also have pre-existing audit findings (four moderate and six high), which need a separate maintenance review.

## Continue recovery

1. Test airport selection, login, saved data, and the full user journey on an iPhone using TestFlight build 8.
2. Dedicated hotel destination/search routes still depend on Amadeus. Restoring those requires checking the provider situation and connecting available hotel inventory. The chat feature has a separate RateHawk/Zen integration that was not validated in this recovery. This repair does not claim to restore hotel inventory or bookings.
3. Render service: https://dashboard.render.com/web/srv-d37eko0gjchc73c7mofg. The existing service's automatic deployment remains connected to the backend main branch. The original laptop backend copy remains untouched.

The mobile application is separately restored to TestFlight as NuviaTravel Beta 1.0.0 (8), expiring December 19, 2026. It uses the same server URL, so this server repair does not itself require another iPhone build.
