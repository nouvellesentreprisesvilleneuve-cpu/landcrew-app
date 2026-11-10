ALTER TABLE terrains ADD COLUMN lat REAL;
--> statement-breakpoint
ALTER TABLE terrains ADD COLUMN lng REAL;
--> statement-breakpoint
ALTER TABLE route_stops ADD COLUMN lat REAL;
--> statement-breakpoint
ALTER TABLE route_stops ADD COLUMN lng REAL;
--> statement-breakpoint
CREATE TABLE time_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  route_id INTEGER REFERENCES routes(id),
  stop_id INTEGER REFERENCES route_stops(id),
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  at INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  distance_m REAL,
  verified INTEGER
);
