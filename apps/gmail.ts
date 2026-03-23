import { z } from "zod";
import type { NathraxApp } from "../core/types";
import { db } from "../db";
import { connections } from "../db/schema";
import { and, eq } from "drizzle-orm";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;

const BASE_URL = process.env.BASE_URL;
const BASE_PORT = process.env.BASE_PORT;
// ============================================================
//  1. EMAIL ENCODING UTILITY
// ============================================================

function createRawEmail({
  to,
  cc,
  bcc,
  subject,
  body,
  contentType = "text/plain",
  inReplyTo,
}: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  contentType?: "text/plain" | "text/html";
  inReplyTo?: string;
}) {
  const lines: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: ${contentType}; charset=utf-8`,
  ];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${inReplyTo}`);
  }
  lines.push("", body);
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

// ============================================================
//  2. TOKEN REFRESH ENGINE
// ============================================================

async function refreshGoogleToken(connectionId: string, refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (!response.ok || data.error) return null;

  await db
    .update(connections)
    .set({ accessToken: data.access_token })
    .where(eq(connections.id, connectionId));

  return data.access_token as string;
}

// ============================================================
//  3. SELF-HEALING API WRAPPER
// ============================================================

async function gmailRequest(
  endpoint: string,
  options: RequestInit,
  context: { developerId: string; endUserId: string },
) {
  const connection = await db.query.connections.findFirst({
    where: and(
      eq(connections.developerId, context.developerId),
      eq(connections.endUserId, context.endUserId),
      eq(connections.appId, "google"),
    ),
  });

  if (!connection) {
    const authUrl = `${BASE_URL}:${BASE_PORT}/auth/google?devId=${context.developerId}&userId=${context.endUserId}`;
    return {
      content: [
        {
          type: "text",
          text: `Auth required. Please authorize Gmail: ${authUrl}`,
        },
      ],
      isError: true,
    };
  }

  const makeRequest = async (token: string) =>
    fetch(`https://gmail.googleapis.com/gmail/v1/users/me${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

  try {
    let response = await makeRequest(connection.accessToken);

    // Auto-refresh on 401
    if (response.status === 401 && connection.refreshToken) {
      const newToken = await refreshGoogleToken(
        connection.id,
        connection.refreshToken,
      );
      if (newToken) {
        response = await makeRequest(newToken);
      } else {
        const authUrl = `${BASE_URL}:${BASE_PORT}/auth/google?devId=${context.developerId}&userId=${context.endUserId}`;
        return {
          content: [
            { type: "text", text: `Session expired. Re-authorize: ${authUrl}` },
          ],
          isError: true,
        };
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        content: [
          {
            type: "text",
            text: `Gmail API Error ${response.status}: ${errorBody}`,
          },
        ],
        isError: true,
      };
    }

    if (response.status === 204) {
      return {
        content: [
          { type: "text", text: "Action successful (204 No Content)." },
        ],
      };
    }

    const data = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      _raw: data,
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Network Error: ${error.message}` }],
      isError: true,
    };
  }
}

// ============================================================
//  4. CONTEXT-FRIENDLY FORMATTERS
//     Turn raw Gmail API responses into LLM-readable summaries
// ============================================================

function getHeader(headers: any[], name: string): string {
  return (
    headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

/** Recursively walk MIME parts and extract the best text body. */
function extractBody(payload: any): { plain: string; html: string } {
  let plain = "";
  let html = "";

  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64url").toString(
      "utf-8",
    );
    if (payload.mimeType === "text/plain") plain = decoded;
    if (payload.mimeType === "text/html") html = decoded;
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const child = extractBody(part);
      if (child.plain) plain = child.plain;
      if (child.html) html = child.html;
    }
  }

  return { plain, html };
}

/** Collect attachment metadata from a message payload. */
function extractAttachments(payload: any): {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}[] {
  const attachments: any[] = [];

  function walk(part: any) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return attachments;
}

/** Format a full message response into a context-friendly object. */
function formatMessage(msg: any) {
  const headers = msg.payload?.headers ?? [];
  const { plain, html } = extractBody(msg.payload ?? {});
  const attachments = extractAttachments(msg.payload ?? {});

  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    snippet: msg.snippet,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    bcc: getHeader(headers, "Bcc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    messageId: getHeader(headers, "Message-ID"),
    body: plain || html || "(no body)",
    bodyIsHtml: !plain && !!html,
    attachments,
  };
}

