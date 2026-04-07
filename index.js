import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// ── Credentials ──────────────────────────────────────────────────────────────
const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const ACCOUNT_URN           = process.env.LINKEDIN_ACCOUNT_URN;

const BASE_URL = "https://api.linkedin.com/rest";
const HEADERS  = {
  "Authorization":             `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
  "LinkedIn-Version":          "202601",
  "X-Restli-Protocol-Version": "2.0.0",
  "Content-Type":              "application/json"
};

async function linkedInGet(path) {
  const res  = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

async function linkedInPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  "POST",
    headers: HEADERS,
    body:    JSON.stringify(body)
  });
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

// ── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "linkedin-ads-mcp", version: "1.0.0" });

server.tool(
  "get_campaign_analytics",
  "Get LinkedIn ad performance — impressions, clicks, spend by campaign",
  {
    pivot:           z.enum(["CAMPAIGN", "CREATIVE", "CAMPAIGN_GROUP"]).default("CAMPAIGN"),
    timeGranularity: z.enum(["DAILY", "MONTHLY", "ALL"]).default("DAILY"),
    dateStart:       z.string().describe("Start date YYYY-MM-DD"),
    dateEnd:         z.string().describe("End date YYYY-MM-DD"),
  },
  async ({ pivot, timeGranularity, dateStart, dateEnd }) => {
    const [startYear, startMonth, startDay] = dateStart.split("-");
    const [endYear,   endMonth,   endDay  ] = dateEnd.split("-");
    const params = new URLSearchParams({
      q: "analytics", accounts: `List(${ACCOUNT_URN})`, pivot, timeGranularity,
      "dateRange.start.year": startYear, "dateRange.start.month": startMonth, "dateRange.start.day": startDay,
      "dateRange.end.year": endYear, "dateRange.end.month": endMonth, "dateRange.end.day": endDay,
      fields: "impressions,clicks,costInLocalCurrency,dateRange,pivotValues"
    });
    return { content: [{ type: "text", text: await linkedInGet(`/adAnalytics?${params}`) }] };
  }
);

server.tool(
  "list_campaigns",
  "List all LinkedIn ad campaigns with status and budget",
  { status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "ALL"]).default("ALL") },
  async ({ status }) => {
    let path = `/adCampaigns?q=search&search.account.values[0]=${ACCOUNT_URN}`;
    if (status !== "ALL") path += `&search.status.values[0]=${status}`;
    return { content: [{ type: "text", text: await linkedInGet(path) }] };
  }
);

server.tool(
  "update_campaign_status",
  "Pause or activate a LinkedIn campaign",
  { campaignId: z.string(), status: z.enum(["ACTIVE", "PAUSED"]) },
  async ({ campaignId, status }) => {
    const result = await linkedInPost(
      `/adCampaigns/${campaignId}?action=partialUpdate`,
      { patch: { $set: { status } } }
    );
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "send_conversion_event",
  "Send an enrollment conversion event to LinkedIn",
  {
    conversionId:    z.string(),
    eventHappenedAt: z.string(),
    userEmail:       z.string(),
    conversionValue: z.number().optional(),
  },
  async ({ conversionId, eventHappenedAt, userEmail, conversionValue }) => {
    const emailBytes  = new TextEncoder().encode(userEmail.toLowerCase().trim());
    const hashBuffer  = await crypto.subtle.digest("SHA-256", emailBytes);
    const hashedEmail = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
    const body = {
      conversion: `urn:li:conversion:${conversionId}`,
      conversionHappenedAt: parseInt(eventHappenedAt),
      user: { userIds: [{ idType: "SHA256_EMAIL", idValue: hashedEmail }] },
      ...(conversionValue && { conversionValue: { amount: String(conversionValue), currencyCode: "INR" } })
    };
    return { content: [{ type: "text", text: await linkedInPost("/conversionEvents", body) }] };
  }
);

// ── Express App (AUTHLESS) ────────────────────────────────────────────────────
const app = express();
const transports = {};

app.get("/", (req, res) => {
  res.json({ name: "LinkedIn Ads MCP Server", version: "1.0.0", status: "running", endpoints: { sse: "/sse", health: "/health" } });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// SSE endpoint — NO auth (authless mode, OAuth in claude.ai is broken)
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LinkedIn MCP server running on port ${PORT}`));
