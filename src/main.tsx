import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./app/app.css";
import { App } from "./app/App";
import { preloadGraphForLikelyVisit } from "./features/explorer/graphLoader";
import { ErrorBoundary } from "./ui/ErrorBoundary";

// Fetch the 3D view in parallel with the data when this visit will probably show it.
preloadGraphForLikelyVisit();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary resetKey="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
