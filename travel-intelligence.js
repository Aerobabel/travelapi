const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

const clean = (value) => String(value || "").trim();

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const weatherIconFromCode = (code) => {
  const n = Number(code);
  if ([0, 1].includes(n)) return "sunny";
  if ([2, 3].includes(n)) return "partly-sunny";
  if ([45, 48].includes(n)) return "cloudy";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(n)) return "rainy";
  if ([71, 73, 75, 77, 85, 86].includes(n)) return "snow";
  if ([95, 96, 99].includes(n)) return "thunderstorm";
  return "partly-sunny";
};

const weatherSummaryFromCode = (code) => {
  const icon = weatherIconFromCode(code);
  if (icon === "sunny") return "Mostly clear";
  if (icon === "partly-sunny") return "Mixed sun and cloud";
  if (icon === "cloudy") return "Cloudy or misty";
  if (icon === "rainy") return "Rain possible";
  if (icon === "snow") return "Snow possible";
  if (icon === "thunderstorm") return "Storm risk";
  return "Variable conditions";
};

const isoDatesFromPlan = (plan = {}) =>
  (Array.isArray(plan.itinerary) ? plan.itinerary : [])
    .map((day) => clean(day.isoDate))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));

const getPlanCenter = (plan = {}) => {
  const center = plan.mapBounds?.center;
  const latitude = toNumber(center?.latitude);
  const longitude = toNumber(center?.longitude);
  if (latitude !== null && longitude !== null) return { latitude, longitude };

  const events = (plan.itinerary || []).flatMap((day) => day.events || []);
  const coords = events
    .map((event) => ({
      latitude: toNumber(event.latitude),
      longitude: toNumber(event.longitude),
    }))
    .filter((p) => p.latitude !== null && p.longitude !== null);
  if (!coords.length) return null;

  return {
    latitude: coords.reduce((sum, p) => sum + p.latitude, 0) / coords.length,
    longitude: coords.reduce((sum, p) => sum + p.longitude, 0) / coords.length,
  };
};

async function fetchWeather({ plan, fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const center = getPlanCenter(plan);
  const dates = isoDatesFromPlan(plan);
  if (!center || dates.length === 0 || typeof fetchImpl !== "function") return null;

  const start = dates[0];
  const end = dates[dates.length - 1];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(OPEN_METEO_URL);
    url.searchParams.set("latitude", String(center.latitude));
    url.searchParams.set("longitude", String(center.longitude));
    url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max");
    url.searchParams.set("temperature_unit", "celsius");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("start_date", start);
    url.searchParams.set("end_date", end);

    const response = await fetchImpl(url.toString(), { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const daily = payload?.daily || {};
    const rows = (daily.time || []).map((date, index) => {
      const max = toNumber(daily.temperature_2m_max?.[index]);
      const min = toNumber(daily.temperature_2m_min?.[index]);
      const code = daily.weather_code?.[index];
      const rain = toNumber(daily.precipitation_probability_max?.[index]);
      return {
        date,
        tempMinC: min,
        tempMaxC: max,
        tempAvgC: max !== null && min !== null ? Math.round((max + min) / 2) : max ?? min,
        icon: weatherIconFromCode(code),
        summary: weatherSummaryFromCode(code),
        precipitationProbability: rain,
      };
    });

    if (!rows.length) return null;
    const avg = Math.round(
      rows.reduce((sum, row) => sum + (Number(row.tempAvgC) || 0), 0) / rows.length
    );
    const rainMax = Math.max(...rows.map((row) => Number(row.precipitationProbability) || 0));

    return {
      provider: "open-meteo",
      center,
      dates: rows,
      averageTempC: avg,
      icon: rows[0]?.icon || "partly-sunny",
      summary:
        rainMax >= 60
          ? "Pack for rain on at least one day."
          : rows.some((row) => row.icon === "snow")
            ? "Cold-weather planning is recommended."
            : "Weather looks manageable for outdoor routing.",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const emergencyNumbers = (country = "") => {
  const c = clean(country).toLowerCase();
  if (["united states", "usa", "canada"].includes(c)) return "911";
  if (["united kingdom", "uk"].includes(c)) return "999 / 112";
  if (["france", "spain", "italy", "germany", "portugal", "greece", "netherlands"].includes(c)) return "112";
  if (["turkey", "turkiye"].includes(c)) return "112";
  if (["japan"].includes(c)) return "110 police / 119 ambulance";
  if (["united arab emirates", "uae"].includes(c)) return "999 police / 998 ambulance";
  return "Local emergency number varies by destination";
};

const buildVisaIntel = ({ plan = {}, profile = {} } = {}) => {
  const nationality = clean(profile.nationality);
  const country = clean(plan.country);
  if (!country) {
    return {
      status: "unknown",
      confidence: "low",
      summary: "Destination country is not explicit enough for visa guidance.",
    };
  }

  if (!nationality) {
    return {
      status: "check_required",
      confidence: "medium",
      summary: `Visa requirements for ${country} depend on nationality. Ask the traveler to confirm passport country before purchase.`,
    };
  }

  return {
    status: "check_required",
    confidence: "medium",
    nationality,
    destinationCountry: country,
    summary: `Check ${nationality} passport requirements for ${country} before payment. This is a travel-planning reminder, not legal advice.`,
  };
};

const buildSafetyIntel = (plan = {}) => {
  const country = clean(plan.country);
  const location = clean(plan.location || country || "the destination");
  const warnings = [];
  const events = (plan.itinerary || []).flatMap((day) => day.events || []);
  const lateEvents = events.filter((event) => {
    const time = clean(event.time);
    const hour = Number(time.slice(0, 2));
    return Number.isFinite(hour) && hour >= 22;
  });
  if (lateEvents.length) warnings.push("Late-night events should use taxi or rideshare transfers.");
  if ((plan.planQuality?.missingCoordinates || 0) > 0) warnings.push("Some stops need exact coordinates before final navigation.");

  return {
    provider: "nuvia-rules",
    confidence: "medium",
    summary: `Use normal city travel precautions in ${location}: protect valuables, verify pickup points, and keep offline copies of bookings.`,
    emergencyNumber: emergencyNumbers(country),
    warnings,
  };
};

const buildNeighborhoodIntel = (plan = {}) => {
  const events = (plan.itinerary || []).flatMap((day) => day.events || []);
  const counts = new Map();
  for (const event of events) {
    const name = clean(event.neighborhood);
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, eventCount]) => ({
      name,
      eventCount,
      role: eventCount >= 3 ? "main cluster" : "secondary stop",
    }));
};

export async function enrichTravelIntelligence(plan, { profile = {}, fetchImpl = fetch } = {}) {
  if (!plan || typeof plan !== "object") return plan;

  const weather = await fetchWeather({ plan, fetchImpl });
  if (weather) {
    plan.weather = {
      ...(plan.weather || {}),
      temp: weather.averageTempC,
      icon: weather.icon,
      summary: weather.summary,
      provider: weather.provider,
    };
  }

  plan.travelIntel = {
    ...(plan.travelIntel || {}),
    weather: weather || {
      provider: "fallback",
      confidence: "low",
      summary: "Weather provider did not return date-specific data.",
    },
    visa: buildVisaIntel({ plan, profile }),
    safety: buildSafetyIntel(plan),
    neighborhoods: buildNeighborhoodIntel(plan),
    dataSources: [
      "OpenAI planning",
      "Amadeus flights",
      "RateHawk/ZenHotels hotels",
      "Google Maps/Places",
      weather ? "Open-Meteo weather" : "Fallback weather",
    ],
  };

  return plan;
}

