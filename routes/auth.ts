import { Hono } from "hono";
import { db } from "../db";
import { connections, developers } from "../db/schema";

const auth = new Hono();

const BASE_URL = process.env.BASE_URL;
const BASE_PORT = process.env.BASE_PORT;

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID!;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;

// NOTION
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const NOTION_API_VERSION = "2022-06-28";

const ADMIN_SECRET = process.env.ADMIN_SECRET;

auth.post("/developers/create", async (c) => {
  const secret = c.req.header("x-admin-secret");

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const apiKey = `narthex_${crypto.randomUUID().replace(/-/g, "")}`;

  const [developer] = await db
    .insert(developers)
    .values({ apiKey })
    .returning();

  return c.json({ developerId: developer.id, apiKey });
});

auth.get("/:appId", (c) => {
  const appId = c.req.param("appId");
  const devId = c.req.query("devId");
  const userId = c.req.query("userId");

  if (!devId || !userId) {
    return c.json({ error: "Missing devId or userId" }, 400);
  }

  const state = Buffer.from(JSON.stringify({ devId, userId })).toString(
    "base64",
  );

  if (appId === "github") {
    const redirectUri = `${BASE_URL}/auth/github/callback`;
    const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${redirectUri}&state=${state}&scope=read:user repo`;
    return c.redirect(githubAuthUrl);
  }

  if (appId === "google") {
    const redirectUri = `${BASE_URL}/auth/google/callback`;
    const scopes = [
      "https://www.googleapis.com/auth/userinfo.email",
      // "https://www.googleapis.com/auth/gmail.send",
      // "https://www.googleapis.com/auth/gmail.modify",
      // "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/calendar",
    ].join(" ");

    const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=${scopes}&state=${state}&access_type=offline&prompt=consent`;
    return c.redirect(googleUrl);
  }

  if (appId === "notion") {
    const redirectUri = `${BASE_URL}/auth/notion/callback`;
    const notionUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${NOTION_CLIENT_ID}&response_type=code&owner=user&redirect_uri=${redirectUri}&state=${state}`;
    return c.redirect(notionUrl);
  }

  return c.json({ error: "Integration not found" }, 404);
});

auth.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) return c.json({ error: "Invalid callback" }, 400);

  const { devId, userId } = JSON.parse(
    Buffer.from(state, "base64").toString("utf-8"),
  );

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error)
    return c.json({ error: tokenData.error_description }, 400);

  await db.insert(connections).values({
    id: crypto.randomUUID(),
    developerId: devId,
    endUserId: userId,
    appId: "github",
    accessToken: tokenData.access_token,
  });

  return c.html(
    `<html style="font-family: sans-serif; text-align: center; padding: 50px;"><body><h1 style="color: #4CAF50;">GitHub Connected! 🎉</h1><p>You can close this window and return to your chat.</p></body></html>`,
  );
});

auth.get("/notion/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) return c.json({ error: "Invalid callback" }, 400);

  const { devId, userId } = JSON.parse(
    Buffer.from(state, "base64").toString("utf-8"),
  );
  console.log({ devId, userId });
  console.log({ code });
  console.log("FETCHING");

  const encoded = btoa(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`);
  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      // "Notion-Version": NOTION_API_VERSION,
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${encoded}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      redirect_uri: `${BASE_URL}/auth/notion/callback`,
      code: code,
    }),
  });
  if (!response.ok) {
    console.error(response.statusText);
  }

  const data = await response.json();
  console.log(data);

  await db.insert(connections).values({
    id: crypto.randomUUID(),
    developerId: devId,
    endUserId: userId,
    appId: "notion",
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  });

  return c.html(
    `<html style="font-family: sans-serif; text-align: center; padding: 50px;"><body><h1 style="color: #4CAF50;">Notion Connected! 🎉</h1><p>You can close this window and return to your chat.</p></body></html>`,
  );
});

auth.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) return c.json({ error: "Invalid callback" }, 400);

  const { devId, userId } = JSON.parse(
    Buffer.from(state, "base64").toString("utf-8"),
  );

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${BASE_URL}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json();

  if (data.error) return c.json({ error: data.error_description }, 400);
  await db
    .insert(connections)
    .values({
      id: crypto.randomUUID(),
      developerId: devId,
      endUserId: userId,
      appId: "google",
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
    })
    .onConflictDoUpdate({
      target: [
        connections.developerId,
        connections.endUserId,
        connections.appId,
      ],
      set: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        updatedAt: new Date(), // drop this if you don't have the column
      },
    });

  return c.html(
    `<html style="font-family: sans-serif; text-align: center; padding: 50px;"><body><h1 style="color: #4CAF50;">Google Connected! 🎉</h1><p>You can close this window and return to your chat.</p></body></html>`,
  );
});

export { auth };
