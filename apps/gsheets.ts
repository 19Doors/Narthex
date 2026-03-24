import { z } from "zod";
import type { NathraxApp } from "../core/types";
import { db } from "../db";
import { connections } from "../db/schema";
import { and, eq } from "drizzle-orm";

// ─── Environment ────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const BASE_URL = process.env.BASE_URL!;

// ─── Auth helpers ────────────────────────────────────────────────────────────

async function refreshGoogleToken(
  connectionId: string,
  refreshToken: string,
): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Failed to refresh Google token: ${err}`);
  }
  const json = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };
  const expiresAt = new Date(Date.now() + json.expires_in * 1000);
  await db
    .update(connections)
    .set({ accessToken: json.access_token, expiresAt })
    .where(eq(connections.id, connectionId));
  return json.access_token;
}

// ─── Sheets request wrapper ──────────────────────────────────────────────────

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

type SheetsResult = {
  content: [{ type: "text"; text: string }];
  isError?: true;
  _raw?: unknown;
};

async function sheetsRequest(
  method: string,
  path: string,
  params?: Record<string, string | string[] | boolean | number | undefined>,
  body?: unknown,
): Promise<SheetsResult> {
  // Look up the google connection
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.appId, "google")))
    .limit(1);

  if (!conn) {
    const authUrl = `${BASE_URL}/auth/google`;
    return {
      content: [
        {
          type: "text",
          text: `No Google connection found. Please authenticate at: ${authUrl}`,
        },
      ],
      isError: true,
    };
  }

  let accessToken = conn.accessToken;

  // Build URL with query params
  const buildUrl = (token: string) => {
    const url = new URL(`${SHEETS_BASE}${path}`);
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (val === undefined || val === null) continue;
        if (Array.isArray(val)) {
          for (const v of val) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.set(key, String(val));
        }
      }
    }
    return url.toString();
  };

  const doRequest = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    return fetch(buildUrl(token), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doRequest(accessToken);

  // Auto-refresh on 401
  if (res.status === 401 && conn.refreshToken) {
    try {
      accessToken = await refreshGoogleToken(conn.id, conn.refreshToken);
      res = await doRequest(accessToken);
    } catch (e) {
      return {
        content: [{ type: "text", text: `Token refresh failed: ${String(e)}` }],
        isError: true,
      };
    }
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      content: [
        {
          type: "text",
          text: `Google Sheets API error ${res.status}: ${JSON.stringify(data, null, 2)}`,
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

// ─── ok() helper ────────────────────────────────────────────────────────────

function ok(data: unknown): SheetsResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatSpreadsheet(ss: any): object {
  return {
    spreadsheetId: ss.spreadsheetId,
    title: ss.properties?.title,
    locale: ss.properties?.locale,
    timeZone: ss.properties?.timeZone,
    sheets: (ss.sheets ?? []).map((s: any) => ({
      sheetId: s.properties?.sheetId,
      title: s.properties?.title,
      index: s.properties?.index,
      rowCount: s.properties?.gridProperties?.rowCount,
      columnCount: s.properties?.gridProperties?.columnCount,
      tabColor:
        s.properties?.tabColor ?? s.properties?.tabColorStyle?.rgbColor ?? null,
    })),
  };
}

function formatValueRange(vr: any): string {
  const range = vr.range ?? "";
  const majorDimension = vr.majorDimension ?? "ROWS";
  const values: string[][] = vr.values ?? [];

  if (values.length === 0) {
    return `Range: ${range}\nNo data found.`;
  }

  // Calculate column widths
  const colCount = Math.max(...values.map((r) => r.length));
  const colWidths: number[] = Array(colCount).fill(0);
  for (const row of values) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c], String(row[c] ?? "").length);
    }
  }

  const line = colWidths.map((w) => "-".repeat(w + 2)).join("+");
  const rows = values.map((row) =>
    colWidths
      .map((w, i) => String(row[i] ?? "").padEnd(w))
      .map((cell) => ` ${cell} `)
      .join("|"),
  );

  const header = rows[0];
  const body = rows.slice(1);

  const parts = [
    `Range: ${range} | Dimension: ${majorDimension} | Rows: ${values.length}`,
    line,
    header,
    line,
    ...body,
    line,
  ];

  return parts.join("\n");
}

// ─── App definition ──────────────────────────────────────────────────────────

export const sheetsApp: NathraxApp = {
  appId: "google",
  displayName: "Google Sheets Integration",
  version: "2.0.0",
  tools: [
    // ── Spreadsheets - Core ──────────────────────────────────────────────────

    {
      name: "sheets_create_spreadsheet",
      description:
        "Create a new Google Spreadsheet. Requires a title. Optionally accepts sheetTitles (array of tab names to create), locale, autoRecalc, and timeZone.",
      schema: z.object({
        title: z.string().describe("Title of the new spreadsheet"),
        sheetTitles: z
          .array(z.string())
          .optional()
          .describe(
            "Names of sheets/tabs to create (default: one sheet named 'Sheet1')",
          ),
        locale: z.string().optional().describe("Locale code, e.g. 'en_US'"),
        autoRecalc: z
          .enum(["ON_CHANGE", "MINUTE", "HOUR"])
          .optional()
          .describe("Recalculation interval"),
        timeZone: z
          .string()
          .optional()
          .describe("Time zone, e.g. 'America/New_York'"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const properties: Record<string, unknown> = { title: args.title };
        if (args.locale) properties.locale = args.locale;
        if (args.autoRecalc) properties.autoRecalc = args.autoRecalc;
        if (args.timeZone) properties.timeZone = args.timeZone;

        const sheets =
          args.sheetTitles && args.sheetTitles.length > 0
            ? args.sheetTitles.map((t: string, i: number) => ({
                properties: { title: t, index: i },
              }))
            : undefined;

        const result = await sheetsRequest("POST", "", undefined, {
          properties,
          ...(sheets ? { sheets } : {}),
        });

        if (result.isError) return result;
        const data = result._raw as any;
        return ok(formatSpreadsheet(data));
      },
    },

    {
      name: "sheets_get_spreadsheet",
      description:
        "Get spreadsheet metadata, sheet names, row/column counts. Optionally include data for specific ranges by passing 'ranges' (A1 notation). Set includeGridData=true to return actual cell data when ranges are provided.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        ranges: z
          .array(z.string())
          .optional()
          .describe("Ranges to include grid data for, e.g. ['Sheet1!A1:D10']"),
        includeGridData: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether to include cell data (default false)"),
        fields: z
          .string()
          .optional()
          .describe("FieldMask for partial response, e.g. 'sheets.properties'"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const params: Record<string, any> = {};
        if (args.ranges) params["ranges"] = args.ranges;
        if (args.includeGridData) params["includeGridData"] = "true";
        if (args.fields) params["fields"] = args.fields;

        const result = await sheetsRequest(
          "GET",
          `/${args.spreadsheetId}`,
          params,
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return ok(formatSpreadsheet(data));
      },
    },

    {
      name: "sheets_get_spreadsheet_by_data_filter",
      description:
        "Get a spreadsheet by applying one or more data filters. Useful for retrieving only specific sheets or ranges.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        dataFilters: z
          .array(z.any())
          .describe(
            "Array of DataFilter objects, e.g. [{ 'gridRange': { 'sheetId': 0 } }] or [{ 'a1Range': 'Sheet1!A1:C10' }]",
          ),
        includeGridData: z.boolean().optional().default(false),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:getByDataFilter`,
          undefined,
          {
            dataFilters: args.dataFilters,
            includeGridData: args.includeGridData ?? false,
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return ok(formatSpreadsheet(data));
      },
    },

    // ── Values ───────────────────────────────────────────────────────────────

    {
      name: "sheets_get_values",
      description:
        "Read values from a range using A1 notation (e.g. 'Sheet1!A1:D10' or 'Sheet1'). Returns a formatted text table.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        range: z
          .string()
          .describe("A1 notation range, e.g. 'Sheet1!A1:D10' or 'Sheet1'"),
        majorDimension: z
          .enum(["ROWS", "COLUMNS"])
          .optional()
          .default("ROWS")
          .describe("Whether values are organized by rows or columns"),
        valueRenderOption: z
          .enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])
          .optional()
          .default("FORMATTED_VALUE")
          .describe("How values should be rendered"),
        dateTimeRenderOption: z
          .enum(["SERIAL_NUMBER", "FORMATTED_STRING"])
          .optional()
          .default("FORMATTED_STRING")
          .describe("How date/time values should be rendered"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const params: Record<string, any> = {};
        if (args.majorDimension) params.majorDimension = args.majorDimension;
        if (args.valueRenderOption)
          params.valueRenderOption = args.valueRenderOption;
        if (args.dateTimeRenderOption)
          params.dateTimeRenderOption = args.dateTimeRenderOption;

        const encodedRange = encodeURIComponent(args.range);
        const result = await sheetsRequest(
          "GET",
          `/${args.spreadsheetId}/values/${encodedRange}`,
          params,
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return {
          content: [{ type: "text", text: formatValueRange(data) }],
          _raw: data,
        };
      },
    },

    {
      name: "sheets_batch_get_values",
      description:
        "Read multiple ranges at once. More efficient than multiple individual reads. Returns formatted tables for each range.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        ranges: z
          .array(z.string())
          .describe(
            "Array of A1 notation ranges, e.g. ['Sheet1!A1:C5', 'Sheet2!B2:D8']",
          ),
        majorDimension: z.enum(["ROWS", "COLUMNS"]).optional().default("ROWS"),
        valueRenderOption: z
          .enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])
          .optional()
          .default("FORMATTED_VALUE"),
        dateTimeRenderOption: z
          .enum(["SERIAL_NUMBER", "FORMATTED_STRING"])
          .optional()
          .default("FORMATTED_STRING"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const params: Record<string, any> = { ranges: args.ranges };
        if (args.majorDimension) params.majorDimension = args.majorDimension;
        if (args.valueRenderOption)
          params.valueRenderOption = args.valueRenderOption;
        if (args.dateTimeRenderOption)
          params.dateTimeRenderOption = args.dateTimeRenderOption;

        const result = await sheetsRequest(
          "GET",
          `/${args.spreadsheetId}/values:batchGet`,
          params,
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const valueRanges: any[] = data.valueRanges ?? [];
        const formatted = valueRanges.map(formatValueRange).join("\n\n---\n\n");
        return { content: [{ type: "text", text: formatted }], _raw: data };
      },
    },

    {
      name: "sheets_update_values",
      description:
        "Write values to a specific range. Use valueInputOption=USER_ENTERED to parse formulas and dates; use RAW to write literal strings.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        range: z.string().describe("A1 notation range, e.g. 'Sheet1!A1:C3'"),
        values: z
          .array(z.array(z.any()))
          .describe("2D array of values. Outer array = rows, inner = columns."),
        majorDimension: z.enum(["ROWS", "COLUMNS"]).optional().default("ROWS"),
        valueInputOption: z
          .enum(["RAW", "USER_ENTERED"])
          .optional()
          .default("USER_ENTERED")
          .describe(
            "RAW = literal values; USER_ENTERED = parse formulas/dates",
          ),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const encodedRange = encodeURIComponent(args.range);
        const result = await sheetsRequest(
          "PUT",
          `/${args.spreadsheetId}/values/${encodedRange}`,
          { valueInputOption: args.valueInputOption ?? "USER_ENTERED" },
          {
            range: args.range,
            majorDimension: args.majorDimension ?? "ROWS",
            values: args.values,
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return ok({
          updatedRange: data.updatedRange,
          updatedRows: data.updatedRows,
          updatedColumns: data.updatedColumns,
          updatedCells: data.updatedCells,
        });
      },
    },

    {
      name: "sheets_batch_update_values",
      description:
        "Write values to multiple ranges in a single request. More efficient than multiple individual writes.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        data: z
          .array(
            z.object({
              range: z.string().describe("A1 notation range"),
              values: z.array(z.array(z.any())).describe("2D array of values"),
              majorDimension: z
                .enum(["ROWS", "COLUMNS"])
                .optional()
                .default("ROWS"),
            }),
          )
          .describe("Array of range+values objects to write"),
        valueInputOption: z
          .enum(["RAW", "USER_ENTERED"])
          .optional()
          .default("USER_ENTERED"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}/values:batchUpdate`,
          undefined,
          {
            valueInputOption: args.valueInputOption ?? "USER_ENTERED",
            data: args.data,
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return ok({
          totalUpdatedRows: data.totalUpdatedRows,
          totalUpdatedColumns: data.totalUpdatedColumns,
          totalUpdatedCells: data.totalUpdatedCells,
          responses: (data.responses ?? []).map((r: any) => ({
            updatedRange: r.updatedRange,
            updatedRows: r.updatedRows,
            updatedColumns: r.updatedColumns,
            updatedCells: r.updatedCells,
          })),
        });
      },
    },

    {
      name: "sheets_append_values",
      description:
        "Append rows after the last row with data in the specified table range. Perfect for adding new records to a dataset.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        range: z
          .string()
          .describe(
            "A1 notation that identifies the table, e.g. 'Sheet1!A:E' or 'Sheet1!A1'",
          ),
        values: z
          .array(z.array(z.any()))
          .describe("2D array of rows/values to append"),
        valueInputOption: z
          .enum(["RAW", "USER_ENTERED"])
          .optional()
          .default("USER_ENTERED"),
        insertDataOption: z
          .enum(["OVERWRITE", "INSERT_ROWS"])
          .optional()
          .default("INSERT_ROWS")
          .describe(
            "INSERT_ROWS inserts blank rows; OVERWRITE overwrites existing data",
          ),
        includeValuesInResponse: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether to return the appended values in the response"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const encodedRange = encodeURIComponent(args.range);
        const params: Record<string, any> = {
          valueInputOption: args.valueInputOption ?? "USER_ENTERED",
          insertDataOption: args.insertDataOption ?? "INSERT_ROWS",
        };
        if (args.includeValuesInResponse)
          params.includeValuesInResponse = "true";

        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}/values/${encodedRange}:append`,
          params,
          {
            range: args.range,
            majorDimension: "ROWS",
            values: args.values,
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const updates = data.updates ?? {};
        return ok({
          tableRange: data.tableRange,
          updatedRange: updates.updatedRange,
          updatedRows: updates.updatedRows,
          updatedColumns: updates.updatedColumns,
          updatedCells: updates.updatedCells,
        });
      },
    },

    {
      name: "sheets_clear_values",
      description:
        "Clear all values in a specified range. The formatting is preserved; only the data is removed.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        range: z
          .string()
          .describe("A1 notation range to clear, e.g. 'Sheet1!A1:D10'"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const encodedRange = encodeURIComponent(args.range);
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}/values/${encodedRange}:clear`,
          undefined,
          {},
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return ok({
          clearedRange: data.clearedRange,
          spreadsheetId: data.spreadsheetId,
        });
      },
    },

    {
      name: "sheets_batch_clear_values",
      description:
        "Clear values from multiple ranges at once. More efficient than multiple individual clears.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        ranges: z
          .array(z.string())
          .describe("Array of A1 notation ranges to clear"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}/values:batchClear`,
          undefined,
          { ranges: args.ranges },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return ok({
          clearedRanges: data.clearedRanges,
          spreadsheetId: data.spreadsheetId,
        });
      },
    },

    // ── Batch Update (structural) ─────────────────────────────────────────────

    {
      name: "sheets_batch_update",
      description: `Perform structural spreadsheet changes via the Sheets batchUpdate API. This is the Swiss army knife for anything that modifies spreadsheet structure or formatting.

Common request types (pass as the 'requests' array):
- addSheet: { addSheet: { properties: { title, index, tabColor } } }
- deleteSheet: { deleteSheet: { sheetId: <number> } }
- duplicateSheet: { duplicateSheet: { sourceSheetId, insertSheetIndex, newSheetName } }
- updateSheetProperties: { updateSheetProperties: { properties: { sheetId, title, index, tabColor, gridProperties: { rowCount, columnCount, frozenRowCount, frozenColumnCount } }, fields: "title,index" } }
- updateCells: { updateCells: { rows: [{ values: [{ userEnteredValue, userEnteredFormat }] }], fields: "userEnteredValue,userEnteredFormat", start: { sheetId, rowIndex, columnIndex } } }
- repeatCell: { repeatCell: { range: { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex }, cell: { userEnteredFormat: { ... } }, fields: "userEnteredFormat" } }
- autoFill: { autoFill: { ... } }
- copyPaste: { copyPaste: { source, destination, pasteType, pasteOrientation } }
- cutPaste: { cutPaste: { source, destination, pasteType } }
- mergeCells: { mergeCells: { range: { sheetId, ... }, mergeType: "MERGE_ALL" } }
- unmergeCells: { unmergeCells: { range: { sheetId, ... } } }
- updateBorders: { updateBorders: { range, top, bottom, left, right, innerHorizontal, innerVertical } }
- addConditionalFormatRule: { addConditionalFormatRule: { rule: { ranges, booleanRule: { condition, format } }, index: 0 } }
- setDataValidation: { setDataValidation: { range, rule: { condition, inputMessage, strict, showCustomUi } } }
- sortRange: { sortRange: { range, sortSpecs: [{ dimensionIndex, sortOrder }] } }
- insertDimension: { insertDimension: { range: { sheetId, dimension: "ROWS", startIndex, endIndex }, inheritFromBefore } }
- deleteDimension: { deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex, endIndex } } }
- updateDimensionProperties: { updateDimensionProperties: { range: { sheetId, dimension, startIndex, endIndex }, properties: { pixelSize, hiddenByUser }, fields: "pixelSize" } }
- autoResizeDimensions: { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex, endIndex } } }
- addChart: { addChart: { chart: { spec, position } } }
- addFilterView: { addFilterView: { filter: { title, range, sortSpecs, filterSpecs } } }
- deleteFilterView: { deleteFilterView: { filterId } }
- addProtectedRange: { addProtectedRange: { protectedRange: { range, description, warningOnly } } }
- deleteProtectedRange: { deleteProtectedRange: { protectedRangeId } }
- addNamedRange: { addNamedRange: { namedRange: { name, range } } }
- deleteNamedRange: { deleteNamedRange: { namedRangeId } }`,
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        requests: z
          .array(z.any())
          .describe(
            "Array of request objects. See tool description for common types.",
          ),
        includeSpreadsheetInResponse: z.boolean().optional().default(false),
        responseRanges: z.array(z.string()).optional(),
        responseIncludeGridData: z.boolean().optional().default(false),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: args.requests,
            includeSpreadsheetInResponse:
              args.includeSpreadsheetInResponse ?? false,
            responseRanges: args.responseRanges,
            responseIncludeGridData: args.responseIncludeGridData ?? false,
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const output: Record<string, unknown> = {
          spreadsheetId: data.spreadsheetId,
          replies: data.replies,
        };
        if (data.updatedSpreadsheet) {
          output.updatedSpreadsheet = formatSpreadsheet(
            data.updatedSpreadsheet,
          );
        }
        return ok(output);
      },
    },

    // ── High-level sheet tab helpers ──────────────────────────────────────────

    {
      name: "sheets_add_sheet",
      description:
        "Add a new sheet (tab) to an existing spreadsheet. Returns the new sheet's properties including its numeric sheetId.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        title: z.string().describe("Name for the new sheet tab"),
        index: z
          .number()
          .int()
          .optional()
          .describe("Position to insert (0-based). Omit to add at end."),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const properties: Record<string, unknown> = { title: args.title };
        if (args.index !== undefined) properties.index = args.index;

        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          { requests: [{ addSheet: { properties } }] },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const reply = data.replies?.[0]?.addSheet ?? {};
        return ok({
          sheetId: reply.properties?.sheetId,
          title: reply.properties?.title,
          index: reply.properties?.index,
          rowCount: reply.properties?.gridProperties?.rowCount,
          columnCount: reply.properties?.gridProperties?.columnCount,
        });
      },
    },

    {
      name: "sheets_delete_sheet",
      description:
        "Delete a sheet/tab by its numeric sheetId. To find sheetId, use sheets_get_spreadsheet.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID to delete"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          { requests: [{ deleteSheet: { sheetId: args.sheetId } }] },
        );

        if (result.isError) return result;
        return ok({ deleted: true, sheetId: args.sheetId });
      },
    },

    {
      name: "sheets_rename_sheet",
      description: "Rename a sheet/tab by its numeric sheetId.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID to rename"),
        newTitle: z.string().describe("New name for the sheet tab"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: args.sheetId, title: args.newTitle },
                  fields: "title",
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        return ok({
          renamed: true,
          sheetId: args.sheetId,
          newTitle: args.newTitle,
        });
      },
    },

    {
      name: "sheets_duplicate_sheet",
      description: "Duplicate a sheet within the same spreadsheet.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z
          .number()
          .int()
          .describe("Numeric ID of the sheet to duplicate"),
        newName: z
          .string()
          .optional()
          .describe("Name for the new duplicate sheet"),
        insertIndex: z
          .number()
          .int()
          .optional()
          .describe("Index to insert the duplicate at (0-based)"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const req: Record<string, unknown> = { sourceSheetId: args.sheetId };
        if (args.newName) req.newSheetName = args.newName;
        if (args.insertIndex !== undefined)
          req.insertSheetIndex = args.insertIndex;

        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          { requests: [{ duplicateSheet: req }] },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const props = data.replies?.[0]?.duplicateSheet?.properties ?? {};
        return ok({
          newSheetId: props.sheetId,
          title: props.title,
          index: props.index,
        });
      },
    },

    {
      name: "sheets_copy_sheet_to",
      description:
        "Copy a sheet to a different spreadsheet. Returns the newly created sheet's properties in the destination spreadsheet.",
      schema: z.object({
        spreadsheetId: z.string().describe("Source spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric ID of the sheet to copy"),
        destinationSpreadsheetId: z.string().describe("Target spreadsheet ID"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}/sheets/${args.sheetId}:copyTo`,
          undefined,
          { destinationSpreadsheetId: args.destinationSpreadsheetId },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return ok({
          newSheetId: data.sheetId,
          title: data.title,
          index: data.index,
          rowCount: data.gridProperties?.rowCount,
          columnCount: data.gridProperties?.columnCount,
        });
      },
    },

    // ── Formatting helpers ────────────────────────────────────────────────────

    {
      name: "sheets_auto_resize_columns",
      description:
        "Auto-resize columns to fit their content width. Optionally specify a column range.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startIndex: z
          .number()
          .int()
          .optional()
          .describe("First column index to resize (0-based, default 0)"),
        endIndex: z
          .number()
          .int()
          .optional()
          .describe("Last column index exclusive (default = all columns)"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const dimensions: Record<string, unknown> = {
          sheetId: args.sheetId,
          dimension: "COLUMNS",
        };
        if (args.startIndex !== undefined)
          dimensions.startIndex = args.startIndex;
        if (args.endIndex !== undefined) dimensions.endIndex = args.endIndex;

        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          { requests: [{ autoResizeDimensions: { dimensions } }] },
        );

        if (result.isError) return result;
        return ok({ autoResized: true, sheetId: args.sheetId });
      },
    },

    {
      name: "sheets_format_cells",
      description:
        "Apply formatting to a range of cells: bold, italic, font size, text color, background color, horizontal alignment, or number format.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startRowIndex: z.number().int().describe("First row (0-based)"),
        endRowIndex: z.number().int().describe("Last row exclusive"),
        startColumnIndex: z.number().int().describe("First column (0-based)"),
        endColumnIndex: z.number().int().describe("Last column exclusive"),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        fontSize: z.number().optional(),
        foregroundColor: z
          .object({
            red: z.number().min(0).max(1),
            green: z.number().min(0).max(1),
            blue: z.number().min(0).max(1),
            alpha: z.number().min(0).max(1).optional(),
          })
          .optional()
          .describe("Text color as RGBA (0-1 range)"),
        backgroundColor: z
          .object({
            red: z.number().min(0).max(1),
            green: z.number().min(0).max(1),
            blue: z.number().min(0).max(1),
            alpha: z.number().min(0).max(1).optional(),
          })
          .optional()
          .describe("Cell background color as RGBA (0-1 range)"),
        horizontalAlignment: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
        numberFormat: z
          .object({
            type: z.enum([
              "TEXT",
              "NUMBER",
              "PERCENT",
              "CURRENCY",
              "DATE",
              "TIME",
              "DATE_TIME",
              "SCIENTIFIC",
            ]),
            pattern: z
              .string()
              .optional()
              .describe("Pattern string, e.g. '0.00' or 'MM/dd/yyyy'"),
          })
          .optional(),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const fmt: Record<string, unknown> = {};
        const fields: string[] = [];

        if (
          args.bold !== undefined ||
          args.italic !== undefined ||
          args.fontSize !== undefined ||
          args.foregroundColor !== undefined
        ) {
          const textFormat: Record<string, unknown> = {};
          if (args.bold !== undefined) textFormat.bold = args.bold;
          if (args.italic !== undefined) textFormat.italic = args.italic;
          if (args.fontSize !== undefined) textFormat.fontSize = args.fontSize;
          if (args.foregroundColor !== undefined)
            textFormat.foregroundColor = args.foregroundColor;
          fmt.textFormat = textFormat;
          fields.push("userEnteredFormat.textFormat");
        }
        if (args.backgroundColor !== undefined) {
          fmt.backgroundColor = args.backgroundColor;
          fields.push("userEnteredFormat.backgroundColor");
        }
        if (args.horizontalAlignment !== undefined) {
          fmt.horizontalAlignment = args.horizontalAlignment;
          fields.push("userEnteredFormat.horizontalAlignment");
        }
        if (args.numberFormat !== undefined) {
          fmt.numberFormat = args.numberFormat;
          fields.push("userEnteredFormat.numberFormat");
        }

        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId: args.sheetId,
                    startRowIndex: args.startRowIndex,
                    endRowIndex: args.endRowIndex,
                    startColumnIndex: args.startColumnIndex,
                    endColumnIndex: args.endColumnIndex,
                  },
                  cell: { userEnteredFormat: fmt },
                  fields: fields.join(",") || "userEnteredFormat",
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        return ok({ formatted: true, appliedFields: fields });
      },
    },

    {
      name: "sheets_merge_cells",
      description:
        "Merge a range of cells. MERGE_ALL merges everything into one; MERGE_COLUMNS merges each column independently; MERGE_ROWS merges each row independently.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startRowIndex: z.number().int(),
        endRowIndex: z.number().int(),
        startColumnIndex: z.number().int(),
        endColumnIndex: z.number().int(),
        mergeType: z
          .enum(["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"])
          .default("MERGE_ALL"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                mergeCells: {
                  range: {
                    sheetId: args.sheetId,
                    startRowIndex: args.startRowIndex,
                    endRowIndex: args.endRowIndex,
                    startColumnIndex: args.startColumnIndex,
                    endColumnIndex: args.endColumnIndex,
                  },
                  mergeType: args.mergeType ?? "MERGE_ALL",
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        return ok({ merged: true, mergeType: args.mergeType ?? "MERGE_ALL" });
      },
    },

    {
      name: "sheets_unmerge_cells",
      description: "Unmerge previously merged cells in a range.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startRowIndex: z.number().int(),
        endRowIndex: z.number().int(),
        startColumnIndex: z.number().int(),
        endColumnIndex: z.number().int(),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                unmergeCells: {
                  range: {
                    sheetId: args.sheetId,
                    startRowIndex: args.startRowIndex,
                    endRowIndex: args.endRowIndex,
                    startColumnIndex: args.startColumnIndex,
                    endColumnIndex: args.endColumnIndex,
                  },
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        return ok({ unmerged: true });
      },
    },

    {
      name: "sheets_add_conditional_formatting",
      description:
        "Add a conditional formatting rule to a range. Supports condition types like NUMBER_GREATER, NUMBER_LESS, TEXT_CONTAINS, TEXT_EQ, CUSTOM_FORMULA, BLANK, NOT_BLANK, etc.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startRowIndex: z.number().int(),
        endRowIndex: z.number().int(),
        startColumnIndex: z.number().int(),
        endColumnIndex: z.number().int(),
        conditionType: z
          .string()
          .describe(
            "Condition type: NUMBER_GREATER, NUMBER_LESS, NUMBER_EQ, TEXT_CONTAINS, TEXT_EQ, CUSTOM_FORMULA, BLANK, NOT_BLANK, etc.",
          ),
        conditionValues: z
          .array(z.string())
          .optional()
          .describe(
            "Values for the condition (e.g. ['100'] for NUMBER_GREATER)",
          ),
        backgroundColor: z
          .object({
            red: z.number().min(0).max(1),
            green: z.number().min(0).max(1),
            blue: z.number().min(0).max(1),
          })
          .optional(),
        textFormat: z
          .object({
            bold: z.boolean().optional(),
            italic: z.boolean().optional(),
            foregroundColor: z
              .object({
                red: z.number().min(0).max(1),
                green: z.number().min(0).max(1),
                blue: z.number().min(0).max(1),
              })
              .optional(),
          })
          .optional(),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const condition: Record<string, unknown> = { type: args.conditionType };
        if (args.conditionValues?.length) {
          condition.values = args.conditionValues.map((v: string) => ({
            userEnteredValue: v,
          }));
        }

        const format: Record<string, unknown> = {};
        if (args.backgroundColor) format.backgroundColor = args.backgroundColor;
        if (args.textFormat) format.textFormat = args.textFormat;

        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                addConditionalFormatRule: {
                  rule: {
                    ranges: [
                      {
                        sheetId: args.sheetId,
                        startRowIndex: args.startRowIndex,
                        endRowIndex: args.endRowIndex,
                        startColumnIndex: args.startColumnIndex,
                        endColumnIndex: args.endColumnIndex,
                      },
                    ],
                    booleanRule: { condition, format },
                  },
                  index: 0,
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        return ok({ added: true, conditionType: args.conditionType });
      },
    },

    {
      name: "sheets_add_protected_range",
      description:
        "Protect a range from being edited. Set warningOnly=true to show a warning but still allow edits.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startRowIndex: z.number().int(),
        endRowIndex: z.number().int(),
        startColumnIndex: z.number().int(),
        endColumnIndex: z.number().int(),
        description: z
          .string()
          .optional()
          .describe("Description of the protection"),
        warningOnly: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, only warns on edit but doesn't block"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                addProtectedRange: {
                  protectedRange: {
                    range: {
                      sheetId: args.sheetId,
                      startRowIndex: args.startRowIndex,
                      endRowIndex: args.endRowIndex,
                      startColumnIndex: args.startColumnIndex,
                      endColumnIndex: args.endColumnIndex,
                    },
                    description: args.description ?? "",
                    warningOnly: args.warningOnly ?? false,
                  },
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const pr = data.replies?.[0]?.addProtectedRange?.protectedRange ?? {};
        return ok({
          protectedRangeId: pr.protectedRangeId,
          description: pr.description,
          warningOnly: pr.warningOnly,
        });
      },
    },

    {
      name: "sheets_sort_range",
      description: "Sort a range of cells by one or more columns.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startRowIndex: z.number().int(),
        endRowIndex: z.number().int(),
        startColumnIndex: z.number().int(),
        endColumnIndex: z.number().int(),
        sortSpecs: z
          .array(
            z.object({
              dimensionIndex: z
                .number()
                .int()
                .describe(
                  "Column index to sort by (0-based, relative to startColumnIndex)",
                ),
              sortOrder: z
                .enum(["ASCENDING", "DESCENDING"])
                .default("ASCENDING"),
            }),
          )
          .describe("Sort specifications in priority order"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                sortRange: {
                  range: {
                    sheetId: args.sheetId,
                    startRowIndex: args.startRowIndex,
                    endRowIndex: args.endRowIndex,
                    startColumnIndex: args.startColumnIndex,
                    endColumnIndex: args.endColumnIndex,
                  },
                  sortSpecs: args.sortSpecs,
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        return ok({ sorted: true, sortSpecs: args.sortSpecs });
      },
    },

    {
      name: "sheets_create_chart",
      description:
        "Create a chart embedded in a sheet. Supports BAR, LINE, AREA, COLUMN, SCATTER, COMBO, STEPPED_AREA, PIE chart types.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Sheet to embed the chart in"),
        chartType: z
          .enum([
            "BAR",
            "LINE",
            "AREA",
            "COLUMN",
            "SCATTER",
            "COMBO",
            "STEPPED_AREA",
            "PIE",
          ])
          .describe("Type of chart to create"),
        title: z.string().optional().describe("Chart title"),
        sourceSheetId: z
          .number()
          .int()
          .describe("Sheet ID where the source data lives"),
        sourceStartRowIndex: z.number().int(),
        sourceEndRowIndex: z.number().int(),
        sourceStartColumnIndex: z.number().int(),
        sourceEndColumnIndex: z.number().int(),
        position: z
          .object({
            overlayPosition: z
              .object({
                anchorCell: z.object({
                  sheetId: z.number().int(),
                  rowIndex: z.number().int(),
                  columnIndex: z.number().int(),
                }),
                offsetXPixels: z.number().optional(),
                offsetYPixels: z.number().optional(),
                widthPixels: z.number().optional(),
                heightPixels: z.number().optional(),
              })
              .optional(),
          })
          .optional()
          .describe("Chart position. Defaults to overlay at A1."),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const chartSpec: Record<string, unknown> = {
          title: args.title ?? "",
          basicChart: {
            chartType: args.chartType,
            series: [
              {
                series: {
                  sourceRange: {
                    sources: [
                      {
                        sheetId: args.sourceSheetId,
                        startRowIndex: args.sourceStartRowIndex,
                        endRowIndex: args.sourceEndRowIndex,
                        startColumnIndex: args.sourceStartColumnIndex,
                        endColumnIndex: args.sourceEndColumnIndex,
                      },
                    ],
                  },
                },
              },
            ],
            domains: [
              {
                domain: {
                  sourceRange: {
                    sources: [
                      {
                        sheetId: args.sourceSheetId,
                        startRowIndex: args.sourceStartRowIndex,
                        endRowIndex: args.sourceEndRowIndex,
                        startColumnIndex: args.sourceStartColumnIndex,
                        endColumnIndex: args.sourceStartColumnIndex + 1,
                      },
                    ],
                  },
                },
              },
            ],
            headerCount: 1,
          },
        };

        const position = args.position ?? {
          overlayPosition: {
            anchorCell: { sheetId: args.sheetId, rowIndex: 1, columnIndex: 1 },
          },
        };

        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [{ addChart: { chart: { spec: chartSpec, position } } }],
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const chart = data.replies?.[0]?.addChart?.chart ?? {};
        return ok({
          chartId: chart.chartId,
          chartType: args.chartType,
          title: args.title,
        });
      },
    },

    {
      name: "sheets_add_filter_view",
      description:
        "Create a filter view (saved filter) on a range. Filter views let you sort/filter data without affecting other viewers.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        title: z.string().describe("Name for the filter view"),
        startRowIndex: z.number().int(),
        endRowIndex: z.number().int(),
        startColumnIndex: z.number().int(),
        endColumnIndex: z.number().int(),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                addFilterView: {
                  filter: {
                    title: args.title,
                    range: {
                      sheetId: args.sheetId,
                      startRowIndex: args.startRowIndex,
                      endRowIndex: args.endRowIndex,
                      startColumnIndex: args.startColumnIndex,
                      endColumnIndex: args.endColumnIndex,
                    },
                  },
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const fv = data.replies?.[0]?.addFilterView?.filter ?? {};
        return ok({ filterViewId: fv.filterViewId, title: fv.title });
      },
    },

    {
      name: "sheets_set_data_validation",
      description:
        "Set data validation rules on a range. Supports ONE_OF_LIST (dropdown), ONE_OF_RANGE, NUMBER_BETWEEN, NUMBER_EQ, TEXT_CONTAINS, CUSTOM_FORMULA, etc.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startRowIndex: z.number().int(),
        endRowIndex: z.number().int(),
        startColumnIndex: z.number().int(),
        endColumnIndex: z.number().int(),
        conditionType: z
          .string()
          .describe(
            "Validation condition type: ONE_OF_LIST, ONE_OF_RANGE, NUMBER_BETWEEN, NUMBER_EQ, TEXT_CONTAINS, CUSTOM_FORMULA, etc.",
          ),
        conditionValues: z
          .array(z.string())
          .optional()
          .describe(
            "Values for the condition (e.g. ['Yes', 'No'] for ONE_OF_LIST)",
          ),
        strict: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to reject invalid input"),
        showCustomUi: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to show a dropdown/calendar UI for validation"),
        inputMessage: z
          .string()
          .optional()
          .describe("Help text shown when cell is selected"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const condition: Record<string, unknown> = { type: args.conditionType };
        if (args.conditionValues?.length) {
          condition.values = args.conditionValues.map((v: string) => ({
            userEnteredValue: v,
          }));
        }

        const rule: Record<string, unknown> = {
          condition,
          strict: args.strict ?? true,
          showCustomUi: args.showCustomUi ?? true,
        };
        if (args.inputMessage) rule.inputMessage = args.inputMessage;

        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                setDataValidation: {
                  range: {
                    sheetId: args.sheetId,
                    startRowIndex: args.startRowIndex,
                    endRowIndex: args.endRowIndex,
                    startColumnIndex: args.startColumnIndex,
                    endColumnIndex: args.endColumnIndex,
                  },
                  rule,
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        return ok({ validationSet: true, conditionType: args.conditionType });
      },
    },

    // ── Developer Metadata ────────────────────────────────────────────────────

    {
      name: "sheets_search_developer_metadata",
      description:
        "Search for developer metadata attached to the spreadsheet (spreadsheet-level, sheet-level, or cell-level metadata).",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        dataFilters: z
          .array(z.any())
          .describe(
            "Array of DataFilter objects to match metadata. e.g. [{ developerMetadataLookup: { metadataKey: 'myKey' } }]",
          ),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}/developerMetadata:search`,
          undefined,
          { dataFilters: args.dataFilters },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        return ok({
          matchedDeveloperMetadata: data.matchedDeveloperMetadata ?? [],
        });
      },
    },

    // ── Named Ranges ──────────────────────────────────────────────────────────

    {
      name: "sheets_add_named_range",
      description:
        "Create a named range (a named reference to a cell range). Named ranges can be used in formulas like =SUM(myRange).",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        name: z.string().describe("Name for the range (e.g. 'SalesData')"),
        sheetId: z.number().int().describe("Numeric sheet ID"),
        startRowIndex: z.number().int(),
        endRowIndex: z.number().int(),
        startColumnIndex: z.number().int(),
        endColumnIndex: z.number().int(),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              {
                addNamedRange: {
                  namedRange: {
                    name: args.name,
                    range: {
                      sheetId: args.sheetId,
                      startRowIndex: args.startRowIndex,
                      endRowIndex: args.endRowIndex,
                      startColumnIndex: args.startColumnIndex,
                      endColumnIndex: args.endColumnIndex,
                    },
                  },
                },
              },
            ],
          },
        );

        if (result.isError) return result;
        const data = result._raw as any;
        const nr = data.replies?.[0]?.addNamedRange?.namedRange ?? {};
        return ok({ namedRangeId: nr.namedRangeId, name: nr.name });
      },
    },

    {
      name: "sheets_delete_named_range",
      description:
        "Delete a named range by its ID. To find namedRangeId, use sheets_get_spreadsheet and inspect the namedRanges field.",
      schema: z.object({
        spreadsheetId: z.string().describe("The spreadsheet ID"),
        namedRangeId: z.string().describe("ID of the named range to delete"),
      }),
      async execute(args: any, _context: any): Promise<SheetsResult> {
        const result = await sheetsRequest(
          "POST",
          `/${args.spreadsheetId}:batchUpdate`,
          undefined,
          {
            requests: [
              { deleteNamedRange: { namedRangeId: args.namedRangeId } },
            ],
          },
        );

        if (result.isError) return result;
        return ok({ deleted: true, namedRangeId: args.namedRangeId });
      },
    },
  ],
};
