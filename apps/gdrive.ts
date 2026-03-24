import { z } from "zod";
import type { NathraxApp } from "../core/types";
import { db } from "../db";
import { connections } from "../db/schema";
import { and, eq } from "drizzle-orm";

// ─── Environment Variables ────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const BASE_URL = process.env.BASE_URL!;

// ─── Token Refresh ────────────────────────────────────────────────────────────

async function refreshGoogleToken(
  connectionId: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to refresh Google token: ${err}`);
  }

  const data = await res.json();
  const newAccessToken: string = data.access_token;
  const expiresIn: number = data.expires_in ?? 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await db
    .update(connections)
    .set({
      accessToken: newAccessToken,
      expiresAt,
    })
    .where(eq(connections.id, connectionId));

  return newAccessToken;
}

// ─── Auth URL Builder ─────────────────────────────────────────────────────────

function buildAuthUrl(): string {
  const redirectUri = `${BASE_URL}/oauth/google/callback`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.metadata",
      "openid",
      "email",
      "profile",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ─── Drive API Request Wrapper ────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
  _raw?: unknown;
};

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

async function driveRequest(
  context: { userId?: string },
  method: string,
  path: string,
  options?: {
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    rawResponse?: boolean;
    baseUrl?: string;
  },
): Promise<ToolResult> {
  const userId = context?.userId;

  // Look up the Google connection for this user
  const whereClause = userId
    ? and(eq(connections.appId, "google"), eq(connections.userId, userId))
    : eq(connections.appId, "google");

  const [connection] = await db
    .select()
    .from(connections)
    .where(whereClause)
    .limit(1);

  if (!connection) {
    const authUrl = buildAuthUrl();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "not_connected",
              message:
                "Google Drive is not connected. Please authorize via the link below.",
              authUrl,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const baseUrl = options?.baseUrl ?? DRIVE_BASE;
  const rawResponse = options?.rawResponse ?? false;

  const buildUrl = () => {
    const url = new URL(`${baseUrl}${path}`);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  };

  const makeRequest = async (accessToken: string) => {
    const fetchOpts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    };
    if (
      options?.body !== undefined &&
      method !== "GET" &&
      method !== "DELETE"
    ) {
      fetchOpts.body = JSON.stringify(options.body);
    }
    return fetch(buildUrl(), fetchOpts);
  };

  let res = await makeRequest(connection.accessToken);

  // Auto-refresh on 401
  if (res.status === 401 && connection.refreshToken) {
    let newToken: string;
    try {
      newToken = await refreshGoogleToken(
        connection.id,
        connection.refreshToken,
      );
    } catch (refreshErr: unknown) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "token_refresh_failed",
                message: String(refreshErr),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    res = await makeRequest(newToken);
  }

  // No-content responses (e.g., DELETE 204)
  if (res.status === 204) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ success: true }, null, 2) },
      ],
    };
  }

  // Binary / raw response (for export and download)
  if (rawResponse) {
    if (!res.ok) {
      let errData: unknown;
      try {
        errData = await res.json();
      } catch {
        errData = await res.text();
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: `Drive API error ${res.status}`, details: errData },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              base64Content: base64,
              contentType: res.headers.get("Content-Type"),
              size: buffer.byteLength,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "parse_error", status: res.status },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  if (!res.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: data }, null, 2),
        },
      ],
      isError: true,
      _raw: data,
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    _raw: data,
  };
}

// ─── Multipart Upload Helper ──────────────────────────────────────────────────

async function driveMultipartUpload(
  context: { userId?: string },
  metadata: Record<string, unknown>,
  contentBase64: string,
  mimeType: string,
): Promise<ToolResult> {
  const userId = context?.userId;

  const whereClause = userId
    ? and(eq(connections.appId, "google"), eq(connections.userId, userId))
    : eq(connections.appId, "google");

  const [connection] = await db
    .select()
    .from(connections)
    .where(whereClause)
    .limit(1);

  if (!connection) {
    const authUrl = buildAuthUrl();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "not_connected",
              message:
                "Google Drive is not connected. Please authorize via the link below.",
              authUrl,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const doUpload = async (token: string): Promise<Response> => {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const metaPart = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
    ].join("\r\n");

    const filePart = [
      `\r\n--${boundary}`,
      `Content-Type: ${mimeType}`,
      "Content-Transfer-Encoding: base64",
      "",
      contentBase64,
    ].join("\r\n");

    const closing = `\r\n--${boundary}--`;
    const bodyStr = metaPart + filePart + closing;

    return fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: bodyStr,
      },
    );
  };

  let res = await doUpload(connection.accessToken);

  if (res.status === 401 && connection.refreshToken) {
    let newToken: string;
    try {
      newToken = await refreshGoogleToken(
        connection.id,
        connection.refreshToken,
      );
    } catch (refreshErr: unknown) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "token_refresh_failed",
                message: String(refreshErr),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    res = await doUpload(newToken);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "parse_error", status: res.status },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  if (!res.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: `Upload failed ${res.status}`, details: data },
            null,
            2,
          ),
        },
      ],
      isError: true,
      _raw: data,
    };
  }

  return ok(data);
}

// ─── Helper: ok() ─────────────────────────────────────────────────────────────

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatBytes(bytes: string | number | undefined): string {
  if (bytes === undefined || bytes === null) return "unknown";
  const n = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
  if (isNaN(n)) return String(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUser(
  user: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!user) return undefined;
  return {
    displayName: user.displayName,
    emailAddress: user.emailAddress,
    photoLink: user.photoLink,
    me: user.me,
  };
}

function formatFile(file: Record<string, unknown>): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: formatBytes(file.size as string | number | undefined),
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
    webViewLink: file.webViewLink,
    webContentLink: file.webContentLink,
    parents: file.parents,
    shared: file.shared,
    trashed: file.trashed,
    description: file.description,
    ownedByMe: file.ownedByMe,
    starred: file.starred,
    sharingUser: formatUser(
      file.sharingUser as Record<string, unknown> | undefined,
    ),
    lastModifyingUser: formatUser(
      file.lastModifyingUser as Record<string, unknown> | undefined,
    ),
  };
}

function formatPermission(
  perm: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: perm.id,
    type: perm.type,
    role: perm.role,
    emailAddress: perm.emailAddress,
    displayName: perm.displayName,
    domain: perm.domain,
    deleted: perm.deleted,
    pendingOwner: perm.pendingOwner,
    allowFileDiscovery: perm.allowFileDiscovery,
    expirationTime: perm.expirationTime,
  };
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const driveTools = [
  // ── About ──────────────────────────────────────────────────────────────────

  {
    name: "drive_get_about",
    description:
      "Get information about the authenticated user's Google Drive, including user details, storage quota, and max upload size.",
    schema: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: { userId?: string },
    ) => {
      const result = await driveRequest(context, "GET", "/about", {
        params: { fields: "user,storageQuota,maxUploadSize" },
      });
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      const storage = data.storageQuota as Record<string, string> | undefined;
      const user = data.user as Record<string, unknown> | undefined;
      const formatted = {
        user: {
          displayName: user?.displayName,
          emailAddress: user?.emailAddress,
          permissionId: user?.permissionId,
          photoLink: user?.photoLink,
        },
        storageQuota: storage
          ? {
              limit: storage.limit ? formatBytes(storage.limit) : "Unlimited",
              usage: formatBytes(storage.usage),
              usageInDrive: formatBytes(storage.usageInDrive),
              usageInDriveTrash: formatBytes(storage.usageInDriveTrash),
            }
          : undefined,
        maxUploadSize: formatBytes(data.maxUploadSize as string | undefined),
      };
      return ok(formatted);
    },
  },

  // ── Files ──────────────────────────────────────────────────────────────────

  {
    name: "drive_list_files",
    description:
      'List or search files in Google Drive. Use the `q` parameter for Drive search queries (e.g. "name contains \'report\'", "mimeType=\'application/vnd.google-apps.spreadsheet\'", "\'me\' in owners", "trashed=false"). Supports pagination and ordering.',
    schema: z.object({
      q: z
        .string()
        .optional()
        .describe(
          "Drive search query, e.g. \"name contains 'report'\" or \"mimeType='application/vnd.google-apps.folder'\"",
        ),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Number of files to return (default 10, max 1000)"),
      pageToken: z
        .string()
        .optional()
        .describe("Page token for pagination from a previous list response"),
      orderBy: z
        .string()
        .optional()
        .describe(
          'Sort order, e.g. "modifiedTime desc", "name", "createdTime desc"',
        ),
      fields: z
        .string()
        .optional()
        .describe(
          "Fields to return. Default: files(id,name,mimeType,size,modifiedTime,webViewLink,parents,shared,trashed),nextPageToken",
        ),
      spaces: z
        .string()
        .optional()
        .describe(
          "Comma-separated list of spaces to query: drive, appDataFolder",
        ),
      corpora: z
        .string()
        .optional()
        .describe("Where to search: user, drive, allDrives"),
      includeItemsFromAllDrives: z
        .boolean()
        .optional()
        .describe("Whether to include items from all drives"),
      supportsAllDrives: z
        .boolean()
        .optional()
        .describe("Whether the app supports shared drives"),
      driveId: z
        .string()
        .optional()
        .describe("ID of the shared drive to search (requires corpora=drive)"),
    }),
    execute: async (
      args: {
        q?: string;
        pageSize?: number;
        pageToken?: string;
        orderBy?: string;
        fields?: string;
        spaces?: string;
        corpora?: string;
        includeItemsFromAllDrives?: boolean;
        supportsAllDrives?: boolean;
        driveId?: string;
      },
      context: { userId?: string },
    ) => {
      const {
        q,
        pageSize,
        pageToken,
        orderBy,
        fields = "files(id,name,mimeType,size,modifiedTime,webViewLink,parents,shared,trashed),nextPageToken",
        spaces,
        corpora,
        includeItemsFromAllDrives,
        supportsAllDrives,
        driveId,
      } = args;

      return driveRequest(context, "GET", "/files", {
        params: {
          q,
          pageSize,
          pageToken,
          orderBy,
          fields,
          spaces,
          corpora,
          includeItemsFromAllDrives,
          supportsAllDrives,
          driveId,
        },
      });
    },
  },

  {
    name: "drive_get_file",
    description:
      "Get metadata for a specific file or folder by its ID. Returns all file fields by default.",
    schema: z.object({
      fileId: z.string().describe("The ID of the file to retrieve"),
      fields: z
        .string()
        .optional()
        .describe("Fields to return. Defaults to all fields (*)"),
    }),
    execute: async (
      args: { fileId: string; fields?: string },
      context: { userId?: string },
    ) => {
      const { fileId, fields = "*" } = args;
      const result = await driveRequest(context, "GET", `/files/${fileId}`, {
        params: { fields },
      });
      if (result.isError) return result;
      const formatted = formatFile(result._raw as Record<string, unknown>);
      return ok(formatted);
    },
  },

  {
    name: "drive_create_file",
    description:
      'Create a new file or folder in Google Drive (metadata only, no content). For uploading file content use drive_upload_file. To create a folder, set mimeType to "application/vnd.google-apps.folder".',
    schema: z.object({
      name: z.string().describe("Name for the new file or folder"),
      mimeType: z
        .string()
        .optional()
        .describe(
          'MIME type. Use "application/vnd.google-apps.folder" for a folder',
        ),
      parents: z
        .array(z.string())
        .optional()
        .describe(
          "Array of parent folder IDs. Defaults to root if not specified",
        ),
      description: z
        .string()
        .optional()
        .describe("Optional description for the file"),
    }),
    execute: async (
      args: {
        name: string;
        mimeType?: string;
        parents?: string[];
        description?: string;
      },
      context: { userId?: string },
    ) => {
      const { name, mimeType, parents, description } = args;

      const body: Record<string, unknown> = { name };
      if (mimeType) body.mimeType = mimeType;
      if (parents) body.parents = parents;
      if (description) body.description = description;

      return driveRequest(context, "POST", "/files", { body });
    },
  },

  {
    name: "drive_upload_file",
    description:
      "Upload a file with content to Google Drive using multipart upload. The file content must be base64-encoded. This creates a new file; for updating an existing file's metadata only, use drive_update_file.",
    schema: z.object({
      name: z.string().describe("File name"),
      mimeType: z
        .string()
        .describe(
          'MIME type of the file, e.g. "text/plain", "image/png", "application/pdf"',
        ),
      content: z.string().describe("Base64-encoded file content"),
      parents: z
        .array(z.string())
        .optional()
        .describe("Array of parent folder IDs. Defaults to root"),
      description: z.string().optional().describe("Optional description"),
    }),
    execute: async (
      args: {
        name: string;
        mimeType: string;
        content: string;
        parents?: string[];
        description?: string;
      },
      context: { userId?: string },
    ) => {
      const { name, mimeType, content, parents, description } = args;

      const metadata: Record<string, unknown> = { name, mimeType };
      if (parents) metadata.parents = parents;
      if (description) metadata.description = description;

      return driveMultipartUpload(context, metadata, content, mimeType);
    },
  },

  {
    name: "drive_update_file",
    description:
      "Update a file's metadata in Google Drive. Can rename, change description, move between folders (via addParents/removeParents), or change star status.",
    schema: z.object({
      fileId: z.string().describe("ID of the file to update"),
      name: z.string().optional().describe("New file name"),
      description: z.string().optional().describe("New description"),
      mimeType: z.string().optional().describe("New MIME type"),
      addParents: z
        .string()
        .optional()
        .describe("Comma-separated list of parent IDs to add"),
      removeParents: z
        .string()
        .optional()
        .describe("Comma-separated list of parent IDs to remove"),
      trashed: z
        .boolean()
        .optional()
        .describe("Set to true to trash, false to untrash"),
      starred: z.boolean().optional().describe("Star or unstar the file"),
    }),
    execute: async (
      args: {
        fileId: string;
        name?: string;
        description?: string;
        mimeType?: string;
        addParents?: string;
        removeParents?: string;
        trashed?: boolean;
        starred?: boolean;
      },
      context: { userId?: string },
    ) => {
      const {
        fileId,
        name,
        description,
        mimeType,
        addParents,
        removeParents,
        trashed,
        starred,
      } = args;

      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (mimeType !== undefined) body.mimeType = mimeType;
      if (trashed !== undefined) body.trashed = trashed;
      if (starred !== undefined) body.starred = starred;

      return driveRequest(context, "PATCH", `/files/${fileId}`, {
        params: { addParents, removeParents },
        body,
      });
    },
  },

  {
    name: "drive_copy_file",
    description:
      "Create a copy of a file in Google Drive. Cannot copy folders.",
    schema: z.object({
      fileId: z.string().describe("ID of the file to copy"),
      name: z
        .string()
        .optional()
        .describe('Name for the copy. Defaults to "Copy of <original name>"'),
      parents: z
        .array(z.string())
        .optional()
        .describe(
          "Destination parent folder IDs. Defaults to same folder as original",
        ),
    }),
    execute: async (
      args: { fileId: string; name?: string; parents?: string[] },
      context: { userId?: string },
    ) => {
      const { fileId, name, parents } = args;

      const body: Record<string, unknown> = {};
      if (name) body.name = name;
      if (parents) body.parents = parents;

      return driveRequest(context, "POST", `/files/${fileId}/copy`, { body });
    },
  },

  {
    name: "drive_delete_file",
    description:
      "Permanently delete a file from Google Drive. WARNING: This action is IRREVERSIBLE and bypasses the trash. Consider using drive_trash_file to move to trash instead.",
    schema: z.object({
      fileId: z.string().describe("ID of the file to permanently delete"),
      supportsAllDrives: z
        .boolean()
        .optional()
        .describe("Whether the app supports shared drives"),
    }),
    execute: async (
      args: { fileId: string; supportsAllDrives?: boolean },
      context: { userId?: string },
    ) => {
      const { fileId, supportsAllDrives } = args;

      return driveRequest(context, "DELETE", `/files/${fileId}`, {
        params: { supportsAllDrives },
      });
    },
  },

  {
    name: "drive_trash_file",
    description:
      "Move a file to the Google Drive trash. The file can be restored with drive_untrash_file.",
    schema: z.object({
      fileId: z.string().describe("ID of the file to move to trash"),
    }),
    execute: async (args: { fileId: string }, context: { userId?: string }) => {
      const { fileId } = args;

      return driveRequest(context, "PATCH", `/files/${fileId}`, {
        body: { trashed: true },
      });
    },
  },

  {
    name: "drive_untrash_file",
    description: "Restore a file from the Google Drive trash.",
    schema: z.object({
      fileId: z.string().describe("ID of the file to restore from trash"),
    }),
    execute: async (args: { fileId: string }, context: { userId?: string }) => {
      const { fileId } = args;

      return driveRequest(context, "PATCH", `/files/${fileId}`, {
        body: { trashed: false },
      });
    },
  },

  {
    name: "drive_empty_trash",
    description:
      "Permanently delete ALL files in the authenticated user's Google Drive trash. WARNING: This is IRREVERSIBLE. All trashed files will be permanently lost.",
    schema: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: { userId?: string },
    ) => {
      return driveRequest(context, "DELETE", "/files/trash");
    },
  },

  {
    name: "drive_export_file",
    description:
      'Export a Google Workspace document (Docs, Sheets, Slides, etc.) to a different format. Returns base64-encoded file content. Common export MIME types: "application/pdf", "text/plain", "text/csv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document" (Word), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" (Excel).',
    schema: z.object({
      fileId: z.string().describe("ID of the Google Workspace file to export"),
      mimeType: z
        .string()
        .describe(
          'Target export MIME type, e.g. "application/pdf", "text/plain", "text/csv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"',
        ),
    }),
    execute: async (
      args: { fileId: string; mimeType: string },
      context: { userId?: string },
    ) => {
      const { fileId, mimeType } = args;

      return driveRequest(context, "GET", `/files/${fileId}/export`, {
        params: { mimeType },
        rawResponse: true,
      });
    },
  },

  {
    name: "drive_download_file",
    description:
      "Download a file's binary content from Google Drive. Returns base64-encoded content and the content type. Use drive_export_file for Google Workspace documents (Docs, Sheets, Slides).",
    schema: z.object({
      fileId: z.string().describe("ID of the file to download"),
      acknowledgeAbuse: z
        .boolean()
        .optional()
        .describe(
          "Set to true to acknowledge that the file may be harmful and proceed with download",
        ),
    }),
    execute: async (
      args: { fileId: string; acknowledgeAbuse?: boolean },
      context: { userId?: string },
    ) => {
      const { fileId, acknowledgeAbuse } = args;

      return driveRequest(context, "GET", `/files/${fileId}`, {
        params: { alt: "media", acknowledgeAbuse },
        rawResponse: true,
      });
    },
  },

  {
    name: "drive_generate_file_ids",
    description:
      "Generate a set of file IDs that can be used when creating files, allowing clients to set the ID in advance.",
    schema: z.object({
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Number of IDs to generate (default 1, max 10)"),
      space: z
        .string()
        .optional()
        .describe(
          "The space in which the IDs can be used. Supported values: drive, appDataFolder",
        ),
    }),
    execute: async (
      args: { count?: number; space?: string },
      context: { userId?: string },
    ) => {
      const { count = 1, space = "drive" } = args;

      return driveRequest(context, "GET", "/files/generateIds", {
        params: { count, space },
      });
    },
  },

  // ── Permissions (Sharing) ──────────────────────────────────────────────────

  {
    name: "drive_list_permissions",
    description:
      "List all sharing permissions for a file or folder in Google Drive.",
    schema: z.object({
      fileId: z.string().describe("ID of the file or folder"),
      fields: z
        .string()
        .optional()
        .describe("Fields to return. Default returns all permission fields"),
      pageSize: z
        .number()
        .int()
        .optional()
        .describe("Maximum number of permissions to return"),
      pageToken: z.string().optional().describe("Page token for pagination"),
      useDomainAdminAccess: z
        .boolean()
        .optional()
        .describe("Issue the request as a domain administrator"),
      supportsAllDrives: z
        .boolean()
        .optional()
        .describe("Whether the app supports shared drives"),
    }),
    execute: async (
      args: {
        fileId: string;
        fields?: string;
        pageSize?: number;
        pageToken?: string;
        useDomainAdminAccess?: boolean;
        supportsAllDrives?: boolean;
      },
      context: { userId?: string },
    ) => {
      const {
        fileId,
        fields,
        pageSize,
        pageToken,
        useDomainAdminAccess,
        supportsAllDrives,
      } = args;

      const result = await driveRequest(
        context,
        "GET",
        `/files/${fileId}/permissions`,
        {
          params: {
            fields,
            pageSize,
            pageToken,
            useDomainAdminAccess,
            supportsAllDrives,
          },
        },
      );
      if (result.isError) return result;
      const data = result._raw as {
        permissions?: Record<string, unknown>[];
        nextPageToken?: string;
      };
      if (data.permissions) {
        return ok({
          permissions: data.permissions.map(formatPermission),
          nextPageToken: data.nextPageToken,
        });
      }
      return result;
    },
  },

  {
    name: "drive_get_permission",
    description: "Get a specific sharing permission on a file or folder.",
    schema: z.object({
      fileId: z.string().describe("ID of the file or folder"),
      permissionId: z.string().describe("ID of the permission to retrieve"),
      fields: z.string().optional().describe("Fields to return"),
      useDomainAdminAccess: z
        .boolean()
        .optional()
        .describe("Issue the request as a domain administrator"),
      supportsAllDrives: z
        .boolean()
        .optional()
        .describe("Whether the app supports shared drives"),
    }),
    execute: async (
      args: {
        fileId: string;
        permissionId: string;
        fields?: string;
        useDomainAdminAccess?: boolean;
        supportsAllDrives?: boolean;
      },
      context: { userId?: string },
    ) => {
      const {
        fileId,
        permissionId,
        fields,
        useDomainAdminAccess,
        supportsAllDrives,
      } = args;

      const result = await driveRequest(
        context,
        "GET",
        `/files/${fileId}/permissions/${permissionId}`,
        { params: { fields, useDomainAdminAccess, supportsAllDrives } },
      );
      if (result.isError) return result;
      return ok(formatPermission(result._raw as Record<string, unknown>));
    },
  },

  {
    name: "drive_create_permission",
    description:
      "Share a file or folder by creating a new permission. Can share with a specific user (type=user, emailAddress required), group (type=group), domain (type=domain, domain required), or anyone (type=anyone).",
    schema: z.object({
      fileId: z.string().describe("ID of the file or folder to share"),
      role: z
        .enum([
          "owner",
          "organizer",
          "fileOrganizer",
          "writer",
          "commenter",
          "reader",
        ])
        .describe(
          "Permission role: owner, organizer, fileOrganizer, writer, commenter, reader",
        ),
      type: z
        .enum(["user", "group", "domain", "anyone"])
        .describe("Permission type: user, group, domain, anyone"),
      emailAddress: z
        .string()
        .optional()
        .describe("Email address (required for type=user or type=group)"),
      domain: z
        .string()
        .optional()
        .describe("Domain (required for type=domain)"),
      sendNotificationEmail: z
        .boolean()
        .optional()
        .describe(
          "Whether to send a notification email (default true for user/group)",
        ),
      emailMessage: z
        .string()
        .optional()
        .describe("Custom message to include in the notification email"),
      transferOwnership: z
        .boolean()
        .optional()
        .describe(
          "Set to true when transferring ownership (role must be owner)",
        ),
      allowFileDiscovery: z
        .boolean()
        .optional()
        .describe(
          "Whether the file can be discovered through search (for domain/anyone types)",
        ),
      supportsAllDrives: z
        .boolean()
        .optional()
        .describe("Whether the app supports shared drives"),
      useDomainAdminAccess: z
        .boolean()
        .optional()
        .describe("Issue the request as a domain administrator"),
    }),
    execute: async (
      args: {
        fileId: string;
        role: string;
        type: string;
        emailAddress?: string;
        domain?: string;
        sendNotificationEmail?: boolean;
        emailMessage?: string;
        transferOwnership?: boolean;
        allowFileDiscovery?: boolean;
        supportsAllDrives?: boolean;
        useDomainAdminAccess?: boolean;
      },
      context: { userId?: string },
    ) => {
      const {
        fileId,
        role,
        type,
        emailAddress,
        domain,
        sendNotificationEmail,
        emailMessage,
        transferOwnership,
        allowFileDiscovery,
        supportsAllDrives,
        useDomainAdminAccess,
      } = args;

      const body: Record<string, unknown> = { role, type };
      if (emailAddress) body.emailAddress = emailAddress;
      if (domain) body.domain = domain;
      if (allowFileDiscovery !== undefined)
        body.allowFileDiscovery = allowFileDiscovery;

      return driveRequest(context, "POST", `/files/${fileId}/permissions`, {
        params: {
          sendNotificationEmail,
          emailMessage,
          transferOwnership,
          supportsAllDrives,
          useDomainAdminAccess,
        },
        body,
      });
    },
  },

  {
    name: "drive_update_permission",
    description:
      "Update an existing permission on a file or folder (e.g., change role from reader to writer).",
    schema: z.object({
      fileId: z.string().describe("ID of the file or folder"),
      permissionId: z.string().describe("ID of the permission to update"),
      role: z
        .enum([
          "owner",
          "organizer",
          "fileOrganizer",
          "writer",
          "commenter",
          "reader",
        ])
        .describe("New role"),
      transferOwnership: z
        .boolean()
        .optional()
        .describe("Set to true when changing role to owner"),
      removeExpiration: z
        .boolean()
        .optional()
        .describe("Set to true to remove expiration date"),
      supportsAllDrives: z
        .boolean()
        .optional()
        .describe("Whether the app supports shared drives"),
      useDomainAdminAccess: z
        .boolean()
        .optional()
        .describe("Issue the request as a domain administrator"),
    }),
    execute: async (
      args: {
        fileId: string;
        permissionId: string;
        role: string;
        transferOwnership?: boolean;
        removeExpiration?: boolean;
        supportsAllDrives?: boolean;
        useDomainAdminAccess?: boolean;
      },
      context: { userId?: string },
    ) => {
      const {
        fileId,
        permissionId,
        role,
        transferOwnership,
        removeExpiration,
        supportsAllDrives,
        useDomainAdminAccess,
      } = args;

      return driveRequest(
        context,
        "PATCH",
        `/files/${fileId}/permissions/${permissionId}`,
        {
          params: {
            transferOwnership,
            removeExpiration,
            supportsAllDrives,
            useDomainAdminAccess,
          },
          body: { role },
        },
      );
    },
  },

  {
    name: "drive_delete_permission",
    description: "Remove a sharing permission from a file or folder.",
    schema: z.object({
      fileId: z.string().describe("ID of the file or folder"),
      permissionId: z.string().describe("ID of the permission to remove"),
      supportsAllDrives: z
        .boolean()
        .optional()
        .describe("Whether the app supports shared drives"),
      useDomainAdminAccess: z
        .boolean()
        .optional()
        .describe("Issue the request as a domain administrator"),
    }),
    execute: async (
      args: {
        fileId: string;
        permissionId: string;
        supportsAllDrives?: boolean;
        useDomainAdminAccess?: boolean;
      },
      context: { userId?: string },
    ) => {
      const { fileId, permissionId, supportsAllDrives, useDomainAdminAccess } =
        args;

      return driveRequest(
        context,
        "DELETE",
        `/files/${fileId}/permissions/${permissionId}`,
        { params: { supportsAllDrives, useDomainAdminAccess } },
      );
    },
  },

  // ── Comments ────────────────────────────────────────────────────────────────

  {
    name: "drive_list_comments",
    description: "List all comments on a file in Google Drive.",
    schema: z.object({
      fileId: z.string().describe("ID of the file"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of comments to return (max 100)"),
      pageToken: z.string().optional().describe("Page token for pagination"),
      fields: z.string().optional().describe("Fields to return"),
      includeDeleted: z
        .boolean()
        .optional()
        .describe("Whether to include deleted comments"),
      startModifiedTime: z
        .string()
        .optional()
        .describe(
          "Only return comments modified after this time (RFC 3339 format)",
        ),
    }),
    execute: async (
      args: {
        fileId: string;
        pageSize?: number;
        pageToken?: string;
        fields?: string;
        includeDeleted?: boolean;
        startModifiedTime?: string;
      },
      context: { userId?: string },
    ) => {
      const {
        fileId,
        pageSize,
        pageToken,
        fields,
        includeDeleted,
        startModifiedTime,
      } = args;

      return driveRequest(context, "GET", `/files/${fileId}/comments`, {
        params: {
          pageSize,
          pageToken,
          fields,
          includeDeleted,
          startModifiedTime,
        },
      });
    },
  },

  {
    name: "drive_create_comment",
    description: "Add a new comment to a file in Google Drive.",
    schema: z.object({
      fileId: z.string().describe("ID of the file to comment on"),
      content: z.string().describe("The comment text"),
    }),
    execute: async (
      args: { fileId: string; content: string },
      context: { userId?: string },
    ) => {
      const { fileId, content } = args;

      return driveRequest(context, "POST", `/files/${fileId}/comments`, {
        params: { fields: "id,content,createdTime,author,resolved,replies" },
        body: { content },
      });
    },
  },

  {
    name: "drive_delete_comment",
    description: "Delete a comment from a file in Google Drive.",
    schema: z.object({
      fileId: z.string().describe("ID of the file"),
      commentId: z.string().describe("ID of the comment to delete"),
    }),
    execute: async (
      args: { fileId: string; commentId: string },
      context: { userId?: string },
    ) => {
      const { fileId, commentId } = args;

      return driveRequest(
        context,
        "DELETE",
        `/files/${fileId}/comments/${commentId}`,
      );
    },
  },

  // ── Replies ─────────────────────────────────────────────────────────────────

  {
    name: "drive_list_replies",
    description: "List all replies to a comment on a file in Google Drive.",
    schema: z.object({
      fileId: z.string().describe("ID of the file"),
      commentId: z.string().describe("ID of the comment"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of replies to return (max 100)"),
      pageToken: z.string().optional().describe("Page token for pagination"),
      fields: z.string().optional().describe("Fields to return"),
      includeDeleted: z
        .boolean()
        .optional()
        .describe("Whether to include deleted replies"),
    }),
    execute: async (
      args: {
        fileId: string;
        commentId: string;
        pageSize?: number;
        pageToken?: string;
        fields?: string;
        includeDeleted?: boolean;
      },
      context: { userId?: string },
    ) => {
      const { fileId, commentId, pageSize, pageToken, fields, includeDeleted } =
        args;

      return driveRequest(
        context,
        "GET",
        `/files/${fileId}/comments/${commentId}/replies`,
        { params: { pageSize, pageToken, fields, includeDeleted } },
      );
    },
  },

  {
    name: "drive_create_reply",
    description:
      "Reply to a comment on a file in Google Drive. Can also resolve or reopen a comment using the `action` parameter.",
    schema: z.object({
      fileId: z.string().describe("ID of the file"),
      commentId: z.string().describe("ID of the comment to reply to"),
      content: z.string().describe("The reply text"),
      action: z
        .enum(["resolve", "reopen"])
        .optional()
        .describe("Optional action: resolve or reopen the comment"),
    }),
    execute: async (
      args: {
        fileId: string;
        commentId: string;
        content: string;
        action?: "resolve" | "reopen";
      },
      context: { userId?: string },
    ) => {
      const { fileId, commentId, content, action } = args;

      const body: Record<string, unknown> = { content };
      if (action) body.action = action;

      return driveRequest(
        context,
        "POST",
        `/files/${fileId}/comments/${commentId}/replies`,
        {
          params: { fields: "id,content,createdTime,author,action,deleted" },
          body,
        },
      );
    },
  },

  // ── Revisions ───────────────────────────────────────────────────────────────

  {
    name: "drive_list_revisions",
    description:
      "List all revisions of a file in Google Drive. Only available for Google Workspace files and files with binary content.",
    schema: z.object({
      fileId: z.string().describe("ID of the file"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum number of revisions to return"),
      pageToken: z.string().optional().describe("Page token for pagination"),
      fields: z.string().optional().describe("Fields to return"),
    }),
    execute: async (
      args: {
        fileId: string;
        pageSize?: number;
        pageToken?: string;
        fields?: string;
      },
      context: { userId?: string },
    ) => {
      const { fileId, pageSize, pageToken, fields } = args;

      return driveRequest(context, "GET", `/files/${fileId}/revisions`, {
        params: { pageSize, pageToken, fields },
      });
    },
  },

  {
    name: "drive_get_revision",
    description: "Get metadata for a specific revision of a file.",
    schema: z.object({
      fileId: z.string().describe("ID of the file"),
      revisionId: z.string().describe("ID of the revision"),
      fields: z.string().optional().describe("Fields to return"),
      acknowledgeAbuse: z
        .boolean()
        .optional()
        .describe("Acknowledge the file may be harmful"),
    }),
    execute: async (
      args: {
        fileId: string;
        revisionId: string;
        fields?: string;
        acknowledgeAbuse?: boolean;
      },
      context: { userId?: string },
    ) => {
      const { fileId, revisionId, fields, acknowledgeAbuse } = args;

      return driveRequest(
        context,
        "GET",
        `/files/${fileId}/revisions/${revisionId}`,
        { params: { fields, acknowledgeAbuse } },
      );
    },
  },

  {
    name: "drive_delete_revision",
    description:
      "Permanently delete a specific revision of a file. Not all revisions are deletable; some must be kept to preserve the file.",
    schema: z.object({
      fileId: z.string().describe("ID of the file"),
      revisionId: z.string().describe("ID of the revision to delete"),
    }),
    execute: async (
      args: { fileId: string; revisionId: string },
      context: { userId?: string },
    ) => {
      const { fileId, revisionId } = args;

      return driveRequest(
        context,
        "DELETE",
        `/files/${fileId}/revisions/${revisionId}`,
      );
    },
  },
];

// ─── App Export ───────────────────────────────────────────────────────────────

export const driveApp: NathraxApp = {
  appId: "google",
  displayName: "Google Drive Integration",
  version: "2.0.0",
  tools: driveTools,
};
