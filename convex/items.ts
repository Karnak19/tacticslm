import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { CATALOG } from "./lib/catalog";

// Idempotent upsert of the v1 catalog, keyed by slug.
// Run with: bunx convex run items:seed
export const seed = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const item of CATALOG) {
      const existing = await ctx.db
        .query("items")
        .withIndex("by_slug", (q) => q.eq("slug", item.slug))
        .unique();
      if (existing) {
        await ctx.db.replace(existing._id, item);
      } else {
        await ctx.db.insert("items", item);
      }
    }
    return null;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("items").collect();
  },
});
