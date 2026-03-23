import { z } from "zod";
import type { NathraxApp } from "../core/types";
import { db } from "../db";
import { connections } from "../db/schema";
import { and, eq } from "drizzle-orm";

// --- 1. THE CORE API WRAPPER ---

const NOTION_API_VERSION = "2022-06-28";
const NOTION_BASE_URL = "https://api.notion.com/v1";

const BASE_URL = process.env.BASE_URL;
const BASE_PORT = process.env.BASE_PORT;

async function notionRequest(
  endpoint: string,
  options: RequestInit,
  context: { developerId: string; endUserId: string },
) {
  const connection = await db.query.connections.findFirst({
    where: and(
      eq(connections.developerId, context.developerId),
      eq(connections.endUserId, context.endUserId),
      eq(connections.appId, "notion"),
    ),
  });

  if (!connection) {
    const authUrl = `${BASE_URL}:${BASE_PORT}/auth/notion?devId=${context.developerId}&userId=${context.endUserId}`;
    return {
      content: [
        {
          type: "text",
          text: `Auth required. Please authorize Notion: ${authUrl}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const response = await fetch(`${NOTION_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        content: [
          {
            type: "text",
            text: `Notion API Error: ${response.status} ${response.statusText}\n${errorBody}`,
          },
        ],
        isError: true,
      };
    }

    const data = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Network Error: ${error.message}` }],
      isError: true,
    };
  }
}

// --- 2. TOOL DEFINITIONS ---

export const notionApp: NathraxApp = {
  appId: "notion",
  displayName: "Notion",
  version: "0.2.0",
  tools: [
    // =============================================
    //  SEARCH
    // =============================================
    {
      name: "notion_search",
      description:
        "Search all pages and databases shared with the integration. Supports filtering by object type (page or database) and sorting by last_edited_time.",
      schema: z.object({
        query: z
          .string()
          .optional()
          .describe("Text to search for in page/database titles."),
        filter_object_type: z
          .enum(["page", "database"])
          .optional()
          .describe("Limit results to only pages or only databases."),
        sort_direction: z
          .enum(["ascending", "descending"])
          .optional()
          .describe(
            "Sort direction for last_edited_time. Defaults to descending.",
          ),
        page_size: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of results to return (max 100). Defaults to 10."),
        start_cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous response."),
      }),
      execute: async (
        { query, filter_object_type, sort_direction, page_size, start_cursor },
        context,
      ) => {
        const body: Record<string, any> = {};
        if (query) body.query = query;
        if (filter_object_type)
          body.filter = { value: filter_object_type, property: "object" };
        body.sort = {
          direction: sort_direction ?? "descending",
          timestamp: "last_edited_time",
        };
        body.page_size = page_size ?? 10;
        if (start_cursor) body.start_cursor = start_cursor;

        return await notionRequest(
          "/search",
          { method: "POST", body: JSON.stringify(body) },
          context,
        );
      },
    },

    // =============================================
    //  DATABASES
    // =============================================
    {
      name: "notion_retrieve_database",
      description:
        "Retrieve a database object by its ID. Returns the schema (properties), title, and metadata of the database.",
      schema: z.object({
        database_id: z.string().describe("The ID of the database to retrieve."),
      }),
      execute: async ({ database_id }, context) => {
        return await notionRequest(
          `/databases/${database_id}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "notion_query_database",
      description:
        "Query a database and return the pages (rows) it contains. Supports filtering by property values and sorting.",
      schema: z.object({
        database_id: z.string().describe("The ID of the database to query."),
        filter: z
          .any()
          .optional()
          .describe(
            "A Notion filter object. Example: { property: 'Status', select: { equals: 'Done' } } or compound: { and: [...] }.",
          ),
        sorts: z
          .array(
            z.object({
              property: z.string().optional(),
              timestamp: z
                .enum(["created_time", "last_edited_time"])
                .optional(),
              direction: z.enum(["ascending", "descending"]),
            }),
          )
          .optional()
          .describe("Array of sort objects. Earlier sorts take precedence."),
        page_size: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of results (max 100). Defaults to 10."),
        start_cursor: z.string().optional(),
        filter_properties: z
          .array(z.string())
          .optional()
          .describe(
            "Array of property IDs to include in the response. Omit to return all properties.",
          ),
      }),
      execute: async (
        {
          database_id,
          filter,
          sorts,
          page_size,
          start_cursor,
          filter_properties,
        },
        context,
      ) => {
        const body: Record<string, any> = {};
        if (filter) body.filter = filter;
        if (sorts) body.sorts = sorts;
        body.page_size = page_size ?? 10;
        if (start_cursor) body.start_cursor = start_cursor;

        let queryParams = "";
        if (filter_properties?.length) {
          queryParams =
            "?" +
            filter_properties
              .map((id) => `filter_properties=${encodeURIComponent(id)}`)
              .join("&");
        }

        return await notionRequest(
          `/databases/${database_id}/query${queryParams}`,
          { method: "POST", body: JSON.stringify(body) },
          context,
        );
      },
    },

    {
      name: "notion_create_database",
      description:
        "Create a new database as a child of an existing page. Define the schema via the properties parameter.",
      schema: z.object({
        parent_page_id: z
          .string()
          .describe("The ID of the parent page for the new database."),
        title: z.string().describe("The title of the new database."),
        properties: z
          .record(z.string(), z.any())
          .describe(
            "Database property schema. Keys are property names, values are property config objects. Example: { 'Name': { title: {} }, 'Tags': { multi_select: { options: [{ name: 'Bug' }] } } }.",
          ),
        is_inline: z
          .boolean()
          .optional()
          .describe("If true, display as an inline database within the page."),
        description: z
          .string()
          .optional()
          .describe("A plain-text description for the database."),
      }),
      execute: async (
        { parent_page_id, title, properties, is_inline, description },
        context,
      ) => {
        const body: Record<string, any> = {
          parent: { type: "page_id", page_id: parent_page_id },
          title: [{ text: { content: title } }],
          properties,
        };
        if (is_inline !== undefined) body.is_inline = is_inline;
        if (description) {
          body.description = [{ text: { content: description } }];
        }

        return await notionRequest(
          "/databases",
          { method: "POST", body: JSON.stringify(body) },
          context,
        );
      },
    },

    {
      name: "notion_update_database",
      description:
        "Update an existing database's title, description, or property schema.",
      schema: z.object({
        database_id: z.string().describe("The ID of the database to update."),
        title: z.string().optional().describe("New title for the database."),
        description: z
          .string()
          .optional()
          .describe("New description for the database."),
        properties: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Updated property schema. To rename: { 'OldName': { name: 'NewName' } }. To delete: { 'PropName': null }.",
          ),
        is_inline: z.boolean().optional(),
        in_trash: z
          .boolean()
          .optional()
          .describe("Set to true to move to trash, false to restore."),
      }),
      execute: async (
        { database_id, title, description, properties, is_inline, in_trash },
        context,
      ) => {
        const body: Record<string, any> = {};
        if (title !== undefined) body.title = [{ text: { content: title } }];
        if (description !== undefined)
          body.description = [{ text: { content: description } }];
        if (properties !== undefined) body.properties = properties;
        if (is_inline !== undefined) body.is_inline = is_inline;
        if (in_trash !== undefined) body.in_trash = in_trash;

        return await notionRequest(
          `/databases/${database_id}`,
          { method: "PATCH", body: JSON.stringify(body) },
          context,
        );
      },
    },

    // =============================================
    //  PAGES
    // =============================================
    {
      name: "notion_retrieve_page",
      description:
        "Retrieve a page by its ID. Returns the page's properties and metadata, but not its content blocks.",
      schema: z.object({
        page_id: z.string().describe("The ID of the page to retrieve."),
        filter_properties: z
          .array(z.string())
          .optional()
          .describe("Property IDs to include. Omit for all properties."),
      }),
      execute: async ({ page_id, filter_properties }, context) => {
        let queryParams = "";
        if (filter_properties?.length) {
          queryParams =
            "?" +
            filter_properties
              .map((id) => `filter_properties=${encodeURIComponent(id)}`)
              .join("&");
        }
        return await notionRequest(
          `/pages/${page_id}${queryParams}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "notion_create_page",
      description:
        "Create a new page. Can be a child of a page (only title property allowed) or a child of a database (properties must match the database schema). Optionally include initial content as markdown or block children.",
      schema: z.object({
        parent_type: z
          .enum(["page_id", "database_id"])
          .describe("Whether the parent is a page or a database."),
        parent_id: z
          .string()
          .describe("The ID of the parent page or database."),
        properties: z
          .record(z.string(), z.any())
          .describe(
            "Page properties. For a page parent: { title: [{ text: { content: 'My Title' } }] }. For a database parent: keys must match the database property names.",
          ),
        children: z
          .array(z.any())
          .optional()
          .describe(
            "Array of block objects for the page content. Mutually exclusive with markdown. Max 100 blocks.",
          ),
        markdown: z
          .string()
          .optional()
          .describe(
            "Page content as Notion-flavored Markdown. Mutually exclusive with children.",
          ),
        icon_emoji: z
          .string()
          .optional()
          .describe("Emoji to use as the page icon (e.g., '🚀')."),
        cover_url: z
          .string()
          .optional()
          .describe("External URL for the page cover image."),
      }),
      execute: async (
        {
          parent_type,
          parent_id,
          properties,
          children,
          markdown,
          icon_emoji,
          cover_url,
        },
        context,
      ) => {
        const body: Record<string, any> = {
          parent: { type: parent_type, [parent_type]: parent_id },
          properties,
        };
        if (children) body.children = children;
        if (markdown) body.markdown = markdown;
        if (icon_emoji) body.icon = { type: "emoji", emoji: icon_emoji };
        if (cover_url)
          body.cover = { type: "external", external: { url: cover_url } };

        return await notionRequest(
          "/pages",
          { method: "POST", body: JSON.stringify(body) },
          context,
        );
      },
    },

    {
      name: "notion_update_page",
      description:
        "Update a page's properties, icon, cover, archived/trash status, or lock state. Does not update content blocks — use append/update block tools for that.",
      schema: z.object({
        page_id: z.string().describe("The ID of the page to update."),
        properties: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Updated property values. Keys must match the page's property names.",
          ),
        icon_emoji: z.string().optional().describe("New emoji icon."),
        cover_url: z
          .string()
          .optional()
          .describe("New external cover image URL."),
        in_trash: z
          .boolean()
          .optional()
          .describe("Move to trash (true) or restore (false)."),
        is_archived: z.boolean().optional().describe("Archive or unarchive."),
        is_locked: z
          .boolean()
          .optional()
          .describe("Lock or unlock the page from editing in the Notion UI."),
      }),
      execute: async (
        {
          page_id,
          properties,
          icon_emoji,
          cover_url,
          in_trash,
          is_archived,
          is_locked,
        },
        context,
      ) => {
        const body: Record<string, any> = {};
        if (properties !== undefined) body.properties = properties;
        if (icon_emoji !== undefined)
          body.icon = { type: "emoji", emoji: icon_emoji };
        if (cover_url !== undefined)
          body.cover = { type: "external", external: { url: cover_url } };
        if (in_trash !== undefined) body.in_trash = in_trash;
        if (is_archived !== undefined) body.is_archived = is_archived;
        if (is_locked !== undefined) body.is_locked = is_locked;

        return await notionRequest(
          `/pages/${page_id}`,
          { method: "PATCH", body: JSON.stringify(body) },
          context,
        );
      },
    },

    {
      name: "notion_get_page_property",
      description:
        "Retrieve a specific property value from a page. Useful for paginated properties like rollups, relations, or people that may exceed 25 references.",
      schema: z.object({
        page_id: z.string().describe("The ID of the page."),
        property_id: z.string().describe("The ID of the property to retrieve."),
        page_size: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page. Defaults to 25."),
        start_cursor: z.string().optional(),
      }),
      execute: async (
        { page_id, property_id, page_size, start_cursor },
        context,
      ) => {
        const params = new URLSearchParams();
        params.set("page_size", String(page_size ?? 25));
        if (start_cursor) params.set("start_cursor", start_cursor);

        return await notionRequest(
          `/pages/${page_id}/properties/${property_id}?${params}`,
          { method: "GET" },
          context,
        );
      },
    },

    // =============================================
    //  BLOCKS
    // =============================================
    {
      name: "notion_retrieve_block",
      description: "Retrieve a single block by its ID.",
      schema: z.object({
        block_id: z.string().describe("The ID of the block to retrieve."),
      }),
      execute: async ({ block_id }, context) => {
        return await notionRequest(
          `/blocks/${block_id}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "notion_get_block_children",
      description:
        "Retrieve the child blocks of a given block or page. Use the page ID to get the top-level content of a page.",
      schema: z.object({
        block_id: z
          .string()
          .describe(
            "The ID of the parent block or page whose children to retrieve.",
          ),
        page_size: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page. Defaults to 50."),
        start_cursor: z.string().optional(),
      }),
      execute: async ({ block_id, page_size, start_cursor }, context) => {
        const params = new URLSearchParams();
        params.set("page_size", String(page_size ?? 50));
        if (start_cursor) params.set("start_cursor", start_cursor);

        return await notionRequest(
          `/blocks/${block_id}/children?${params}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "notion_append_block_children",
      description:
        "Append new child blocks to a page or an existing block. Supports all block types (paragraphs, headings, lists, to-dos, code, etc.). Max 100 blocks per call.",
      schema: z.object({
        block_id: z
          .string()
          .describe("The ID of the parent block or page to append to."),
        children: z
          .array(z.any())
          .describe(
            "Array of block objects to append. Example: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Hello' } }] } }].",
          ),
        position: z
          .object({
            type: z.enum(["end", "start", "after_block"]),
            after_block: z.object({ id: z.string() }).optional(),
          })
          .optional()
          .describe(
            "Where to insert. Default is 'end'. Use 'start' for beginning, or 'after_block' with a block id.",
          ),
      }),
      execute: async ({ block_id, children, position }, context) => {
        const body: Record<string, any> = { children };
        if (position) body.position = position;

        return await notionRequest(
          `/blocks/${block_id}/children`,
          { method: "PATCH", body: JSON.stringify(body) },
          context,
        );
      },
    },

    {
      name: "notion_update_block",
      description:
        "Update the content of an existing block. The payload must contain the block type key with updated fields. Omitted fields are left unchanged. Cannot update child_page or child_database blocks — use the page/database update tools instead.",
      schema: z.object({
        block_id: z.string().describe("The ID of the block to update."),
        block_type: z
          .string()
          .describe(
            "The type of the block (e.g., 'paragraph', 'heading_1', 'to_do', 'code').",
          ),
        content: z
          .any()
          .describe(
            "The updated content object for the block type. Example for paragraph: { rich_text: [{ type: 'text', text: { content: 'Updated text' } }] }.",
          ),
        in_trash: z
          .boolean()
          .optional()
          .describe("Set to true to soft-delete (trash) the block."),
      }),
      execute: async ({ block_id, block_type, content, in_trash }, context) => {
        const body: Record<string, any> = {
          [block_type]: content,
        };
        if (in_trash !== undefined) body.in_trash = in_trash;

        return await notionRequest(
          `/blocks/${block_id}`,
          { method: "PATCH", body: JSON.stringify(body) },
          context,
        );
      },
    },

    {
      name: "notion_delete_block",
      description:
        "Delete (trash) a block by its ID. This also deletes all children of the block. Can be used to delete pages by passing a page ID.",
      schema: z.object({
        block_id: z.string().describe("The ID of the block to delete."),
      }),
      execute: async ({ block_id }, context) => {
        return await notionRequest(
          `/blocks/${block_id}`,
          { method: "DELETE" },
          context,
        );
      },
    },

    // =============================================
    //  USERS
    // =============================================
    {
      name: "notion_list_users",
      description:
        "List all users in the workspace. Guests are not included. Requires the integration to have user information capabilities.",
      schema: z.object({
        page_size: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page. Defaults to 10."),
        start_cursor: z.string().optional(),
      }),
      execute: async ({ page_size, start_cursor }, context) => {
        const params = new URLSearchParams();
        params.set("page_size", String(page_size ?? 10));
        if (start_cursor) params.set("start_cursor", start_cursor);

        return await notionRequest(
          `/users?${params}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "notion_retrieve_user",
      description: "Retrieve a single user by their ID.",
      schema: z.object({
        user_id: z.string().describe("The ID of the user to retrieve."),
      }),
      execute: async ({ user_id }, context) => {
        return await notionRequest(
          `/users/${user_id}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "notion_get_bot_user",
      description:
        "Retrieve the bot user associated with the current integration token. Useful for confirming the integration identity.",
      schema: z.object({}),
      execute: async (_args, context) => {
        return await notionRequest(`/users/me`, { method: "GET" }, context);
      },
    },

    // =============================================
    //  COMMENTS
    // =============================================
    {
      name: "notion_list_comments",
      description:
        "List all comments on a block or page. Returns comments in chronological order.",
      schema: z.object({
        block_id: z
          .string()
          .describe("The ID of the block or page to retrieve comments for."),
        page_size: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page. Defaults to 25."),
        start_cursor: z.string().optional(),
      }),
      execute: async ({ block_id, page_size, start_cursor }, context) => {
        const params = new URLSearchParams();
        params.set("block_id", block_id);
        params.set("page_size", String(page_size ?? 25));
        if (start_cursor) params.set("start_cursor", start_cursor);

        return await notionRequest(
          `/comments?${params}`,
          { method: "GET" },
          context,
        );
      },
    },

    {
      name: "notion_create_comment",
      description:
        "Create a new comment on a page, block, or in an existing discussion thread. Provide either a parent (page_id or block_id) OR a discussion_id — not both.",
      schema: z.object({
        parent_page_id: z
          .string()
          .optional()
          .describe(
            "The page ID to comment on. Mutually exclusive with parent_block_id and discussion_id.",
          ),
        parent_block_id: z
          .string()
          .optional()
          .describe(
            "The block ID to comment on. Mutually exclusive with parent_page_id and discussion_id.",
          ),
        discussion_id: z
          .string()
          .optional()
          .describe(
            "Reply to an existing discussion thread. Mutually exclusive with parent_page_id and parent_block_id.",
          ),
        text: z.string().describe("The plain text content of the comment."),
      }),
      execute: async (
        { parent_page_id, parent_block_id, discussion_id, text },
        context,
      ) => {
        const body: Record<string, any> = {
          rich_text: [{ type: "text", text: { content: text } }],
        };

        if (discussion_id) {
          body.discussion_id = discussion_id;
        } else if (parent_page_id) {
          body.parent = { page_id: parent_page_id };
        } else if (parent_block_id) {
          body.parent = { block_id: parent_block_id };
        }

        return await notionRequest(
          "/comments",
          { method: "POST", body: JSON.stringify(body) },
          context,
        );
      },
    },
  ],
};
