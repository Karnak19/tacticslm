// Model picker built on the AI Elements ModelSelector (cmdk command palette).
// Lists the full OpenRouter catalog (public endpoint, no key needed), grouped
// by provider, with a curated "Recommended" group on top.

import { useEffect, useMemo, useState } from "react";
import { ChevronsUpDownIcon } from "lucide-react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "./ai-elements/model-selector";

type OpenRouterModel = {
  id: string;
  name: string;
  promptPrice: number; // $/token
  completionPrice: number;
};

const RECOMMENDED = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.5-flash",
  "z-ai/glm-5.1",
  "openai/gpt-5.5",
];

// models.dev logo slugs for common OpenRouter provider prefixes.
const LOGO_SLUGS: Record<string, string> = {
  "x-ai": "xai",
  "meta-llama": "meta",
  qwen: "alibaba",
};

function logoSlug(provider: string): string {
  return LOGO_SLUGS[provider] ?? provider;
}

// $/token → "$X.XX" per million tokens, with sensible precision.
function perMillion(price: number): string {
  const m = price * 1_000_000;
  if (m >= 100) return `$${Math.round(m)}`;
  if (m >= 10) return `$${m.toFixed(1)}`;
  return `$${m.toFixed(2)}`;
}

function PriceTag({ model }: { model: OpenRouterModel | undefined }) {
  if (!model) return null;
  if (model.promptPrice === 0 && model.completionPrice === 0) {
    return <span className="ml-auto shrink-0 font-mono text-xs text-emerald-400">free</span>;
  }
  return (
    <span
      className="ml-auto shrink-0 font-mono text-xs text-zinc-500 tabular-nums"
      title="input / output per 1M tokens"
    >
      {perMillion(model.promptPrice)} in · {perMillion(model.completionPrice)} out /M
    </span>
  );
}

let cache: Array<OpenRouterModel> | null = null;

function useOpenRouterModels(): Array<OpenRouterModel> {
  const [models, setModels] = useState<Array<OpenRouterModel>>(cache ?? []);
  useEffect(() => {
    if (cache) return;
    fetch("https://openrouter.ai/api/v1/models")
      .then((r) => r.json())
      .then(
        (d: {
          data: Array<{
            id: string;
            name: string;
            pricing?: { prompt?: string; completion?: string };
          }>;
        }) => {
          cache = d.data
            .map((m) => ({
              id: m.id,
              name: m.name,
              promptPrice: Number(m.pricing?.prompt ?? 0),
              completionPrice: Number(m.pricing?.completion ?? 0),
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
          setModels(cache);
        },
      )
      .catch(() => {});
  }, []);
  return models;
}

export default function ModelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const models = useOpenRouterModels();
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);

  const byProvider = useMemo(() => {
    const groups = new Map<string, Array<OpenRouterModel>>();
    for (const m of models) {
      const provider = m.id.split("/")[0];
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider)!.push(m);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const provider = value.split("/")[0];

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none hover:border-zinc-600 focus:border-zinc-600"
        >
          {value && <ModelSelectorLogo provider={logoSlug(provider)} className="size-4" />}
          <span className="min-w-0 flex-1 truncate text-left font-mono">
            {value || "Pick a model…"}
          </span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-zinc-500" />
        </button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Pick a brain" className="sm:max-w-2xl">
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No model found.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Recommended">
            {RECOMMENDED.map((id) => (
              <ModelSelectorItem key={`rec-${id}`} value={`rec ${id}`} onSelect={() => select(id)}>
                <ModelSelectorLogo provider={logoSlug(id.split("/")[0])} />
                <ModelSelectorName>{id}</ModelSelectorName>
                <PriceTag model={byId.get(id)} />
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
          {byProvider.map(([providerName, providerModels]) => (
            <ModelSelectorGroup heading={providerName} key={providerName}>
              {providerModels.map((m) => (
                <ModelSelectorItem
                  key={m.id}
                  value={m.id}
                  onSelect={() => select(m.id)}
                  title={m.id}
                >
                  <ModelSelectorLogo provider={logoSlug(providerName)} />
                  <ModelSelectorName>{m.name}</ModelSelectorName>
                  <PriceTag model={m} />
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
