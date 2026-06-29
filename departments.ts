import { Router } from "express";
import { db, departmentsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";

const router = Router();

const DEFAULT_DEPARTMENTS = ["HR", "Accounting", "Sales", "IT", "Operations"];

async function seedIfEmpty() {
  const existing = await db.select().from(departmentsTable);
  if (existing.length === 0) {
    await db.insert(departmentsTable).values(
      DEFAULT_DEPARTMENTS.map(name => ({ name }))
    ).onConflictDoNothing();
  }
}

router.get("/", requireAuth, async (_req, res) => {
  try {
    await seedIfEmpty();
    const depts = await db.select().from(departmentsTable).orderBy(departmentsTable.name);
    const users = await db.select({ id: usersTable.id, department: usersTable.department }).from(usersTable);
    const countMap: Record<string, number> = {};
    for (const u of users) {
      if (u.department) countMap[u.department] = (countMap[u.department] || 0) + 1;
    }
    return res.json(depts.map(d => ({ ...d, employeeCount: countMap[d.name] || 0 })));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAdmin, async (req, res) => {
  try {
    const schema = z.object({ name: z.string().min(1).max(255) });
    const { name } = schema.parse(req.body);
    const [dept] = await db.insert(departmentsTable).values({ name }).returning();
    return res.status(201).json({ ...dept, employeeCount: 0 });
  } catch (err: any) {
    if (err.message?.includes("unique")) {
      return res.status(409).json({ error: "Department already exists" });
    }
    return res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [dept] = await db.select().from(departmentsTable).where(eq(departmentsTable.id, id)).limit(1);
    if (!dept) return res.status(404).json({ error: "Department not found" });
    await db.update(usersTable).set({ department: null }).where(eq(usersTable.department, dept.name));
    await db.delete(departmentsTable).where(eq(departmentsTable.id, id));
    return res.status(204).send();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
