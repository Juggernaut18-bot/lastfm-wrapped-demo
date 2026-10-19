import { handleAsNodeRequest } from "cloudflare:node";
import "./server.js";

const API_ROUTES = [
  "/recent",
  "/info",
  "/top-artists",
  "/top-albums",
  "/top-tracks",
  "/history",
  "/stats",
  "/lifetime",
  "/wrapped",
  "/concerts"
];

function isApiRequest(pathname) {
  return API_ROUTES.some(
    route => pathname === route || pathname.startsWith(`${route}/`)
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (isApiRequest(url.pathname)) {
      return handleAsNodeRequest(4000, request);
    }

    return env.ASSETS.fetch(request);
  }
};
