CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"developer_id" uuid NOT NULL,
	"end_user_id" text NOT NULL,
	"app_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "developers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key" text NOT NULL,
	CONSTRAINT "developers_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_developer_id_developers_id_fk" FOREIGN KEY ("developer_id") REFERENCES "public"."developers"("id") ON DELETE no action ON UPDATE no action;