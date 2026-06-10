import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Dev utility: wipe all game data (keeps the item catalog and users).
// bunx convex run dev:wipe
export const wipe = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const table of ["messages", "turns", "matches", "units", "players", "rooms"] as const) {
      const docs = await ctx.db.query(table).collect();
      for (const doc of docs) await ctx.db.delete(doc._id);
    }
    return null;
  },
});

// One-off: set every unit (roster + in-room) to a given model.
// bunx convex run dev:setAllModels '{"model":"deepseek/deepseek-v4-flash"}'
export const setAllModels = internalMutation({
  args: { model: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    let n = 0;
    for (const table of ["rosterUnits", "units"] as const) {
      for (const doc of await ctx.db.query(table).collect()) {
        await ctx.db.patch(doc._id, { model: args.model });
        n++;
      }
    }
    return n;
  },
});
