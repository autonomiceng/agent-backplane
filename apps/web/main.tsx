// Browser entry point for the dashboard.
import { createRoot } from "react-dom/client";
import { Routes } from "./routes.tsx";

const root = document.getElementById("root");
if (root) createRoot(root).render(<Routes url={new URL(window.location.href)} />);
