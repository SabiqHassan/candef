import { useEffect, useRef } from "react";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router";
import { DataProvider, useData } from "./DataContext";
import { ExplorerPage } from "../features/explorer/ExplorerPage";
import { DossierPage } from "../features/company/DossierPage";
import { LeadsPage } from "../features/leads/LeadsPage";
import { MethodologyPage } from "../features/methodology/MethodologyPage";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { Page } from "../ui/Page";

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <DataProvider>
        <Shell />
      </DataProvider>
    </BrowserRouter>
  );
}

function Shell() {
  const { snap } = useData();
  const location = useLocation();
  // After an in-app page change, keyboard and screen-reader users start at the new page rather than
  // on the link they activated. Not on first load, and not for search-parameter changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [location.pathname]);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <NavLink to="/" className="wordmark" aria-label="CANDEF home">
          <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="4" fill="var(--accent)" />
            <circle cx="6" cy="9" r="2.2" fill="var(--company)" />
            <circle cx="26" cy="8" r="2.2" fill="var(--company)" />
            <circle cx="7" cy="24" r="2.2" fill="var(--investor)" />
            <circle cx="25" cy="24" r="2.2" fill="var(--government)" />
          </svg>
          <span className="wordmark-text">CANDEF</span>
        </NavLink>
        <nav className="topnav" aria-label="Primary">
          <NavLink
            to={{ pathname: "/", search: location.pathname === "/" ? location.search : "" }}
            end
          >
            Explorer
          </NavLink>
          <NavLink to="/leads">Leads</NavLink>
          <NavLink to="/methodology" aria-label="Coverage and method">
            <span className="nav-long">Coverage and method</span>
            <span className="nav-short" aria-hidden="true">
              Method
            </span>
          </NavLink>
        </nav>
        {snap.meta.preview ? (
          <p
            className="demo-banner preview-banner"
            role="note"
            aria-label="Local preview of unverified drafts. Not reviewed by the owner; not for distribution."
          >
            <strong>Local preview: unverified drafts.</strong>
            <span className="demo-banner-detail">
              {" "}
              Not reviewed by the owner; not for distribution.
            </span>
          </p>
        ) : (
          snap.meta.isDemo && (
            <p
              className="demo-banner"
              role="note"
              aria-label="Fictional demonstration data. No company, person, amount or source here is real."
            >
              <strong>
                Fictional <span className="demo-banner-long">demonstration </span>data.
              </strong>
              <span className="demo-banner-detail">
                {" "}
                No company, person, amount or source here is real.
              </span>
            </p>
          )
        )}
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            <Route path="/" element={<ExplorerPage />} />
            <Route path="/company/:slug" element={<DossierPage />} />
            <Route path="/leads" element={<LeadsPage />} />
            <Route path="/methodology" element={<MethodologyPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <Page label="Page not found">
      <h1>Page not found</h1>
      <p>
        <NavLink to="/">Return to the explorer</NavLink>
      </p>
    </Page>
  );
}
