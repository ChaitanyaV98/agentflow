-- Runs once, when the database volume is first created.
--
-- Two separate things live in this database:
--  1. public.*  — AgentFlow's own tables (runs, run_events), created by Drizzle migrations.
--  2. shop.*    — a sample store the agent can query through the Postgres MCP server.
--
-- The agent's SQL tool connects as `agentflow_reader`, which can only SELECT from shop.*, and
-- every session is read-only with a statement timeout. Even a prompt-injected "DROP TABLE" fails
-- at the database, whatever the app code does.

CREATE SCHEMA shop;

CREATE TABLE shop.categories (id int PRIMARY KEY, name text NOT NULL);
CREATE TABLE shop.products (
  id int PRIMARY KEY,
  name text NOT NULL,
  category_id int NOT NULL REFERENCES shop.categories(id),
  price_cents int NOT NULL
);
CREATE TABLE shop.customers (
  id int PRIMARY KEY,
  name text NOT NULL,
  city text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE shop.orders (
  id int PRIMARY KEY,
  customer_id int NOT NULL REFERENCES shop.customers(id),
  status text NOT NULL CHECK (status IN ('paid', 'refunded', 'pending')),
  created_at timestamptz NOT NULL
);
CREATE TABLE shop.order_items (
  order_id int NOT NULL REFERENCES shop.orders(id),
  product_id int NOT NULL REFERENCES shop.products(id),
  quantity int NOT NULL,
  unit_price_cents int NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX ON shop.orders (created_at);
CREATE INDEX ON shop.order_items (product_id);

COMMENT ON TABLE shop.orders IS 'One row per checkout. Revenue counts only status = paid.';
COMMENT ON COLUMN shop.order_items.unit_price_cents IS 'Price paid per unit, in cents (INR paise).';

-- Deterministic sample data (no random()), so eval answers stay stable. Dates are relative to the
-- day the database was created, so "last month" questions always have data.
INSERT INTO shop.categories VALUES
  (1, 'Laptops'), (2, 'Phones'), (3, 'Audio'), (4, 'Accessories'), (5, 'Wearables'), (6, 'Home');

INSERT INTO shop.products (id, name, category_id, price_cents)
SELECT i,
       (ARRAY['Laptops','Phones','Audio','Accessories','Wearables','Home'])[1 + (i - 1) % 6] || ' item ' || i,
       1 + (i - 1) % 6,
       (ARRAY[6500000, 3200000, 450000, 120000, 900000, 250000])[1 + (i - 1) % 6] + (i * 1700) % 50000
FROM generate_series(1, 36) AS i;

INSERT INTO shop.customers (id, name, city, created_at)
SELECT i,
       'Customer ' || i,
       (ARRAY['Hyderabad','Bengaluru','Mumbai','Delhi','Chennai','Pune'])[1 + (i * 7) % 6],
       now() - ((i * 3) % 365) * interval '1 day'
FROM generate_series(1, 200) AS i;

INSERT INTO shop.orders (id, customer_id, status, created_at)
SELECT i,
       1 + (i * 37) % 200,
       CASE WHEN i % 17 = 0 THEN 'refunded' WHEN i % 23 = 0 THEN 'pending' ELSE 'paid' END,
       now() - ((i * 13) % 120) * interval '1 day' - ((i * 7) % 24) * interval '1 hour'
FROM generate_series(1, 1500) AS i;

INSERT INTO shop.order_items (order_id, product_id, quantity, unit_price_cents)
SELECT o.id, p.id, 1 + (o.id + p.id) % 3, p.price_cents
FROM shop.orders o
JOIN shop.products p ON p.id IN (1 + (o.id * 5) % 36, 1 + (o.id * 11 + 3) % 36)
ON CONFLICT DO NOTHING;

-- The agent's read-only role.
CREATE ROLE agentflow_reader LOGIN PASSWORD 'agentflow_reader';
GRANT CONNECT ON DATABASE agentflow TO agentflow_reader;
GRANT USAGE ON SCHEMA shop TO agentflow_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA shop TO agentflow_reader;
ALTER ROLE agentflow_reader SET default_transaction_read_only = on;
ALTER ROLE agentflow_reader SET statement_timeout = '5s';
ALTER ROLE agentflow_reader SET search_path = shop;