/** Format a thread response — summarise messages within it. */
function formatThread(thread: any) {
  const messages = (thread.messages ?? []).map(formatMessage);
  return {
    id: thread.id,
    snippet: thread.snippet,
    historyId: thread.historyId,
    messageCount: messages.length,
    messages,
  };
}

function ok(data: any) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ============================================================
//  5. TOOL DEFINITIONS
// ============================================================

export const gmailApp: NathraxApp = {
  appId: "google",
  displayName: "Gmail Integration",
  version: "2.0.0",
  tools: [
    // ===========================================
    //  PROFILE
    // ===========================================
    {
      name: "gmail_get_profile",
      description:
        "Get the authenticated user's Gmail profile: email address, total messages, total threads, and current historyId.",
      schema: z.object({}),
      execute: async (_args, context) => {
        return await gmailRequest("/profile", { method: "GET" }, context);
      },
    },

    // ===========================================
    //  MESSAGES
    // ===========================================
    {
      name: "gmail_search_messages",
      description:
        "Search for emails using Gmail search syntax. Returns a list of message IDs and threadIds. Use 'gmail_get_message' to fetch full details of individual results.",
      schema: z.object({
        query: z
          .string()
          .describe(
            "Gmail search query. Examples: 'is:unread', 'from:boss@co.com subject:urgent', 'has:attachment after:2025/01/01', 'in:sent to:client@co.com'.",
          ),
        maxResults: z.number().min(1).max(500).optional().default(10),
        pageToken: z
          .string()
          .optional()
          .describe("Pagination token from a previous response."),
        labelIds: z
          .array(z.string())
          .optional()
          .describe("Only return messages with ALL of these label IDs."),
        includeSpamTrash: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include messages from SPAM and TRASH."),
      }),
      execute: async (
        { query, maxResults, pageToken, labelIds, includeSpamTrash },
        context,
      ) => {
        const params = new URLSearchParams();
        params.set("q", query);
        if (maxResults) params.set("maxResults", String(maxResults));
        if (pageToken) params.set("pageToken", pageToken);
        if (includeSpamTrash) params.set("includeSpamTrash", "true");
        if (labelIds?.length)
          labelIds.forEach((id) => params.append("labelIds", id));

        return await gmailRequest(
          `/messages?${params}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_get_message",
      description:
        "Fetch the full content of an email by its ID. Returns parsed headers (from, to, cc, subject, date), decoded body text, and attachment metadata — ready for LLM consumption.",
      schema: z.object({
        messageId: z.string().describe("The message ID to retrieve."),
      }),
      execute: async ({ messageId }, context) => {
        const res = await gmailRequest(
          `/messages/${messageId}?format=full`,
          { method: "GET" },
          context,
        );
        if (res.isError) return res;
        try {
          const raw = JSON.parse(res.content[0].text);
          return ok(formatMessage(raw));
        } catch {
          return res;
        }
      },
    },

    {
      name: "gmail_send_message",
      description:
        "Compose and send a new email. Supports plain text or HTML, cc, and bcc.",
      schema: z.object({
        to: z
          .string()
          .describe("Recipient email address(es), comma-separated."),
        subject: z.string(),
        body: z.string().describe("The email body content."),
        cc: z.string().optional().describe("CC recipients, comma-separated."),
        bcc: z.string().optional().describe("BCC recipients, comma-separated."),
        isHtml: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, body is treated as HTML."),
      }),
      execute: async ({ to, subject, body, cc, bcc, isHtml }, context) => {
        const raw = createRawEmail({
          to,
          cc,
          bcc,
          subject,
          body,
          contentType: isHtml ? "text/html" : "text/plain",
        });
        return await gmailRequest(
          "/messages/send",
          { method: "POST", body: JSON.stringify({ raw }) },
          context,
        );
      },
    },

    {
      name: "gmail_reply_to_message",
      description:
        "Reply to an existing email thread. Requires the threadId and the Message-ID header from the email you're replying to.",
      schema: z.object({
        threadId: z.string().describe("The thread ID of the conversation."),
        inReplyTo: z
          .string()
          .describe(
            "The 'Message-ID' header value of the email being replied to.",
          ),
        to: z.string().describe("Recipient email address."),
        subject: z
          .string()
          .describe("Subject line (typically 'Re: <original subject>')."),
        body: z.string(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        isHtml: z.boolean().optional().default(false),
      }),
      execute: async (
        { threadId, inReplyTo, to, subject, body, cc, bcc, isHtml },
        context,
      ) => {
        const raw = createRawEmail({
          to,
          cc,
          bcc,
          subject,
          body,
          contentType: isHtml ? "text/html" : "text/plain",
          inReplyTo,
        });
        return await gmailRequest(
          "/messages/send",
          { method: "POST", body: JSON.stringify({ raw, threadId }) },
          context,
        );
      },
    },

    {
      name: "gmail_modify_message",
      description:
        "Add or remove labels from a message. Common operations: Archive (remove INBOX), Mark Read (remove UNREAD), Star (add STARRED), Trash (add TRASH).",
      schema: z.object({
        messageId: z.string(),
        addLabelIds: z
          .array(z.string())
          .optional()
          .default([])
          .describe("Label IDs to add."),
        removeLabelIds: z
          .array(z.string())
          .optional()
          .default([])
          .describe("Label IDs to remove."),
      }),
      execute: async ({ messageId, addLabelIds, removeLabelIds }, context) => {
        return await gmailRequest(
          `/messages/${messageId}/modify`,
          {
            method: "POST",
            body: JSON.stringify({ addLabelIds, removeLabelIds }),
          },
          context,
        );
      },
    },

    {
      name: "gmail_trash_message",
      description:
        "Move a message to the trash. It can be recovered within 30 days.",
      schema: z.object({
        messageId: z.string(),
      }),
      execute: async ({ messageId }, context) => {
        return await gmailRequest(
          `/messages/${messageId}/trash`,
          { method: "POST" },
          context,
        );
      },
    },

    {
      name: "gmail_untrash_message",
      description:
        "Remove a message from the trash and restore it to the mailbox.",
      schema: z.object({
        messageId: z.string(),
      }),
      execute: async ({ messageId }, context) => {
        return await gmailRequest(
          `/messages/${messageId}/untrash`,
          { method: "POST" },
          context,
        );
      },
    },

    {
      name: "gmail_delete_message",
      description:
        "Permanently delete a message. This is irreversible — prefer 'gmail_trash_message' unless the user explicitly wants permanent deletion.",
      schema: z.object({
        messageId: z.string(),
      }),
      execute: async ({ messageId }, context) => {
        return await gmailRequest(
          `/messages/${messageId}`,
          { method: "DELETE" },
          context,
        );
      },
    },

    {
      name: "gmail_batch_modify_messages",
      description:
        "Add or remove labels from multiple messages at once. Max 1000 message IDs per call.",
      schema: z.object({
        ids: z.array(z.string()).max(1000).describe("Array of message IDs."),
        addLabelIds: z.array(z.string()).optional().default([]),
        removeLabelIds: z.array(z.string()).optional().default([]),
      }),
      execute: async ({ ids, addLabelIds, removeLabelIds }, context) => {
        return await gmailRequest(
          "/messages/batchModify",
          {
            method: "POST",
            body: JSON.stringify({ ids, addLabelIds, removeLabelIds }),
          },
          context,
        );
      },
    },

    {
      name: "gmail_batch_delete_messages",
      description:
        "Permanently delete multiple messages at once. Irreversible. Max 1000 message IDs per call.",
      schema: z.object({
        ids: z
          .array(z.string())
          .max(1000)
          .describe("Array of message IDs to permanently delete."),
      }),
      execute: async ({ ids }, context) => {
        return await gmailRequest(
          "/messages/batchDelete",
          { method: "POST", body: JSON.stringify({ ids }) },
          context,
        );
      },
    },

    {
      name: "gmail_get_attachment",
      description:
        "Download an attachment from a message. Returns the raw base64url-encoded data and size.",
      schema: z.object({
        messageId: z
          .string()
          .describe("The ID of the message containing the attachment."),
        attachmentId: z
          .string()
          .describe(
            "The attachment ID (from the attachments array in gmail_get_message).",
          ),
      }),
      execute: async ({ messageId, attachmentId }, context) => {
        return await gmailRequest(
          `/messages/${messageId}/attachments/${attachmentId}`,
          { method: "GET" },
          context,
        );
      },
    },

    // ===========================================
    //  THREADS
    // ===========================================
    {
      name: "gmail_list_threads",
      description:
        "List email threads (conversations) in the mailbox. Supports the same search syntax as gmail_search_messages.",
      schema: z.object({
        query: z
          .string()
          .optional()
          .default("")
          .describe("Gmail search query to filter threads."),
        maxResults: z.number().min(1).max(500).optional().default(10),
        pageToken: z.string().optional(),
        labelIds: z.array(z.string()).optional(),
        includeSpamTrash: z.boolean().optional().default(false),
      }),
      execute: async (
        { query, maxResults, pageToken, labelIds, includeSpamTrash },
        context,
      ) => {
        const params = new URLSearchParams();
        if (query) params.set("q", query);
        if (maxResults) params.set("maxResults", String(maxResults));
        if (pageToken) params.set("pageToken", pageToken);
        if (includeSpamTrash) params.set("includeSpamTrash", "true");
        if (labelIds?.length)
          labelIds.forEach((id) => params.append("labelIds", id));

        return await gmailRequest(
          `/threads?${params}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_get_thread",
      description:
        "Fetch a full email thread with all its messages parsed into context-friendly format: headers, decoded bodies, and attachment metadata.",
      schema: z.object({
        threadId: z.string().describe("The thread ID to retrieve."),
      }),
      execute: async ({ threadId }, context) => {
        const res = await gmailRequest(
          `/threads/${threadId}?format=full`,
          { method: "GET" },
          context,
        );
        if (res.isError) return res;
        try {
          const raw = JSON.parse(res.content[0].text);
          return ok(formatThread(raw));
        } catch {
          return res;
        }
      },
    },

    {
      name: "gmail_modify_thread",
      description: "Add or remove labels from an entire thread at once.",
      schema: z.object({
        threadId: z.string(),
        addLabelIds: z.array(z.string()).optional().default([]),
        removeLabelIds: z.array(z.string()).optional().default([]),
      }),
      execute: async ({ threadId, addLabelIds, removeLabelIds }, context) => {
        return await gmailRequest(
          `/threads/${threadId}/modify`,
          {
            method: "POST",
            body: JSON.stringify({ addLabelIds, removeLabelIds }),
          },
          context,
        );
      },
    },

    {
      name: "gmail_trash_thread",
      description: "Move an entire thread to the trash.",
      schema: z.object({ threadId: z.string() }),
      execute: async ({ threadId }, context) => {
        return await gmailRequest(
          `/threads/${threadId}/trash`,
          { method: "POST" },
          context,
        );
      },
    },

    {
      name: "gmail_untrash_thread",
      description: "Remove an entire thread from the trash.",
      schema: z.object({ threadId: z.string() }),
      execute: async ({ threadId }, context) => {
        return await gmailRequest(
          `/threads/${threadId}/untrash`,
          { method: "POST" },
          context,
        );
      },
    },

    {
      name: "gmail_delete_thread",
      description: "Permanently delete an entire thread. Irreversible.",
      schema: z.object({ threadId: z.string() }),
      execute: async ({ threadId }, context) => {
        return await gmailRequest(
          `/threads/${threadId}`,
          { method: "DELETE" },
          context,
        );
      },
    },

    // ===========================================
    //  DRAFTS
    // ===========================================
    {
      name: "gmail_list_drafts",
      description: "List all drafts in the mailbox.",
      schema: z.object({
        maxResults: z.number().min(1).max(500).optional().default(10),
        pageToken: z.string().optional(),
        query: z.string().optional().describe("Search query to filter drafts."),
      }),
      execute: async ({ maxResults, pageToken, query }, context) => {
        const params = new URLSearchParams();
        if (maxResults) params.set("maxResults", String(maxResults));
        if (pageToken) params.set("pageToken", pageToken);
        if (query) params.set("q", query);

        return await gmailRequest(
          `/drafts?${params}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_get_draft",
      description: "Fetch a draft by its ID with full parsed content.",
      schema: z.object({
        draftId: z.string(),
      }),
      execute: async ({ draftId }, context) => {
        const res = await gmailRequest(
          `/drafts/${draftId}?format=full`,
          { method: "GET" },
          context,
        );
        if (res.isError) return res;
        try {
          const raw = JSON.parse(res.content[0].text);
          return ok({
            id: raw.id,
            message: formatMessage(raw.message),
          });
        } catch {
          return res;
        }
      },
    },

    {
      name: "gmail_create_draft",
      description:
        "Create an email draft without sending. Recommended for AI agents so the user can review before sending.",
      schema: z.object({
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        isHtml: z.boolean().optional().default(false),
        threadId: z
          .string()
          .optional()
          .describe(
            "Associate the draft with an existing thread (for reply drafts).",
          ),
        inReplyTo: z
          .string()
          .optional()
          .describe("Message-ID header of the email being replied to."),
      }),
      execute: async (
        { to, subject, body, cc, bcc, isHtml, threadId, inReplyTo },
        context,
      ) => {
        const raw = createRawEmail({
          to,
          cc,
          bcc,
          subject,
          body,
          contentType: isHtml ? "text/html" : "text/plain",
          inReplyTo,
        });
        const message: any = { raw };
        if (threadId) message.threadId = threadId;

        return await gmailRequest(
          "/drafts",
          { method: "POST", body: JSON.stringify({ message }) },
          context,
        );
      },
    },

    {
      name: "gmail_update_draft",
      description: "Replace the content of an existing draft.",
      schema: z.object({
        draftId: z.string().describe("The draft ID to update."),
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        isHtml: z.boolean().optional().default(false),
      }),
      execute: async (
        { draftId, to, subject, body, cc, bcc, isHtml },
        context,
      ) => {
        const raw = createRawEmail({
          to,
          cc,
          bcc,
          subject,
          body,
          contentType: isHtml ? "text/html" : "text/plain",
        });
        return await gmailRequest(
          `/drafts/${draftId}`,
          { method: "PUT", body: JSON.stringify({ message: { raw } }) },
          context,
        );
      },
    },

    {
      name: "gmail_send_draft",
      description: "Send an existing draft immediately.",
      schema: z.object({
        draftId: z.string().describe("The draft ID to send."),
      }),
      execute: async ({ draftId }, context) => {
        return await gmailRequest(
          "/drafts/send",
          { method: "POST", body: JSON.stringify({ id: draftId }) },
          context,
        );
      },
    },

    {
      name: "gmail_delete_draft",
      description: "Permanently delete a draft. Irreversible.",
      schema: z.object({
        draftId: z.string(),
      }),
      execute: async ({ draftId }, context) => {
        return await gmailRequest(
          `/drafts/${draftId}`,
          { method: "DELETE" },
          context,
        );
      },
    },

    // ===========================================
    //  LABELS
    // ===========================================
    {
      name: "gmail_list_labels",
      description:
        "Get all system and user-created labels with their IDs, types, and visibility settings.",
      schema: z.object({}),
      execute: async (_args, context) => {
        return await gmailRequest("/labels", { method: "GET" }, context);
      },
    },

    {
      name: "gmail_get_label",
      description:
        "Get details for a specific label including unread/total message counts.",
      schema: z.object({
        labelId: z
          .string()
          .describe(
            "The label ID (e.g., 'INBOX', 'UNREAD', or a custom label ID).",
          ),
      }),
      execute: async ({ labelId }, context) => {
        return await gmailRequest(
          `/labels/${labelId}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_create_label",
      description: "Create a new custom label.",
      schema: z.object({
        name: z
          .string()
          .describe("Display name. Use '/' for nesting, e.g. 'Work/Projects'."),
        labelListVisibility: z
          .enum(["labelShow", "labelShowIfUnread", "labelHide"])
          .optional()
          .default("labelShow"),
        messageListVisibility: z
          .enum(["show", "hide"])
          .optional()
          .default("show"),
        backgroundColor: z
          .string()
          .optional()
          .describe("Hex color for the label background, e.g. '#16a765'."),
        textColor: z
          .string()
          .optional()
          .describe("Hex color for the label text."),
      }),
      execute: async (
        {
          name,
          labelListVisibility,
          messageListVisibility,
          backgroundColor,
          textColor,
        },
        context,
      ) => {
        const payload: any = {
          name,
          labelListVisibility,
          messageListVisibility,
        };
        if (backgroundColor || textColor) {
          payload.color = {};
          if (backgroundColor) payload.color.backgroundColor = backgroundColor;
          if (textColor) payload.color.textColor = textColor;
        }
        return await gmailRequest(
          "/labels",
          { method: "POST", body: JSON.stringify(payload) },
          context,
        );
      },
    },

    {
      name: "gmail_update_label",
      description: "Update an existing label's name, visibility, or color.",
      schema: z.object({
        labelId: z.string(),
        name: z.string().optional(),
        labelListVisibility: z
          .enum(["labelShow", "labelShowIfUnread", "labelHide"])
          .optional(),
        messageListVisibility: z.enum(["show", "hide"]).optional(),
        backgroundColor: z.string().optional(),
        textColor: z.string().optional(),
      }),
      execute: async (
        {
          labelId,
          name,
          labelListVisibility,
          messageListVisibility,
          backgroundColor,
          textColor,
        },
        context,
      ) => {
        const payload: any = {};
        if (name !== undefined) payload.name = name;
        if (labelListVisibility !== undefined)
          payload.labelListVisibility = labelListVisibility;
        if (messageListVisibility !== undefined)
          payload.messageListVisibility = messageListVisibility;
        if (backgroundColor || textColor) {
          payload.color = {};
          if (backgroundColor) payload.color.backgroundColor = backgroundColor;
          if (textColor) payload.color.textColor = textColor;
        }
        return await gmailRequest(
          `/labels/${labelId}`,
          { method: "PATCH", body: JSON.stringify(payload) },
          context,
        );
      },
    },

    {
      name: "gmail_delete_label",
      description:
        "Permanently delete a custom label. System labels cannot be deleted.",
      schema: z.object({
        labelId: z.string(),
      }),
      execute: async ({ labelId }, context) => {
        return await gmailRequest(
          `/labels/${labelId}`,
          { method: "DELETE" },
          context,
        );
      },
    },

    // ===========================================
    //  HISTORY
    // ===========================================
    {
      name: "gmail_list_history",
      description:
        "List mailbox change history since a given historyId. Use this for incremental sync — get the startHistoryId from gmail_get_profile or a previous sync.",
      schema: z.object({
        startHistoryId: z
          .string()
          .describe(
            "Only return history records after this historyId. Obtain from profile or a previous sync.",
          ),
        maxResults: z.number().min(1).max(500).optional().default(100),
        pageToken: z.string().optional(),
        labelId: z
          .string()
          .optional()
          .describe("Only return history for this label."),
        historyTypes: z
          .array(
            z.enum([
              "messageAdded",
              "messageDeleted",
              "labelAdded",
              "labelRemoved",
            ]),
          )
          .optional()
          .describe("Filter to specific event types."),
      }),
      execute: async (
        { startHistoryId, maxResults, pageToken, labelId, historyTypes },
        context,
      ) => {
        const params = new URLSearchParams();
        params.set("startHistoryId", startHistoryId);
        if (maxResults) params.set("maxResults", String(maxResults));
        if (pageToken) params.set("pageToken", pageToken);
        if (labelId) params.set("labelId", labelId);
        if (historyTypes?.length)
          historyTypes.forEach((t) => params.append("historyTypes", t));

        return await gmailRequest(
          `/history?${params}`,
          { method: "GET" },
          context,
        );
      },
    },

    // ===========================================
    //  SETTINGS — FILTERS
    // ===========================================
    {
      name: "gmail_list_filters",
      description:
        "List all email filters (rules) configured in the user's Gmail.",
      schema: z.object({}),
      execute: async (_args, context) => {
        return await gmailRequest(
          "/settings/filters",
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_get_filter",
      description: "Get a specific email filter by its ID.",
      schema: z.object({
        filterId: z.string(),
      }),
      execute: async ({ filterId }, context) => {
        return await gmailRequest(
          `/settings/filters/${filterId}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_create_filter",
      description:
        "Create an email filter (auto-rule). Define criteria to match incoming messages and actions to apply (add/remove labels, forward, etc.).",
      schema: z.object({
        criteria: z
          .object({
            from: z
              .string()
              .optional()
              .describe("Match sender address or name."),
            to: z.string().optional().describe("Match recipient (to/cc/bcc)."),
            subject: z
              .string()
              .optional()
              .describe("Match subject phrase (case-insensitive)."),
            query: z.string().optional().describe("Gmail search query."),
            negatedQuery: z
              .string()
              .optional()
              .describe("Exclude messages matching this query."),
            hasAttachment: z.boolean().optional(),
            excludeChats: z.boolean().optional(),
            size: z
              .number()
              .optional()
              .describe("Message size threshold in bytes."),
            sizeComparison: z
              .enum(["unspecified", "smaller", "larger"])
              .optional(),
          })
          .describe("Matching criteria for the filter."),
        action: z
          .object({
            addLabelIds: z
              .array(z.string())
              .optional()
              .describe("Labels to add to matching messages."),
            removeLabelIds: z
              .array(z.string())
              .optional()
              .describe("Labels to remove (e.g., 'INBOX' to auto-archive)."),
            forward: z
              .string()
              .optional()
              .describe("Email address to forward matching messages to."),
          })
          .describe("Action to perform on matching messages."),
      }),
      execute: async ({ criteria, action }, context) => {
        return await gmailRequest(
          "/settings/filters",
          { method: "POST", body: JSON.stringify({ criteria, action }) },
          context,
        );
      },
    },

    {
      name: "gmail_delete_filter",
      description: "Permanently delete an email filter by its ID.",
      schema: z.object({
        filterId: z.string(),
      }),
      execute: async ({ filterId }, context) => {
        return await gmailRequest(
          `/settings/filters/${filterId}`,
          { method: "DELETE" },
          context,
        );
      },
    },

    // ===========================================
    //  SETTINGS — VACATION / AUTO-REPLY
    // ===========================================
    {
      name: "gmail_get_vacation_settings",
      description: "Get the current vacation/auto-reply configuration.",
      schema: z.object({}),
      execute: async (_args, context) => {
        return await gmailRequest(
          "/settings/vacation",
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_update_vacation_settings",
      description:
        "Enable or disable vacation auto-reply and configure the response message, date range, and audience restrictions.",
      schema: z.object({
        enableAutoReply: z
          .boolean()
          .describe("Whether to enable the auto-reply."),
        responseSubject: z
          .string()
          .optional()
          .describe("Subject line for the auto-reply."),
        responseBodyPlainText: z
          .string()
          .optional()
          .describe("Plain text body of the auto-reply."),
        responseBodyHtml: z
          .string()
          .optional()
          .describe(
            "HTML body of the auto-reply (takes precedence over plain text).",
          ),
        restrictToContacts: z
          .boolean()
          .optional()
          .default(false)
          .describe("Only send auto-reply to people in contacts."),
        restrictToDomain: z
          .boolean()
          .optional()
          .default(false)
          .describe("Only send auto-reply to people in the same domain."),
        startTime: z
          .string()
          .optional()
          .describe(
            "Start time as epoch milliseconds (string). If omitted, auto-reply starts immediately.",
          ),
        endTime: z
          .string()
          .optional()
          .describe(
            "End time as epoch milliseconds (string). If omitted, auto-reply continues indefinitely.",
          ),
      }),
      execute: async (args, context) => {
        return await gmailRequest(
          "/settings/vacation",
          { method: "PUT", body: JSON.stringify(args) },
          context,
        );
      },
    },

    // ===========================================
    //  SETTINGS — FORWARDING ADDRESSES
    // ===========================================
    {
      name: "gmail_list_forwarding_addresses",
      description: "List all forwarding addresses configured for the account.",
      schema: z.object({}),
      execute: async (_args, context) => {
        return await gmailRequest(
          "/settings/forwardingAddresses",
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_create_forwarding_address",
      description:
        "Add a new forwarding address. Gmail will send a verification email to the address before it can be used.",
      schema: z.object({
        forwardingEmail: z
          .string()
          .describe("The email address to add as a forwarding target."),
      }),
      execute: async ({ forwardingEmail }, context) => {
        return await gmailRequest(
          "/settings/forwardingAddresses",
          { method: "POST", body: JSON.stringify({ forwardingEmail }) },
          context,
        );
      },
    },

    // ===========================================
    //  SETTINGS — SEND-AS (ALIASES)
    // ===========================================
    {
      name: "gmail_list_send_as",
      description:
        "List all send-as aliases (email identities) the user can send from.",
      schema: z.object({}),
      execute: async (_args, context) => {
        return await gmailRequest(
          "/settings/sendAs",
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "gmail_get_send_as",
      description: "Get details for a specific send-as alias.",
      schema: z.object({
        sendAsEmail: z.string().describe("The send-as email address."),
      }),
      execute: async ({ sendAsEmail }, context) => {
        return await gmailRequest(
          `/settings/sendAs/${encodeURIComponent(sendAsEmail)}`,
          { method: "GET" },
          context,
        );
      },
    },
  ],
};
