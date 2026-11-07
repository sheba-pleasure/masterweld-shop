// Transport fixture only: no application startup, database, Telegram transport or order dispatch.
import http from "node:http";
import { existsSync } from "node:fs";
import { notificationWorkerActive } from "./notification-environment.mjs";

const sha = process.env.FIXTURE_SHA;
const mode = process.env.FIXTURE_MODE;
const active = () => notificationWorkerActive(process.env);
http.createServer((req, res) => {
  const viaGateway = req.headers.host === "127.0.0.1";
  const json = (data) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  };
  if (req.url.startsWith("/api/public/release-health")) {
    console.log(JSON.stringify({ health: true, sha, viaGateway, workerActive: active() }));
    const wrong = mode === "candidate-failure" ||
      (viaGateway && (mode === "gateway-failure" || existsSync("/tmp/fail-gateway")));
    return json({ ready: true, revision: wrong ? "0".repeat(40) : sha, environment: "production" });
  }
  if (req.url === "/fixture/worker") return json({ active: active() });
  if (req.url === "/rest/v1/probe") {
    return json({ fixtureBackend: true, authorization: req.headers.authorization });
  }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><meta name="robots" content="noindex, nofollow"><p>Release transport fixture</p>');
}).listen(3000, "0.0.0.0");
