// Roster HTTP surface — port of `convex/roster.ts`.
//
// There is no `server/services/roster.ts`: the Convex original was three short
// handlers with no engine state, so the logic lives here rather than behind a
// one-caller service module.
//
// The slot-vs-slug loop below looks like ceremony and is not. `loadout.weapon`
// is a free-form string on the wire; without checking that the slug the client
// sent actually IS a weapon, a player could stack five weapons' stat bonuses
// into one unit. `resolveStats` rejects unknown slugs but not misfiled ones,
// so both checks have to run.

import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import { CONSUMABLE_SLOTS } from "../../shared/catalog";
import { resolveStats } from "../../shared/engine";
import { rosterUnits } from "../../shared/schema";
import { CATALOG_MAP } from "../services/mappers";
import { context } from "./context";

const GEARED_SLOTS = ["weapon", "helmet", "chest", "boots", "active"] as const;

const loadoutSchema = t.Object({
  weapon: t.String(),
  helmet: t.String(),
  chest: t.String(),
  boots: t.String(),
  active: t.String(),
  consumables: t.Array(t.String(), {
    minItems: CONSUMABLE_SLOTS,
    maxItems: CONSUMABLE_SLOTS,
  }),
});

type LoadoutBody = typeof loadoutSchema.static;

function validateLoadout(loadout: LoadoutBody): void {
  resolveStats(loadout, CATALOG_MAP); // throws on unknown items
  for (const slot of GEARED_SLOTS) {
    const item = CATALOG_MAP.get(loadout[slot]);
    if (!item || item.slot !== slot) throw new Error(`Invalid ${slot}: ${loadout[slot]}`);
  }
  if (loadout.consumables.length !== CONSUMABLE_SLOTS) {
    throw new Error(`Pick exactly ${CONSUMABLE_SLOTS} consumables`);
  }
  for (const slug of loadout.consumables) {
    const item = CATALOG_MAP.get(slug);
    if (!item || item.slot !== "consumable") throw new Error(`Invalid consumable: ${slug}`);
  }
}

export const rosterRoutes = new Elysia({ prefix: "/roster" })
  .use(context)
  // GET /api/roster — an unauthenticated caller gets [], as in Convex.
  .get("/", async ({ db, maybeUser }) => {
    const user = await maybeUser();
    if (!user) return [];
    return db.select().from(rosterUnits).where(eq(rosterUnits.userId, user._id)).all();
  })
  // POST /api/roster — upsert. `id` present updates, absent creates.
  .post(
    "/",
    async ({ db, user, body }) => {
      const owner = await user();
      validateLoadout(body.loadout);
      const values = {
        userId: owner._id,
        name: body.name,
        personality: body.personality,
        model: body.model,
        skin: body.skin ?? null,
        loadout: body.loadout,
      };
      if (body.id) {
        const existing = db.select().from(rosterUnits).where(eq(rosterUnits._id, body.id)).get();
        // Same message for "missing" and "someone else's" so the endpoint is not
        // an existence oracle for other players' unit ids.
        if (!existing || existing.userId !== owner._id) throw new Error("Not your unit");
        db.update(rosterUnits).set(values).where(eq(rosterUnits._id, body.id)).run();
        return { id: body.id };
      }
      const created = db.insert(rosterUnits).values(values).returning().get();
      if (!created) throw new Error("Failed to save unit");
      return { id: created._id };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String({ minLength: 1, maxLength: 64 }),
        personality: t.String({ maxLength: 4000 }),
        model: t.String({ minLength: 1, maxLength: 128 }),
        skin: t.Optional(t.String({ maxLength: 64 })),
        loadout: loadoutSchema,
      }),
    },
  )
  // DELETE /api/roster/:id
  .delete(
    "/:id",
    async ({ db, user, params }) => {
      const owner = await user();
      const existing = db.select().from(rosterUnits).where(eq(rosterUnits._id, params.id)).get();
      if (!existing || existing.userId !== owner._id) throw new Error("Not your unit");
      db.delete(rosterUnits).where(eq(rosterUnits._id, params.id)).run();
      return { ok: true as const };
    },
    { params: t.Object({ id: t.String() }) },
  );
