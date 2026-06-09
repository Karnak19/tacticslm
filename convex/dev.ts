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
