const clean = (value) => String(value || "").trim();

const nowIso = () => new Date().toISOString();

const safeUserId = (userId) => {
  const value = clean(userId);
  if (!value || value === "anonymous") return null;
  return value;
};

const planIdFrom = (plan = {}) =>
  clean(plan.id) ||
  `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function createPersistence({ env = process.env, logger = console, fetchImpl = fetch } = {}) {
  const url = clean(env.SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL).replace(/\/+$/, "");
  const key = clean(
    env.SUPABASE_SERVICE_ROLE_KEY ||
      env.SUPABASE_SERVICE_KEY ||
      env.SUPABASE_ANON_KEY ||
      env.EXPO_PUBLIC_SUPABASE_ANON_KEY
  );
  const enabled = Boolean(url && key && typeof fetchImpl === "function");

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const request = async (path, options = {}) => {
    if (!enabled) return null;
    const response = await fetchImpl(`${url}/rest/v1/${path}`, {
      ...options,
      headers: {
        ...headers,
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 240)}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  const safe = async (label, fn, fallback = null) => {
    if (!enabled) return fallback;
    try {
      return await fn();
    } catch (error) {
      logger?.warn?.(`[persistence] ${label}`, error?.message || error);
      return fallback;
    }
  };

  return {
    enabled,

    async loadUserMemory(userId) {
      const id = safeUserId(userId);
      if (!id) return null;
      return safe("loadUserMemory", async () => {
        const rows = await request(
          `travel_user_memory?user_id=eq.${encodeURIComponent(id)}&select=profile,memory,updated_at&limit=1`
        );
        return Array.isArray(rows) ? rows[0] || null : null;
      });
    },

    async saveUserMemory(userId, { profile = {}, memory = {} } = {}) {
      const id = safeUserId(userId);
      if (!id) return false;
      return safe(
        "saveUserMemory",
        async () => {
          await request("travel_user_memory?on_conflict=user_id", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify([
              {
                user_id: id,
                profile,
                memory,
                updated_at: nowIso(),
              },
            ]),
          });
          return true;
        },
        false
      );
    },

    async savePlan(userId, plan = {}) {
      const id = safeUserId(userId);
      if (!id || !plan || typeof plan !== "object") return false;
      const planId = planIdFrom(plan);
      plan.id = plan.id || planId;
      return safe(
        "savePlan",
        async () => {
          await request("travel_plans", {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify([
              {
                user_id: id,
                plan_id: planId,
                location: clean(plan.location),
                price: Number(plan.price) || 0,
                quality_score: Number(plan.planQuality?.score) || null,
                plan,
                created_at: nowIso(),
              },
            ]),
          });
          return true;
        },
        false
      );
    },
  };
}

export const buildMemorySnapshot = (mem = {}) => ({
  lastFlights: mem.lastFlights || [],
  lastHotels: mem.lastHotels || [],
  lastActivities: mem.lastActivities || [],
  lastRestaurants: mem.lastRestaurants || [],
  lastHotelSearch: mem.lastHotelSearch || null,
  lastActivitySearch: mem.lastActivitySearch || null,
});

export function mergePersistedMemory(mem, persisted) {
  if (!mem || !persisted) return mem;
  if (persisted.profile && typeof persisted.profile === "object") {
    mem.profile = {
      ...mem.profile,
      ...Object.fromEntries(
        Object.entries(persisted.profile).filter(([, value]) => value !== null && value !== undefined)
      ),
      flight_preferences: {
        ...(mem.profile?.flight_preferences || {}),
        ...(persisted.profile.flight_preferences || {}),
      },
      accommodation: {
        ...(mem.profile?.accommodation || {}),
        ...(persisted.profile.accommodation || {}),
      },
      budget: {
        ...(mem.profile?.budget || {}),
        ...(persisted.profile.budget || {}),
      },
      guest_counts: {
        ...(mem.profile?.guest_counts || {}),
        ...(persisted.profile.guest_counts || {}),
      },
    };
  }
  const memory = persisted.memory || {};
  for (const key of [
    "lastFlights",
    "lastHotels",
    "lastActivities",
    "lastRestaurants",
    "lastHotelSearch",
    "lastActivitySearch",
  ]) {
    if (memory[key] !== undefined && memory[key] !== null) mem[key] = memory[key];
  }
  return mem;
}

