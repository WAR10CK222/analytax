import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Analytax: missing #root element");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
