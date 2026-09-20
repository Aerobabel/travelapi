# Travel API recovery — September 20, 2026

This is a fresh copy of https://github.com/Aerobabel/travelapi on branch `recovery/airport-lookup-2026-09-20`. The laptop's original backend copy was preserved.

## Verified service behavior

- `https://travelapi-34zi.onrender.com/health` responds successfully.
- Airport lookups for LON/LHR and destination lookup for PAR returned empty arrays.
- A flight search from LHR to JFK on October 20, 2026 returned 112 merged offers. Provider diagnostics reported Duffel successful and Amadeus failed. This was a search only; no booking or payment was made. Live versus test inventory was not established.
- The affected lookup routes use Amadeus exclusively and turn provider errors into empty arrays. Amadeus's [developer portal retirement notice](https://developers.amadeus.com/self-service/category/hotels) says its Self-Service portal was decommissioned on July 17. This is a likely contributor; the hosting logs still need inspection to establish the precise account/runtime error.

## Prepared airport repair — not yet deployed

`GET /airports` now uses the existing Duffel provider's [Places suggestions endpoint](https://duffel.com/docs/api/places/schema), with an eight-second request timeout. City results expand into airports; duplicate and missing airport codes are filtered out. Responses retain the mobile app's `{ city, code, country }` format and 12-result limit. The existing Amadeus lookup remains a fallback when Duffel fails. No new account or token is required if the deployed Duffel token has access to Places.

Validation passed: `npm run test:airports` covers provider mapping and the actual HTTP route; `npm run check` passes the repository's syntax and evaluation checks. Production verification is pending deployment and hosting access. Installed dependencies also have pre-existing audit findings (four moderate and six high), which need a separate maintenance review.

## Continue recovery

1. Sign into the existing Render account at https://dashboard.render.com and open the service serving `travelapi-34zi.onrender.com`.
2. Inspect its deployment commit and logs. Compare this recovery branch with the currently deployed commit before deploying, because GitHub's current main includes changes newer than the old laptop copy.
3. Deploy the tested airport change using the existing service settings, then verify `/airports?q=LHR`, `/airports?q=LON`, and airport selection in TestFlight.
4. Hotel destination/search routes still depend on Amadeus. Restoring those requires checking the existing provider account and, if needed, connecting an available hotel provider. This repair does not claim to restore hotel inventory or bookings.

The mobile application is separately restored to TestFlight as NuviaTravel Beta 1.0.0 (8), expiring December 19, 2026. It uses the same server URL, so this server repair does not itself require another iPhone build.
