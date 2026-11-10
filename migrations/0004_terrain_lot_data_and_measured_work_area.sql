ALTER TABLE terrains ADD COLUMN lot_dimensions TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE terrains ADD COLUMN lot_area_pi2 REAL;
--> statement-breakpoint
ALTER TABLE terrains ADD COLUMN work_area_pi2 REAL;
--> statement-breakpoint
ALTER TABLE terrains ADD COLUMN work_polygon TEXT NOT NULL DEFAULT '';
