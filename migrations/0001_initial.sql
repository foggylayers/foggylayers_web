CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  payload_json TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  cart_json TEXT NOT NULL,
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('shipping', 'pickup')),
  stripe_session_id TEXT UNIQUE,
  checkout_url TEXT,
  customer_json TEXT
);
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_status_created ON requests(status, created_at);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders(status, created_at);
