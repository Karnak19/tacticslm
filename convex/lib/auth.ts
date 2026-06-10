import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { STARTER_UNITS } from "./starters";

export async function currentUser(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
    .unique();
}

export async function requireUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await currentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  return user;
}

// Mutations auto-create the user document on first authenticated call.
export async function ensureUser(ctx: MutationCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
    .unique();
  if (existing) {
    const name = identity.nickname ?? identity.name ?? existing.name;
    if (name !== existing.name) await ctx.db.patch(existing._id, { name });
    return (await ctx.db.get(existing._id))!;
  }
  const id = await ctx.db.insert("users", {
    clerkId: identity.subject,
    name: identity.nickname ?? identity.name ?? "Commander",
  });
  // Every new commander starts with a ready-to-fight squad.
  for (const unit of STARTER_UNITS) {
    await ctx.db.insert("rosterUnits", { userId: id, ...unit });
  }
  return (await ctx.db.get(id))!;
}
