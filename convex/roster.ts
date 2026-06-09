import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { loadoutValidator } from "./schema";
import { toCatalog } from "./lib/db";
import { currentUser, ensureUser, requireUser } from "./lib/auth";
import { resolveStats } from "./lib/engine";
import { CONSUMABLE_SLOTS } from "./lib/catalog";

const MAX_ROSTER_SIZE = 24;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("rosterUnits")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
  },
});

// Upsert: pass an id to update an existing roster unit, omit it to create.
export const save = mutation({
  args: {
    id: v.optional(v.id("rosterUnits")),
    name: v.string(),
    personality: v.string(),
    model: v.string(),
    loadout: loadoutValidator,
  },
  returns: v.id("rosterUnits"),
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);

    const catalog = await toCatalog(ctx);
    resolveStats(args.loadout, catalog); // throws on unknown items
    if (args.loadout.consumables.length !== CONSUMABLE_SLOTS) {
      throw new Error(`Pick exactly ${CONSUMABLE_SLOTS} consumables`);
    }

    const unit = {
      userId: user._id,
      name: args.name,
      personality: args.personality,
      model: args.model,
      loadout: args.loadout,
    };
    if (args.id) {
      const existing = await ctx.db.get(args.id);
      if (!existing || existing.userId !== user._id) throw new Error("Not your unit");
      await ctx.db.replace(args.id, unit);
      return args.id;
    }
    const count = (
      await ctx.db
        .query("rosterUnits")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect()
    ).length;
    if (count >= MAX_ROSTER_SIZE) throw new Error("Roster is full");
    return await ctx.db.insert("rosterUnits", unit);
  },
});

export const remove = mutation({
  args: { id: v.id("rosterUnits") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing || existing.userId !== user._id) throw new Error("Not your unit");
    await ctx.db.delete(args.id);
    return null;
  },
});
