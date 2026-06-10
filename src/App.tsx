import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { Authenticated, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import Home from "./pages/Home";
import Room from "./pages/Room";
import Dashboard from "./pages/Dashboard";
import DevEditor from "./pages/DevEditor";
import SiteNav from "./components/SiteNav";

// Creates the user doc (and starter roster on first sign-in) as soon as
// Convex sees the Clerk session.
function EnsureUser() {
  const ensure = useMutation(api.users.ensure);
  useEffect(() => {
    ensure({}).catch(() => {});
  }, [ensure]);
  return null;
}

function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Authenticated>
        <EnsureUser />
      </Authenticated>
      <SiteNav />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/room/:code" element={<Room />} />
        {import.meta.env.DEV && <Route path="/dev/editor" element={<DevEditor />} />}
      </Routes>
    </div>
  );
}

export default App;
