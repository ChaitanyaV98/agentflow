import { describe, expect, it } from "vitest";
import { listTables, runQuery } from "./postgres";

describe("read-only SQL tool", () => {
  it("lists the shop tables with column comments", async () => {
    const tables = (await listTables.execute({})) as Record<string, { columns: string[] }>;
    expect(Object.keys(tables).sort()).toEqual(["categories", "customers", "order_items", "orders", "products"]);
    expect(tables.order_items.columns.join()).toMatch(/unit_price_cents integer -- Price paid per unit/);
  });

  it("answers a real aggregate question", async () => {
    const r = (await runQuery.execute({
      sql: `select c.name, sum(oi.quantity * oi.unit_price_cents) as revenue
            from order_items oi join products p on p.id = oi.product_id
            join categories c on c.id = p.category_id join orders o on o.id = oi.order_id
            where o.status = 'paid' group by c.name order by revenue desc;`,
    })) as { rows: { name: string }[]; truncated: boolean };
    expect(r.rows[0].name).toBe("Laptops");
    expect(r.truncated).toBe(false);
  });

  it("caps results at 100 rows", async () => {
    const r = (await runQuery.execute({ sql: "select * from orders" })) as { rows: unknown[]; truncated: boolean };
    expect(r.rows).toHaveLength(100);
    expect(r.truncated).toBe(true);
  });

  it.each([
    ["delete from orders", /Only SELECT/],
    ["select 1; drop table orders", /SQL error/], // a second statement can't hide inside the subquery wrapper
    ["with x as (delete from orders returning *) select * from x", /SQL error/], // data-modifying CTE: blocked by the DB
    ["select * from public.runs", /SQL error/], // the reader role can't see AgentFlow's own tables
    ["select pg_sleep(10)", /SQL error/], // 5 s statement timeout
  ])("blocks %s", async (sql, error) => {
    await expect(runQuery.execute({ sql })).rejects.toThrow(error);
  }, 15_000);
});
