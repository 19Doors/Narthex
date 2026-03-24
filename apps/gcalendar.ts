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
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "openid",
      "email",
      "profile",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ─── Calendar API Request Wrapper ─────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
  _raw?: unknown;
};

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

async function calendarRequest(
  context: { userId?: string },
  method: string,
  path: string,
  options?: {
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
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
                "Google Calendar is not connected. Please authorize via the link below.",
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

  // Build query string
  const buildUrl = (token?: string) => {
    const url = new URL(`${CALENDAR_BASE}${path}`);
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

// ─── Helper: ok() ─────────────────────────────────────────────────────────────

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatEvent(event: Record<string, unknown>): Record<string, unknown> {
  const start = event.start as Record<string, unknown> | undefined;
  const end = event.end as Record<string, unknown> | undefined;
  const creator = event.creator as Record<string, unknown> | undefined;
  const organizer = event.organizer as Record<string, unknown> | undefined;
  const attendees = event.attendees as
    | Array<Record<string, unknown>>
    | undefined;
  const conferenceData = event.conferenceData as
    | Record<string, unknown>
    | undefined;
  const entryPoints = conferenceData?.entryPoints as
    | Array<Record<string, unknown>>
    | undefined;
  const reminders = event.reminders as Record<string, unknown> | undefined;
  const attachments = event.attachments as
    | Array<Record<string, unknown>>
    | undefined;

  return {
    id: event.id,
    status: event.status,
    htmlLink: event.htmlLink,
    hangoutLink: event.hangoutLink,
    summary: event.summary,
    description: event.description,
    location: event.location,
    colorId: event.colorId,
    visibility: event.visibility,
    transparency: event.transparency,
    eventType: event.eventType,
    start: start
      ? {
          dateTime: start.dateTime,
          date: start.date,
          timeZone: start.timeZone,
        }
      : undefined,
    end: end
      ? {
          dateTime: end.dateTime,
          date: end.date,
          timeZone: end.timeZone,
        }
      : undefined,
    creator: creator
      ? {
          email: creator.email,
          displayName: creator.displayName,
          self: creator.self,
        }
      : undefined,
    organizer: organizer
      ? {
          email: organizer.email,
          displayName: organizer.displayName,
          self: organizer.self,
        }
      : undefined,
    attendees: attendees?.map((a) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
      self: a.self,
      organizer: a.organizer,
      optional: a.optional,
    })),
    recurrence: event.recurrence,
    conferenceData: conferenceData
      ? {
          conferenceId: conferenceData.conferenceId,
          conferenceSolution: conferenceData.conferenceSolution,
          entryPoints: entryPoints?.map((ep) => ({
            entryPointType: ep.entryPointType,
            uri: ep.uri,
            label: ep.label,
          })),
          createRequest: conferenceData.createRequest,
          notes: conferenceData.notes,
        }
      : undefined,
    reminders: reminders
      ? {
          useDefault: reminders.useDefault,
          overrides: reminders.overrides,
        }
      : undefined,
    attachments: attachments?.map((att) => ({
      fileUrl: att.fileUrl,
      title: att.title,
      mimeType: att.mimeType,
      iconLink: att.iconLink,
      fileId: att.fileId,
    })),
    created: event.created,
    updated: event.updated,
    iCalUID: event.iCalUID,
    sequence: event.sequence,
    privateCopy: event.privateCopy,
    recurringEventId: event.recurringEventId,
    originalStartTime: event.originalStartTime,
  };
}

function formatCalendar(cal: Record<string, unknown>): Record<string, unknown> {
  const notificationSettings = cal.notificationSettings as
    | Record<string, unknown>
    | undefined;
  const conferenceProperties = cal.conferenceProperties as
    | Record<string, unknown>
    | undefined;

  return {
    id: cal.id,
    kind: cal.kind,
    etag: cal.etag,
    summary: cal.summary,
    description: cal.description,
    location: cal.location,
    timeZone: cal.timeZone,
    summaryOverride: cal.summaryOverride,
    colorId: cal.colorId,
    backgroundColor: cal.backgroundColor,
    foregroundColor: cal.foregroundColor,
    hidden: cal.hidden,
    selected: cal.selected,
    accessRole: cal.accessRole,
    primary: cal.primary,
    deleted: cal.deleted,
    defaultReminders: cal.defaultReminders,
    notificationSettings: notificationSettings
      ? { notifications: notificationSettings.notifications }
      : undefined,
    conferenceProperties: conferenceProperties
      ? {
          allowedConferenceSolutionTypes:
            conferenceProperties.allowedConferenceSolutionTypes,
        }
      : undefined,
  };
}

function formatEventList(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const items = data.items as Array<Record<string, unknown>> | undefined;
  return {
    kind: data.kind,
    summary: data.summary,
    description: data.description,
    timeZone: data.timeZone,
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
    totalCount: items?.length ?? 0,
    events: items?.map(formatEvent) ?? [],
  };
}

function formatCalendarList(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const items = data.items as Array<Record<string, unknown>> | undefined;
  return {
    kind: data.kind,
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
    totalCount: items?.length ?? 0,
    calendars: items?.map(formatCalendar) ?? [],
  };
}

function formatFreeBusy(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const calendars = data.calendars as
    | Record<string, Record<string, unknown>>
    | undefined;
  const formatted: Record<string, unknown> = {
    kind: data.kind,
    timeMin: data.timeMin,
    timeMax: data.timeMax,
    groups: data.groups,
    calendars: {},
  };

  if (calendars) {
    const result: Record<string, unknown> = {};
    for (const [calId, calData] of Object.entries(calendars)) {
      const busy = calData.busy as Array<Record<string, unknown>> | undefined;
      const errors = calData.errors as
        | Array<Record<string, unknown>>
        | undefined;
      result[calId] = {
        busy:
          busy?.map((b) => ({
            start: b.start,
            end: b.end,
          })) ?? [],
        errors: errors ?? [],
        busyCount: busy?.length ?? 0,
      };
    }
    formatted.calendars = result;
  }

  return formatted;
}

// ─── Tool Schemas ─────────────────────────────────────────────────────────────

// Reusable sub-schemas
const calendarIdSchema = z
  .string()
  .default("primary")
  .describe('Calendar ID. Use "primary" for the user\'s primary calendar.');

const sendUpdatesSchema = z
  .enum(["all", "externalOnly", "none"])
  .optional()
  .describe("Whether to send notifications about event changes.");

const timeMinSchema = z
  .string()
  .optional()
  .describe(
    "Lower bound for event end time (RFC3339 timestamp with mandatory time zone offset).",
  );

const timeMaxSchema = z
  .string()
  .optional()
  .describe(
    "Upper bound for event start time (RFC3339 timestamp with mandatory time zone offset).",
  );

const pageTokenSchema = z
  .string()
  .optional()
  .describe("Token for next page of results.");

const maxResultsSchema = z
  .number()
  .int()
  .positive()
  .max(2500)
  .optional()
  .describe("Maximum number of events to return (max 2500).");

const eventDateTimeSchema = z
  .object({
    dateTime: z
      .string()
      .optional()
      .describe(
        "RFC3339 datetime for timed events, e.g. 2026-03-24T10:00:00+05:30",
      ),
    date: z
      .string()
      .optional()
      .describe("Date-only for all-day events, e.g. 2026-03-24"),
    timeZone: z
      .string()
      .optional()
      .describe("IANA time zone name, e.g. Asia/Kolkata"),
  })
  .describe("Event start or end time.");

const attendeeSchema = z.object({
  email: z.string().email().describe("Attendee email address."),
  optional: z
    .boolean()
    .optional()
    .describe("Whether the attendee is optional."),
  responseStatus: z
    .enum(["needsAction", "declined", "tentative", "accepted"])
    .optional()
    .describe("Attendee response status."),
});

const reminderOverrideSchema = z.object({
  method: z.enum(["email", "popup"]).describe("Reminder delivery method."),
  minutes: z
    .number()
    .int()
    .describe("Minutes before event start for the reminder."),
});

// ─── Tools ────────────────────────────────────────────────────────────────────

const calendarTools = [
  // ── Calendars ──────────────────────────────────────────────────────────────

  {
    name: "calendar_list_calendars",
    description:
      "List all calendars in the user's Google Calendar list, including primary, shared, and subscribed calendars.",
    schema: z.object({
      minAccessRole: z
        .enum(["freeBusyReader", "owner", "reader", "writer"])
        .optional()
        .describe("Filter calendars by minimum access role."),
      showDeleted: z
        .boolean()
        .optional()
        .describe(
          "Whether to include deleted calendar list entries in the result.",
        ),
      showHidden: z
        .boolean()
        .optional()
        .describe("Whether to show hidden entries."),
      pageToken: pageTokenSchema,
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of entries returned."),
    }),
    execute: async (
      args: {
        minAccessRole?: "freeBusyReader" | "owner" | "reader" | "writer";
        showDeleted?: boolean;
        showHidden?: boolean;
        pageToken?: string;
        maxResults?: number;
      },
      context: { userId?: string },
    ) => {
      const result = await calendarRequest(
        context,
        "GET",
        "/users/me/calendarList",
        {
          params: {
            minAccessRole: args.minAccessRole,
            showDeleted: args.showDeleted,
            showHidden: args.showHidden,
            pageToken: args.pageToken,
            maxResults: args.maxResults,
          },
        },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatCalendarList(data));
    },
  },

  {
    name: "calendar_get_calendar",
    description:
      "Get metadata for a specific calendar from the user's calendar list.",
    schema: z.object({
      calendarId: z
        .string()
        .describe(
          'Calendar ID to retrieve. Use "primary" for the primary calendar.',
        ),
    }),
    execute: async (
      args: { calendarId: string },
      context: { userId?: string },
    ) => {
      const result = await calendarRequest(
        context,
        "GET",
        `/users/me/calendarList/${encodeURIComponent(args.calendarId)}`,
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatCalendar(data));
    },
  },

  {
    name: "calendar_create_calendar",
    description:
      "Create a new secondary calendar in the user's Google Calendar account.",
    schema: z.object({
      summary: z.string().describe("Title of the calendar (required)."),
      description: z
        .string()
        .optional()
        .describe("Description of the calendar."),
      location: z
        .string()
        .optional()
        .describe("Geographic location of the calendar as free-form text."),
      timeZone: z
        .string()
        .optional()
        .describe(
          "The time zone of the calendar, formatted as an IANA Time Zone Database name (e.g. Asia/Kolkata).",
        ),
    }),
    execute: async (
      args: {
        summary: string;
        description?: string;
        location?: string;
        timeZone?: string;
      },
      context: { userId?: string },
    ) => {
      const body: Record<string, unknown> = { summary: args.summary };
      if (args.description) body.description = args.description;
      if (args.location) body.location = args.location;
      if (args.timeZone) body.timeZone = args.timeZone;

      const result = await calendarRequest(context, "POST", "/calendars", {
        body,
      });
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatCalendar(data));
    },
  },

  {
    name: "calendar_update_calendar",
    description:
      "Update metadata for an existing calendar (title, description, location, time zone). Uses PATCH semantics — only provided fields are changed.",
    schema: z.object({
      calendarId: z.string().describe("Calendar ID to update."),
      summary: z.string().optional().describe("New title for the calendar."),
      description: z.string().optional().describe("New description."),
      location: z.string().optional().describe("New geographic location."),
      timeZone: z.string().optional().describe("New IANA time zone name."),
    }),
    execute: async (
      args: {
        calendarId: string;
        summary?: string;
        description?: string;
        location?: string;
        timeZone?: string;
      },
      context: { userId?: string },
    ) => {
      const body: Record<string, unknown> = {};
      if (args.summary !== undefined) body.summary = args.summary;
      if (args.description !== undefined) body.description = args.description;
      if (args.location !== undefined) body.location = args.location;
      if (args.timeZone !== undefined) body.timeZone = args.timeZone;

      const result = await calendarRequest(
        context,
        "PATCH",
        `/calendars/${encodeURIComponent(args.calendarId)}`,
        { body },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatCalendar(data));
    },
  },

  {
    name: "calendar_delete_calendar",
    description:
      "Delete a secondary calendar permanently. WARNING: The primary calendar cannot be deleted — attempting to do so will result in an error. This action is irreversible.",
    schema: z.object({
      calendarId: z
        .string()
        .describe(
          'ID of the secondary calendar to delete. Do NOT use "primary" — the primary calendar cannot be deleted.',
        ),
    }),
    execute: async (
      args: { calendarId: string },
      context: { userId?: string },
    ) => {
      if (args.calendarId === "primary") {
        return ok({
          error: "forbidden",
          message:
            "The primary calendar cannot be deleted. You may only delete secondary calendars.",
        });
      }
      return calendarRequest(
        context,
        "DELETE",
        `/calendars/${encodeURIComponent(args.calendarId)}`,
      );
    },
  },

  {
    name: "calendar_clear_calendar",
    description:
      "Clear all events from a primary calendar. This deletes all events but does not delete the calendar itself. WARNING: This is irreversible.",
    schema: z.object({
      calendarId: calendarIdSchema,
    }),
    execute: async (
      args: { calendarId: string },
      context: { userId?: string },
    ) => {
      return calendarRequest(
        context,
        "POST",
        `/calendars/${encodeURIComponent(args.calendarId)}/clear`,
        { body: {} },
      );
    },
  },

  // ── Events ─────────────────────────────────────────────────────────────────

  {
    name: "calendar_list_events",
    description:
      "List events on a Google Calendar. Supports filtering by time range, full-text search, and pagination. By default returns upcoming events from the primary calendar.",
    schema: z.object({
      calendarId: calendarIdSchema,
      timeMin: z
        .string()
        .optional()
        .describe(
          "Lower bound (exclusive) for event end time filter — RFC3339 timestamp with timezone offset, e.g. 2026-03-24T00:00:00+05:30",
        ),
      timeMax: z
        .string()
        .optional()
        .describe(
          "Upper bound (exclusive) for event start time filter — RFC3339 timestamp with timezone offset.",
        ),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(2500)
        .default(10)
        .describe("Maximum number of events to return (default 10, max 2500)."),
      singleEvents: z
        .boolean()
        .default(true)
        .describe(
          "Whether to expand recurring events into individual instances. Recommended: true.",
        ),
      orderBy: z
        .enum(["startTime", "updated"])
        .optional()
        .describe(
          'Sort order. "startTime" requires singleEvents=true. "updated" sorts by last modification time.',
        ),
      q: z
        .string()
        .optional()
        .describe(
          "Free-text search term to filter events by summary, description, location, attendee names/emails.",
        ),
      pageToken: pageTokenSchema,
      timeZone: z
        .string()
        .optional()
        .describe(
          "Time zone in IANA format for the response. Defaults to calendar time zone.",
        ),
      showDeleted: z
        .boolean()
        .optional()
        .describe(
          "Whether to include deleted events (with status=cancelled) in the result.",
        ),
      updatedMin: z
        .string()
        .optional()
        .describe(
          "Lower bound for event last-modification time filter (RFC3339 timestamp). Required when syncToken is not set.",
        ),
    }),
    execute: async (
      args: {
        calendarId: string;
        timeMin?: string;
        timeMax?: string;
        maxResults: number;
        singleEvents: boolean;
        orderBy?: "startTime" | "updated";
        q?: string;
        pageToken?: string;
        timeZone?: string;
        showDeleted?: boolean;
        updatedMin?: string;
      },
      context: { userId?: string },
    ) => {
      const result = await calendarRequest(
        context,
        "GET",
        `/calendars/${encodeURIComponent(args.calendarId)}/events`,
        {
          params: {
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            maxResults: args.maxResults,
            singleEvents: args.singleEvents,
            orderBy: args.orderBy,
            q: args.q,
            pageToken: args.pageToken,
            timeZone: args.timeZone,
            showDeleted: args.showDeleted,
            updatedMin: args.updatedMin,
          },
        },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatEventList(data));
    },
  },

  {
    name: "calendar_get_event",
    description: "Get the full details of a single calendar event by its ID.",
    schema: z.object({
      calendarId: calendarIdSchema,
      eventId: z.string().describe("The event ID to retrieve."),
      timeZone: z
        .string()
        .optional()
        .describe(
          "Time zone for the response (IANA name). Defaults to calendar time zone.",
        ),
    }),
    execute: async (
      args: { calendarId: string; eventId: string; timeZone?: string },
      context: { userId?: string },
    ) => {
      const result = await calendarRequest(
        context,
        "GET",
        `/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(
          args.eventId,
        )}`,
        { params: { timeZone: args.timeZone } },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatEvent(data));
    },
  },

  {
    name: "calendar_create_event",
    description:
      "Create a new event on a Google Calendar. Supports timed events, all-day events, recurring events, attendees, reminders, Google Meet links, and more.",
    schema: z.object({
      calendarId: calendarIdSchema,
      summary: z.string().describe("Title / name of the event (required)."),
      description: z
        .string()
        .optional()
        .describe("Description or notes for the event."),
      location: z
        .string()
        .optional()
        .describe("Geographic location or address for the event."),
      start: eventDateTimeSchema.describe(
        "Event start time. Use dateTime for timed events, date for all-day events.",
      ),
      end: eventDateTimeSchema.describe(
        "Event end time. Use dateTime for timed events, date for all-day events.",
      ),
      attendees: z
        .array(attendeeSchema)
        .optional()
        .describe("List of attendee email addresses and optional settings."),
      recurrence: z
        .array(z.string())
        .optional()
        .describe(
          'Array of RRULE, EXRULE, RDATE, EXDATE strings. Example: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]',
        ),
      reminders: z
        .object({
          useDefault: z
            .boolean()
            .describe("Whether to use the calendar default reminders."),
          overrides: z
            .array(reminderOverrideSchema)
            .optional()
            .describe(
              "Custom reminder overrides. Only used when useDefault is false.",
            ),
        })
        .optional()
        .describe("Reminder settings for this event."),
      colorId: z
        .string()
        .optional()
        .describe(
          "Color ID for the event (1–11). Use calendar_get_colors to see available colors.",
        ),
      visibility: z
        .enum(["default", "public", "private", "confidential"])
        .optional()
        .describe("Visibility of the event."),
      transparency: z
        .enum(["opaque", "transparent"])
        .optional()
        .describe(
          '"opaque" means the event blocks time (busy); "transparent" means it does not (free).',
        ),
      sendUpdates: sendUpdatesSchema,
      conferenceData: z
        .object({
          createRequest: z
            .object({
              requestId: z
                .string()
                .describe(
                  "A unique client-generated ID for this conference request (e.g. a UUID). Reusing the same requestId will return the same conference.",
                ),
              conferenceSolutionKey: z
                .object({
                  type: z
                    .literal("hangoutsMeet")
                    .describe(
                      'Must be "hangoutsMeet" to create a Google Meet link.',
                    ),
                })
                .optional(),
            })
            .describe(
              "Request to create a new Google Meet video conference for this event.",
            ),
        })
        .optional()
        .describe(
          'Conference data for video conferencing. Set conferenceDataVersion=1 when providing this. Example: { createRequest: { requestId: "unique-id", conferenceSolutionKey: { type: "hangoutsMeet" } } }',
        ),
      conferenceDataVersion: z
        .number()
        .int()
        .optional()
        .describe(
          "Set to 1 when providing conferenceData to create a Meet link.",
        ),
    }),
    execute: async (
      args: {
        calendarId: string;
        summary: string;
        description?: string;
        location?: string;
        start: { dateTime?: string; date?: string; timeZone?: string };
        end: { dateTime?: string; date?: string; timeZone?: string };
        attendees?: Array<{
          email: string;
          optional?: boolean;
          responseStatus?: string;
        }>;
        recurrence?: string[];
        reminders?: {
          useDefault: boolean;
          overrides?: Array<{ method: "email" | "popup"; minutes: number }>;
        };
        colorId?: string;
        visibility?: "default" | "public" | "private" | "confidential";
        transparency?: "opaque" | "transparent";
        sendUpdates?: "all" | "externalOnly" | "none";
        conferenceData?: {
          createRequest: {
            requestId: string;
            conferenceSolutionKey?: { type: "hangoutsMeet" };
          };
        };
        conferenceDataVersion?: number;
      },
      context: { userId?: string },
    ) => {
      const body: Record<string, unknown> = {
        summary: args.summary,
        start: args.start,
        end: args.end,
      };

      if (args.description !== undefined) body.description = args.description;
      if (args.location !== undefined) body.location = args.location;
      if (args.attendees !== undefined) body.attendees = args.attendees;
      if (args.recurrence !== undefined) body.recurrence = args.recurrence;
      if (args.reminders !== undefined) body.reminders = args.reminders;
      if (args.colorId !== undefined) body.colorId = args.colorId;
      if (args.visibility !== undefined) body.visibility = args.visibility;
      if (args.transparency !== undefined)
        body.transparency = args.transparency;
      if (args.conferenceData !== undefined)
        body.conferenceData = args.conferenceData;

      const params: Record<string, string | number | boolean | undefined> = {};
      if (args.sendUpdates) params.sendUpdates = args.sendUpdates;
      if (args.conferenceDataVersion !== undefined)
        params.conferenceDataVersion = args.conferenceDataVersion;

      const result = await calendarRequest(
        context,
        "POST",
        `/calendars/${encodeURIComponent(args.calendarId)}/events`,
        { body, params },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatEvent(data));
    },
  },

  {
    name: "calendar_update_event",
    description:
      "Update an existing calendar event using PATCH semantics — only the fields you provide will be changed. Supports all event fields including attendees, recurrence, reminders, and conference data.",
    schema: z.object({
      calendarId: calendarIdSchema,
      eventId: z.string().describe("ID of the event to update."),
      summary: z.string().optional().describe("New event title."),
      description: z.string().optional().describe("New description."),
      location: z.string().optional().describe("New location."),
      start: eventDateTimeSchema.optional().describe("New start time."),
      end: eventDateTimeSchema.optional().describe("New end time."),
      attendees: z
        .array(attendeeSchema)
        .optional()
        .describe("New attendee list (replaces entire attendee array)."),
      recurrence: z
        .array(z.string())
        .optional()
        .describe("New recurrence rules (replaces entire recurrence array)."),
      reminders: z
        .object({
          useDefault: z.boolean(),
          overrides: z.array(reminderOverrideSchema).optional(),
        })
        .optional()
        .describe("New reminder settings."),
      colorId: z.string().optional().describe("New color ID."),
      visibility: z
        .enum(["default", "public", "private", "confidential"])
        .optional()
        .describe("New visibility setting."),
      transparency: z
        .enum(["opaque", "transparent"])
        .optional()
        .describe("New transparency setting."),
      sendUpdates: sendUpdatesSchema,
      conferenceData: z
        .object({
          createRequest: z.object({
            requestId: z.string(),
            conferenceSolutionKey: z
              .object({ type: z.literal("hangoutsMeet") })
              .optional(),
          }),
        })
        .optional()
        .describe("Conference data for adding/updating a Google Meet link."),
      conferenceDataVersion: z
        .number()
        .int()
        .optional()
        .describe("Set to 1 when providing conferenceData."),
    }),
    execute: async (
      args: {
        calendarId: string;
        eventId: string;
        summary?: string;
        description?: string;
        location?: string;
        start?: { dateTime?: string; date?: string; timeZone?: string };
        end?: { dateTime?: string; date?: string; timeZone?: string };
        attendees?: Array<{
          email: string;
          optional?: boolean;
          responseStatus?: string;
        }>;
        recurrence?: string[];
        reminders?: {
          useDefault: boolean;
          overrides?: Array<{ method: "email" | "popup"; minutes: number }>;
        };
        colorId?: string;
        visibility?: "default" | "public" | "private" | "confidential";
        transparency?: "opaque" | "transparent";
        sendUpdates?: "all" | "externalOnly" | "none";
        conferenceData?: {
          createRequest: {
            requestId: string;
            conferenceSolutionKey?: { type: "hangoutsMeet" };
          };
        };
        conferenceDataVersion?: number;
      },
      context: { userId?: string },
    ) => {
      const body: Record<string, unknown> = {};
      if (args.summary !== undefined) body.summary = args.summary;
      if (args.description !== undefined) body.description = args.description;
      if (args.location !== undefined) body.location = args.location;
      if (args.start !== undefined) body.start = args.start;
      if (args.end !== undefined) body.end = args.end;
      if (args.attendees !== undefined) body.attendees = args.attendees;
      if (args.recurrence !== undefined) body.recurrence = args.recurrence;
      if (args.reminders !== undefined) body.reminders = args.reminders;
      if (args.colorId !== undefined) body.colorId = args.colorId;
      if (args.visibility !== undefined) body.visibility = args.visibility;
      if (args.transparency !== undefined)
        body.transparency = args.transparency;
      if (args.conferenceData !== undefined)
        body.conferenceData = args.conferenceData;

      const params: Record<string, string | number | boolean | undefined> = {};
      if (args.sendUpdates) params.sendUpdates = args.sendUpdates;
      if (args.conferenceDataVersion !== undefined)
        params.conferenceDataVersion = args.conferenceDataVersion;

      const result = await calendarRequest(
        context,
        "PATCH",
        `/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(
          args.eventId,
        )}`,
        { body, params },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatEvent(data));
    },
  },

  {
    name: "calendar_delete_event",
    description:
      "Permanently delete a calendar event. This action cannot be undone. Use sendUpdates to control whether attendees receive cancellation notifications.",
    schema: z.object({
      calendarId: calendarIdSchema,
      eventId: z.string().describe("ID of the event to delete."),
      sendUpdates: sendUpdatesSchema,
    }),
    execute: async (
      args: {
        calendarId: string;
        eventId: string;
        sendUpdates?: "all" | "externalOnly" | "none";
      },
      context: { userId?: string },
    ) => {
      return calendarRequest(
        context,
        "DELETE",
        `/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(
          args.eventId,
        )}`,
        { params: { sendUpdates: args.sendUpdates } },
      );
    },
  },

  {
    name: "calendar_move_event",
    description:
      "Move an event from one calendar to another. Only default event types can be moved — birthday, focusTime, fromGmail, outOfOffice, and workingLocation events cannot be moved.",
    schema: z.object({
      calendarId: z
        .string()
        .describe(
          "ID of the source calendar that currently contains the event.",
        ),
      eventId: z.string().describe("ID of the event to move."),
      destination: z
        .string()
        .describe("ID of the target calendar to move the event to."),
      sendUpdates: sendUpdatesSchema,
    }),
    execute: async (
      args: {
        calendarId: string;
        eventId: string;
        destination: string;
        sendUpdates?: "all" | "externalOnly" | "none";
      },
      context: { userId?: string },
    ) => {
      const result = await calendarRequest(
        context,
        "POST",
        `/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(
          args.eventId,
        )}/move`,
        {
          params: {
            destination: args.destination,
            sendUpdates: args.sendUpdates,
          },
          body: {},
        },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatEvent(data));
    },
  },

  {
    name: "calendar_quick_add_event",
    description:
      'Create a calendar event from a natural language text string. Google Calendar parses the text to determine the event details. Examples: "Dinner with John tomorrow at 7pm", "Weekly team sync every Monday at 10am".',
    schema: z.object({
      calendarId: calendarIdSchema,
      text: z
        .string()
        .describe(
          'Natural language text describing the event. Examples: "Dentist appointment April 5 at 3pm", "Call with Sarah next Friday at noon".',
        ),
      sendUpdates: sendUpdatesSchema,
    }),
    execute: async (
      args: {
        calendarId: string;
        text: string;
        sendUpdates?: "all" | "externalOnly" | "none";
      },
      context: { userId?: string },
    ) => {
      const result = await calendarRequest(
        context,
        "POST",
        `/calendars/${encodeURIComponent(args.calendarId)}/events/quickAdd`,
        {
          params: {
            text: args.text,
            sendUpdates: args.sendUpdates,
          },
          body: {},
        },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatEvent(data));
    },
  },

  {
    name: "calendar_list_event_instances",
    description:
      "Get all instances of a recurring event within an optional time range. Useful for viewing the individual occurrences of a repeating event.",
    schema: z.object({
      calendarId: calendarIdSchema,
      eventId: z.string().describe("ID of the recurring event."),
      timeMin: timeMinSchema,
      timeMax: timeMaxSchema,
      maxResults: maxResultsSchema,
      pageToken: pageTokenSchema,
      timeZone: z
        .string()
        .optional()
        .describe("Time zone for the response (IANA name)."),
    }),
    execute: async (
      args: {
        calendarId: string;
        eventId: string;
        timeMin?: string;
        timeMax?: string;
        maxResults?: number;
        pageToken?: string;
        timeZone?: string;
      },
      context: { userId?: string },
    ) => {
      const result = await calendarRequest(
        context,
        "GET",
        `/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(
          args.eventId,
        )}/instances`,
        {
          params: {
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            maxResults: args.maxResults,
            pageToken: args.pageToken,
            timeZone: args.timeZone,
          },
        },
      );
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatEventList(data));
    },
  },

  // ── Free/Busy ──────────────────────────────────────────────────────────────

  {
    name: "calendar_freebusy_query",
    description:
      "Query free/busy information for one or more calendars within a time range. Returns busy time blocks, which is useful for scheduling and finding available meeting slots.",
    schema: z.object({
      timeMin: z
        .string()
        .describe(
          "Start of the interval to query (RFC3339 timestamp with timezone offset, e.g. 2026-03-24T09:00:00+05:30). Required.",
        ),
      timeMax: z
        .string()
        .describe(
          "End of the interval to query (RFC3339 timestamp with timezone offset, e.g. 2026-03-24T18:00:00+05:30). Required.",
        ),
      timeZone: z
        .string()
        .optional()
        .describe("Time zone for the response (IANA name). Defaults to UTC."),
      items: z
        .array(
          z.object({
            id: z
              .string()
              .describe(
                'Calendar ID to query. Use "primary" for the user\'s primary calendar.',
              ),
          }),
        )
        .min(1)
        .describe(
          'List of calendars to query. Each item must have an "id" field. Example: [{"id": "primary"}, {"id": "team@example.com"}]',
        ),
    }),
    execute: async (
      args: {
        timeMin: string;
        timeMax: string;
        timeZone?: string;
        items: Array<{ id: string }>;
      },
      context: { userId?: string },
    ) => {
      const body: Record<string, unknown> = {
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        items: args.items,
      };
      if (args.timeZone) body.timeZone = args.timeZone;

      const result = await calendarRequest(context, "POST", "/freeBusy", {
        body,
      });
      if (result.isError) return result;
      const data = result._raw as Record<string, unknown>;
      return ok(formatFreeBusy(data));
    },
  },

  // ── Settings ───────────────────────────────────────────────────────────────

  {
    name: "calendar_list_settings",
    description:
      "List all user settings for Google Calendar (e.g. locale, time zone, week start, date field order).",
    schema: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: { userId?: string },
    ) => {
      return calendarRequest(context, "GET", "/users/me/settings");
    },
  },

  {
    name: "calendar_get_setting",
    description:
      "Get a specific Google Calendar user setting by its setting ID. Common setting IDs: locale, timezone, weekStart, dateFieldOrder, hideInvitations, defaultEventLength, format24HourTime.",
    schema: z.object({
      settingId: z
        .string()
        .describe(
          'The setting ID to retrieve. Examples: "timezone", "locale", "weekStart", "format24HourTime".',
        ),
    }),
    execute: async (
      args: { settingId: string },
      context: { userId?: string },
    ) => {
      return calendarRequest(
        context,
        "GET",
        `/users/me/settings/${encodeURIComponent(args.settingId)}`,
      );
    },
  },

  // ── Colors ─────────────────────────────────────────────────────────────────

  {
    name: "calendar_get_colors",
    description:
      "Get the list of available color definitions for calendars and events. Use the returned colorId values when creating or updating calendars and events.",
    schema: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: { userId?: string },
    ) => {
      return calendarRequest(context, "GET", "/colors");
    },
  },

  // ── ACL (Access Control) ───────────────────────────────────────────────────

  {
    name: "calendar_list_acl",
    description:
      "List all access control rules (ACL) for a specific calendar. Shows who has access and at what permission level.",
    schema: z.object({
      calendarId: z.string().describe("Calendar ID to list access rules for."),
    }),
    execute: async (
      args: { calendarId: string },
      context: { userId?: string },
    ) => {
      return calendarRequest(
        context,
        "GET",
        `/calendars/${encodeURIComponent(args.calendarId)}/acl`,
      );
    },
  },

  {
    name: "calendar_create_acl",
    description:
      "Create an access control rule for a calendar to share it with a user, group, or domain.",
    schema: z.object({
      calendarId: z
        .string()
        .describe("Calendar ID to create the access rule on."),
      role: z
        .enum(["none", "freeBusyReader", "reader", "writer", "owner"])
        .describe(
          'Access level to grant. "reader" can view events. "writer" can add/edit events. "owner" has full control. "freeBusyReader" can see free/busy info only.',
        ),
      scope: z
        .object({
          type: z
            .enum(["user", "group", "domain", "default"])
            .describe(
              '"user" for a specific person, "group" for a Google Group, "domain" for an entire domain, "default" for public access.',
            ),
          value: z
            .string()
            .optional()
            .describe(
              'Email address (for user/group scope) or domain name (for domain scope). Not needed for "default" scope.',
            ),
        })
        .describe("Scope of the access rule."),
    }),
    execute: async (
      args: {
        calendarId: string;
        role: "none" | "freeBusyReader" | "reader" | "writer" | "owner";
        scope: {
          type: "user" | "group" | "domain" | "default";
          value?: string;
        };
      },
      context: { userId?: string },
    ) => {
      const body: Record<string, unknown> = {
        role: args.role,
        scope: args.scope,
      };

      const result = await calendarRequest(
        context,
        "POST",
        `/calendars/${encodeURIComponent(args.calendarId)}/acl`,
        { body },
      );
      return result;
    },
  },

  {
    name: "calendar_delete_acl",
    description:
      "Delete an access control rule from a calendar, revoking the associated access.",
    schema: z.object({
      calendarId: z.string().describe("Calendar ID that owns the access rule."),
      ruleId: z
        .string()
        .describe(
          "ID of the ACL rule to delete. Retrieve rule IDs via calendar_list_acl.",
        ),
    }),
    execute: async (
      args: { calendarId: string; ruleId: string },
      context: { userId?: string },
    ) => {
      return calendarRequest(
        context,
        "DELETE",
        `/calendars/${encodeURIComponent(args.calendarId)}/acl/${encodeURIComponent(
          args.ruleId,
        )}`,
      );
    },
  },
];

// ─── App Export ───────────────────────────────────────────────────────────────

export const calendarApp: NathraxApp = {
  appId: "google",
  displayName: "Google Calendar Integration",
  version: "2.0.0",
  tools: calendarTools,
};
