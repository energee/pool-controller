// Entry point for the React dashboard SPA. Mounts <Dashboard /> at #root and a
// single sonner <Toaster /> for command verdicts. Bundled by Bun into
// easytouch/static/app.js, which the Python server serves at GET /static/app.js.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import { Dashboard } from "./components/Dashboard";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Dashboard />
      <Toaster
        theme="dark"
        position="bottom-center"
        richColors
        visibleToasts={1}
        duration={3000}
      />
    </StrictMode>
  );
}
