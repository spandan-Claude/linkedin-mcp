import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// ── Credentials ──────────────────────────────────────────────────────────────
const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const ACCOUNT_URN           = process.env.LINKEDIN_ACCOUNT_URN;
const MCP_AUTH_TOKEN        = process.env.MCP_AUTH_TOKEN;

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
const server = new McpServer({
  name:    "linkedin-ads-mcp",
  version: "1.0.0"
});

// Tool 1: Get Campaign Analytics
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
      q:                       "analytics",
      accounts:                `List(${ACCOUNT_URN})`,
      pivot,
      timeGranularity,
      "dateRange.start.year":  startYear,
      "dateRange.start.month": startMonth,
      "dateRange.start.day":   startDay,
      "dateRange.end.year":    endYear,
      "dateRange.end.month":   endMonth,
      "dateRange.end.day":     endDay,
      fields:                  "impressions,clicks,costInLocalCurrency,dateRange,pivotValues"
    });
    const result = await linkedInGet(`/adAnalytics?${params}`);
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 2: List Campaigns
server.tool(
  "list_campaigns",
  "List all LinkedIn ad campaigns with status and budget",
  { status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "ALL"]).default("ALL") },
  async ({ status }) => {
    let path = `/adCampaigns?q=search&search.account.values[0]=${ACCOUNT_URN}`;
    if (status !== "ALL") path += `&search.status.values[0]=${status}`;
    const result = await linkedInGet(path);
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 3: Pause or Activate Campaign
server.tool(
  "update_campaign_status",
  "Pause or activate a LinkedIn campaign",
  {
    campaignId: z.string().describe("Campaign ID to update"),
    status:     z.enum(["ACTIVE", "PAUSED"])
  },
  async ({ campaignId, status }) => {
    const result = await linkedInPost(
      `/adCampaigns/${campaignId}?action=partialUpdate`,
      { patch: { $set: { status } } }
    );
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 4: Send Conversion Event
server.tool(
  "send_conversion_event",
  "Send an enrollment conversion event back to LinkedIn for optimization",
  {
    conversionId:    z.string().describe("Your LinkedIn conversion rule ID"),
    eventHappenedAt: z.string().describe("Unix timestamp in milliseconds"),
    userEmail:       z.string().describe("Email of converted user"),
    conversionValue: z.number().optional().describe("Revenue value in INR"),
  },
  async ({ conversionId, eventHappenedAt, userEmail, conversionValue }) => {
    const encoder     = new TextEncoder();
    const emailBytes  = encoder.encode(userEmail.toLowerCase().trim());
    const hashBuffer  = await crypto.subtle.digest("SHA-256", emailBytes);
    const hashArray   = Array.from(new Uint8Array(hashBuffer));
    const hashedEmail = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    const body = {
      conversion:           `urn:li:conversion:${conversionId}`,
      conversionHappenedAt: parseInt(eventHappenedAt),
      user: { userIds: [{ idType: "SHA256_EMAIL", idValue: hashedEmail }] },
      ...(conversionValue && {
        conversionValue: { amount: String(conversionValue), currencyCode: "INR" }
      })
    };
    const result = await linkedInPost("/conversionEvents", body);
    return { content: [{ type: "text", text: result }] };
  }
);

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();
const transports = {};

// ✅ ROOT route — fixes "Cannot GET /"
app.get("/", (req, res) => {
  res.json({
    name:    "LinkedIn Ads MCP Server",
    version: "1.0.0",
    status:  "running",
    endpoints: {
      sse:    "/sse",
      health: "/health"
    }
  });
});

// ✅ Health check — keeps Render free tier awake (ping this every 5 min)
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "linkedin-mcp", timestamp: new Date().toISOString() });
});

// ✅ OAuth metadata — Claude checks this to discover auth endpoints
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = `https://${req.headers.host}`;
  res.json({
    issuer:                   base,
    authorization_endpoint:   `${base}/authorize`,
    token_endpoint:           `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported:    ["authorization_code"]
  });
});

// ✅ Authorization page — shown to user to approve Claude's access
app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  res.send(`
    <html>
      <body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;">
        <h2>LinkedIn MCP Server</h2>
        <p>Allow Claude to access your LinkedIn Ads data?</p>
        <form method="POST" action="/approve">
          <input type="hidden" name="redirect_uri" value="${redirect_uri}">
          <input type="hidden" name="state" value="${state}">
          <button type="submit"
            style="background:#0077B5;color:white;padding:12px 28px;border:none;border-radius:6px;font-size:16px;cursor:pointer;">
            Allow Access
          </button>
        </form>
      </body>
    </html>
  `);
});

// ✅ Approve — redirects back to Claude with auth code
app.post("/approve", express.urlencoded({ extended: true }), (req, res) => {
  const { redirect_uri, state } = req.body;
  const code = Buffer.from(`auth-${Date.now()}`).toString("base64");
  res.redirect(`${redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
});

// ✅ Token endpoint — exchanges code for the MCP auth token
app.post("/token", express.urlencoded({ extended: true }), express.json(), (req, res) => {
  res.json({
    access_token: MCP_AUTH_TOKEN,
    token_type:   "Bearer",
    expires_in:   999999
  });
});

// ✅ SSE endpoint — Claude connects here to establish MCP session
app.get("/sse", async (req, res) => {
  // Optional: verify bearer token if MCP_AUTH_TOKEN is set
  if (MCP_AUTH_TOKEN) {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "").trim();
    if (token !== MCP_AUTH_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

// ✅ Messages endpoint — Claude sends tool calls here
app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LinkedIn MCP server running on port ${PORT}`);
});
