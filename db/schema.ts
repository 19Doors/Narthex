import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const developers = pgTable("developers", {
  id: uuid("id").primaryKey().defaultRandom(),
  apiKey: text("api_key").unique().notNull(),
});

export const connections = pgTable("connections", {
  id: text("id").primaryKey(),
  developerId: uuid("developer_id")
    .references(() => developers.id)
    .notNull(),
  endUserId: text("end_user_id").notNull(),
  appId: text("app_id").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at"),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
});
