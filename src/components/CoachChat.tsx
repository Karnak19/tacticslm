// Inline squad-building coach — streams from the Convex /coach HTTP action.
// The OpenRouter key + model travel via headers only (PokerLM pattern).

import { useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { SparklesIcon, CheckIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { Message, MessageContent } from "./ai-elements/message";
import { Response } from "./ai-elements/response";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "./ai-elements/prompt-input";
import ModelPicker from "./ModelPicker";
import { itemIcon } from "../lib/sprites";
import { getApiKey } from "../lib/session";

const COACH_URL = (import.meta.env.VITE_CONVEX_URL as string).replace(".cloud", ".site") + "/coach";

type Block = { kind: "text"; text: string } | { kind: "code"; text: string };

// Parse fenced ```code``` blocks out of a message. Everything else is text.
function parseBlocks(src: string): Array<Block> {
  const out: Array<Block> = [];
  const re = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: src.slice(last, m.index) });
    out.push({ kind: "code", text: m[1].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

function messageText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

export type ProposedBuild = {
  name?: string;
  weapon: string;
  helmet: string;
  chest: string;
  boots: string;
  active: string;
  consumables: Array<string>;
  personality?: string;
  rationale: string;
};

export default function CoachChat({
  onUsePersonality,
  onApplyBuild,
}: {
  onUsePersonality: (text: string) => void;
  onApplyBuild: (build: ProposedBuild) => void;
}) {
  const [model, setModel] = useState("google/gemini-2.5-flash");
  const [applied, setApplied] = useState<string | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: COACH_URL,
        headers: () => ({
          "x-openrouter-key": getApiKey(),
          "x-model": model,
        }),
      }),
    [model],
  );

  const { messages, sendMessage, status } = useChat({ transport });
  const hasKey = getApiKey().length > 0;

  function onSubmit(message: PromptInputMessage) {
    if (!message.text?.trim()) return;
    sendMessage({ text: message.text });
  }

  function use(text: string) {
    onUsePersonality(text);
    setApplied(text);
    setTimeout(() => setApplied(null), 1500);
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-zinc-800 bg-zinc-950/60">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <SparklesIcon className="size-4 text-emerald-400" />
        <span className="text-sm font-semibold">Coach</span>
        <div className="ml-auto w-48">
          <ModelPicker value={model} onChange={setModel} />
        </div>
      </div>

      {!hasKey ? (
        <p className="p-4 text-sm text-zinc-500">
          Add your OpenRouter key on the home page to talk to the coach.
        </p>
      ) : (
        <>
          <Conversation className="min-h-0 flex-1">
            <ConversationContent className="gap-3 p-3">
              {messages.length === 0 && (
                <ConversationEmptyState
                  title="Ask the coach"
                  description="“Build me an annoying tank”, “a personality for a grenade maniac”, “what counters a sniper?”"
                />
              )}
              {messages.map((message) => {
                const text = messageText(message.parts as Array<{ type: string; text?: string }>);
                if (message.role === "user") {
                  return (
                    <Message from="user" key={message.id}>
                      <MessageContent>{text}</MessageContent>
                    </Message>
                  );
                }
                const builds = (message.parts as Array<{ type: string; input?: ProposedBuild }>)
                  .filter((p) => p.type === "tool-propose_build" && p.input?.weapon)
                  .map((p) => p.input!);
                return (
                  <Message from="assistant" key={message.id}>
                    <MessageContent className="space-y-2">
                      {parseBlocks(text).map((block, i) =>
                        block.kind === "text" ? (
                          <Response className="text-sm" key={i}>
                            {block.text}
                          </Response>
                        ) : (
                          <div
                            className="rounded-lg border border-emerald-500/30 bg-zinc-900 p-2"
                            key={i}
                          >
                            <p className="text-sm whitespace-pre-wrap text-zinc-200">
                              {block.text}
                            </p>
                            <button
                              onClick={() => use(block.text)}
                              className="mt-2 flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.96]"
                            >
                              {applied === block.text ? (
                                <>
                                  <CheckIcon className="size-3" /> Applied
                                </>
                              ) : (
                                "Use this personality"
                              )}
                            </button>
                          </div>
                        ),
                      )}
                      {builds.map((build, i) => (
                        <BuildCard
                          key={`build-${i}`}
                          build={build}
                          onApply={() => {
                            onApplyBuild(build);
                            setApplied(`build-${message.id}-${i}`);
                            setTimeout(() => setApplied(null), 1500);
                          }}
                          applied={applied === `build-${message.id}-${i}`}
                        />
                      ))}
                    </MessageContent>
                  </Message>
                );
              })}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <div className="border-t border-zinc-800 p-2">
            <PromptInput onSubmit={onSubmit}>
              <PromptInputBody>
                <PromptInputTextarea placeholder="Ask for builds, counters, personalities…" />
              </PromptInputBody>
              <PromptInputSubmit
                status={status === "streaming" ? "streaming" : undefined}
                className="absolute right-2 bottom-2"
              />
            </PromptInput>
          </div>
        </>
      )}
    </div>
  );
}

function BuildCard({
  build,
  onApply,
  applied,
}: {
  build: ProposedBuild;
  onApply: () => void;
  applied: boolean;
}) {
  const slots = [build.weapon, build.helmet, build.chest, build.boots, build.active];
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-zinc-900 p-3">
      {build.name && <p className="mb-1 text-sm font-semibold">{build.name}</p>}
      <div className="mb-2 flex items-center gap-2">
        {slots.map((slug) => (
          <img
            key={slug}
            src={itemIcon(slug)}
            alt={slug}
            title={slug}
            className="h-6 w-6 opacity-90"
          />
        ))}
        <span className="mx-1 text-zinc-600">+</span>
        {build.consumables.map((slug) => (
          <img
            key={slug}
            src={itemIcon(slug)}
            alt={slug}
            title={slug}
            className="h-5 w-5 opacity-70"
          />
        ))}
      </div>
      <p className="text-xs text-zinc-400">{build.rationale}</p>
      {build.personality && (
        <p className="mt-1.5 border-l-2 border-zinc-700 pl-2 text-xs text-zinc-300 italic">
          {build.personality}
        </p>
      )}
      <button
        onClick={onApply}
        className="mt-2 flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.96]"
      >
        {applied ? (
          <>
            <CheckIcon className="size-3" /> Equipped
          </>
        ) : (
          "Equip this build"
        )}
      </button>
    </div>
  );
}
