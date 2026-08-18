import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ClerkProvider, useAuth } from "@clerk/clerk-react";
import "./index.css";
import App from "./App.tsx";
import { setTokenGetter } from "./lib/eden";

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;

/**
 * Hands the Eden client Clerk's token getter.
 *
 * Has to live inside `<ClerkProvider>` — `useAuth` needs the context — and it is
 * a component rather than a call at module scope because `getToken` is bound to
 * the live session and is replaced on sign-in and sign-out.
 *
 * The assignment happens during render, NOT in an effect, and that is the point:
 * effects run child-first, so any component that fetches from its own mount
 * effect could otherwise beat the bridge and send its first request anonymous.
 * The server answers an anonymous read with an empty list rather than an error,
 * so the failure looks like "you have no units" and never retries. Assigning at
 * render makes the token available before any descendant effect can run, whatever
 * order they mount in. It is an idempotent write to a module ref, so it is safe
 * to repeat on every render and under StrictMode's double invocation.
 */
function EdenAuthBridge() {
  const { getToken } = useAuth();
  setTokenGetter(getToken);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClerkProvider publishableKey={clerkKey}>
      <EdenAuthBridge />
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClerkProvider>
  </StrictMode>,
);
