import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installApiFetchInterceptor } from "./utils/apiFetch";

import "antd/dist/reset.css"; // ✅ IMPORTANT

// Must run before any component fires its first /api/* fetch.
installApiFetchInterceptor();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);