ALTER TABLE "runs" ADD COLUMN "client_ip" text;--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("created_at");