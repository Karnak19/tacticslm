import { Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import Room from "./pages/Room";
import Dashboard from "./pages/Dashboard";
import DevEditor from "./pages/DevEditor";

function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
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
