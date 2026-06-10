import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { ensureUser } from "./lib/auth";

// Called once by the client after sign-in: creates the user document and
// seeds the starter roster on first ever sign-in.
export const ensure = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ensureUser(ctx);
    return null;
  },
});
