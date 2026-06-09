// The OpenRouter key never leaves the browser except as a per-call argument to
// the brain action (transits only, never stored server-side).

const OPENROUTER_KEY = "tacticslm:openrouter-key";

export function getApiKey(): string {
  return localStorage.getItem(OPENROUTER_KEY) ?? "";
}

export function setApiKey(key: string): void {
  localStorage.setItem(OPENROUTER_KEY, key);
}
