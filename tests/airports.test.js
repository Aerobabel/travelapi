import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { searchDuffelAirports } from '../duffel.provider.js';

const suggestions = [
  { type: 'city', name: 'London', iata_code: 'LON', iata_country_code: 'GB',
    airports: [{ iata_code: 'LHR', name: 'Heathrow' }, { iata_code: 'LGW', name: 'Gatwick' }] },
  { type: 'airport', iata_code: 'LHR', name: 'Heathrow', city_name: 'London', iata_country_code: 'GB' },
  { type: 'airport', name: 'Missing IATA' },
];
const expected = [
  { city: 'London', code: 'LHR', country: 'GB' },
  { city: 'London', code: 'LGW', country: 'GB' },
];

test('airport lookup preserves the mobile contract and provider failures', async (t) => {
  const previousToken = process.env.DUFFEL_ACCESS_TOKEN;
  process.env.DUFFEL_ACCESS_TOKEN = 'test-only-token';
  t.after(() => {
    if (previousToken === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
    else process.env.DUFFEL_ACCESS_TOKEN = previousToken;
  });
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.pathname, '/places/suggestions');
    assert.equal(url.searchParams.get('query'), 'London & Heathrow');
    assert.equal(options.headers['Duffel-Version'], 'v2');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: suggestions });
  });

  assert.deepEqual(await searchDuffelAirports(' London & Heathrow '), expected);
  assert.deepEqual(await searchDuffelAirports(' '), []);
  assert.equal(upstream.mock.callCount(), 1, 'blank lookup must not call a provider');

  upstream.mock.mockImplementation(async () => Response.json({ data: [] }));
  assert.deepEqual(await searchDuffelAirports('unmatched'), []);

  upstream.mock.mockImplementation(async () => Response.json({ data: Array.from({ length: 20 }, (_, i) => ({
    type: 'airport', iata_code: `A${i}`, name: `Airport ${i}`, city: { name: 'Metro' },
  })) }));
  const capped = await searchDuffelAirports('Metro');
  assert.equal(capped.length, 12);
  assert.equal(capped[0].city, 'Metro');

  upstream.mock.mockImplementation(async () => Response.json({ errors: [{ message: 'Unavailable' }] }, { status: 503 }));
  await assert.rejects(searchDuffelAirports('LHR'), { status: 503, message: 'Unavailable' });
});

test('GET /airports serves Duffel results without requesting Amadeus', async (t) => {
  const envKeys = ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'DUFFEL_ACCESS_TOKEN'];
  const previous = envKeys.map(key => process.env[key]);
  for (const key of envKeys) process.env[key] = 'test-only';
  t.after(() => envKeys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
  const { default: router } = await import('../flights.routes.js');
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url.pathname, '/places/suggestions');
    assert.equal(url.searchParams.get('query'), 'LON');
    return Response.json({ data: suggestions });
  });
  const server = express().use(router).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}${path}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    }).on('error', reject);
  });
  assert.deepEqual(await request('/airports?q=LON'), { status: 200, data: expected });
  assert.deepEqual(await request('/airports'), { status: 200, data: [] });
});
