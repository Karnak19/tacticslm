import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { convertToModelMessages, streamText, tool, type UIMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { BASE_STATS, CATALOG } from "./lib/catalog";

const slugsBySlot = (slot: string) =>
  CATALOG.filter((i) => i.slot === slot).map((i) => i.slug) as [string, ...Array<string>];

// The coach can propose a complete build; the UI renders it as an
// equippable card. Slugs are validated against the real catalog.
const proposeBuild = tool({
  description:
    "Propose a complete unit build the user can equip with one click. Use this whenever you recommend a full or partial loadout. Always pick exactly 2 consumables.",
  inputSchema: z.object({
    name: z.string().optional().describe("A fitting unit name"),
    weapon: z.enum(slugsBySlot("weapon")),
    helmet: z.enum(slugsBySlot("helmet")),
    chest: z.enum(slugsBySlot("chest")),
    boots: z.enum(slugsBySlot("boots")),
    active: z.enum(slugsBySlot("active")),
    consumables: z.array(z.enum(slugsBySlot("consumable"))).length(2),
    personality: z
      .string()
      .optional()
      .describe("A 2-6 sentence personality prompt matching the build"),
    rationale: z.string().describe("One or two sentences on why this build works"),
  }),
  execute: async () => "Build shown to the user with an Equip button.",
});

const ITEM_SHEET = (["weapon", "helmet", "chest", "boots", "active", "consumable"] as const)
  .map((slot) => {
    const items = CATALOG.filter((i) => i.slot === slot)
      .map((i) => `- ${i.name}: ${i.description}`)
      .join("\n");
    return `${slot.toUpperCase()}S:\n${items}`;
  })
  .join("\n\n");

const COACH_SYSTEM = `You are a squad-building coach for TacticsLM, a 3v3 AI-vs-AI tactical grid game. The user designs units: each unit has a PERSONALITY PROMPT (the soul — it drives an autonomous LLM in battle), a gear loadout, and an LLM model choice.

GAME RULES:
- 16×16 grid with walls. Turn-based, initiative ordered by speed (higher acts first).
- Each unit is an independent LLM. Teammates coordinate ONLY by short chat messages spoken on their turns — misunderstandings are part of the game.
- A turn = optional move + one action (attack / active ability / consumable / wait).
- Base stats before gear: ${BASE_STATS.hp} HP, ${BASE_STATS.move} move, ${BASE_STATS.speed} speed. No innate attack — the weapon defines it.
- Win by elimination, or highest team HP at round 20.

ITEM CATALOG:
${ITEM_SHEET}

YOUR JOB:
- Be opinionated. Suggest concrete builds (synergies between weapon/gear/active) and matching personalities.
- When you recommend a loadout, CALL the propose_build tool — the user can equip it with one click. Include a matching personality in the tool call when it makes sense. Briefly explain the build in your text too.
- Personalities matter most: aggression vs caution, how they talk to teammates, target priorities, when to retreat, how they use consumables. A good personality references the unit's own kit.
- When you propose a personality prompt the user can use directly, put it inside a fenced markdown code block (\`\`\`). The UI shows a "Use this personality" button next to each code block — so the code block must contain ONLY the personality text itself.
- Keep personalities 2-6 sentences. They are injected into the unit's system prompt; the app already explains the rules to the unit.
- Cheap fast models (gemini flash, haiku) follow simple direct personalities best; smarter models can handle nuance and scheming.`;

const http = httpRouter();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-openrouter-key, x-model",
};

http.route({
  path: "/coach",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: corsHeaders })),
});

http.route({
  path: "/coach",
  method: "POST",
  handler: httpAction(async (_ctx, req) => {
    // Key + model travel via headers only — never logged, never persisted.
    const apiKey = req.headers.get("x-openrouter-key");
    const model = req.headers.get("x-model");
    if (!apiKey || !model) {
      return new Response("missing x-openrouter-key or x-model header", {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { messages } = (await req.json()) as { messages: Array<UIMessage> };

    const openrouter = createOpenRouter({
      apiKey,
      headers: {
        "HTTP-Referer": "https://github.com/karnak19/tacticslm",
        "X-Title": "TacticsLM",
        "X-OpenRouter-Categories": "game",
      },
    });

    const result = streamText({
      model: openrouter.chat(model),
      system: COACH_SYSTEM,
      messages: await convertToModelMessages(messages),
      temperature: 0.7,
      tools: { propose_build: proposeBuild },
    });

    const response = result.toUIMessageStreamResponse();
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  }),
});

export default http;
