import { Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import Room from "./pages/Room";
import Dashboard from "./pages/Dashboard";
import DevEditor from "./pages/DevEditor";
import SiteNav from "./components/SiteNav";

// No ensure-on-mount any more: `requireUser` on the Elysia side creates the user
// row and seeds the starter roster on the first authenticated request, so the
// client cannot race the backend into a missing-user error.
function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
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
