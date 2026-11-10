DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE terrains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  address TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT 'tonte',
  tasks TEXT NOT NULL DEFAULT '',
  price_per_visit REAL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id),
  title TEXT NOT NULL,
  lines TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'brouillon',
  notes TEXT NOT NULL DEFAULT '',
  surface_pi2 REAL,
  estimated_minutes REAL,
  sent_at INTEGER,
  last_followup_at INTEGER,
  request_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE quote_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  services TEXT NOT NULL DEFAULT 'tonte',
  surface_value REAL,
  surface_unit TEXT,
  size_category TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'nouvelle',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT 'tonte',
  employee_id INTEGER REFERENCES employees(id),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE route_stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES routes(id),
  terrain_id INTEGER REFERENCES terrains(id),
  position INTEGER NOT NULL,
  client_name TEXT NOT NULL,
  address TEXT NOT NULL,
  tasks TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'a_faire',
  started_at INTEGER,
  finished_at INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
