import { Router } from "express";
import { db, usersTable, userSettingsTable, attendanceTable, leaveTable } from "@workspace/db";
import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";
import crypto from "crypto";

const router = Router();

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password + "attendance_salt_2024").digest("hex");
}

router.get("/", requireAuth, async (req: any, res) => {
  try {
    const { search, role } = req.query as { search?: string; role?: string };
    const users = await db.select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      department: usersTable.department,
      position: usersTable.position,
      phone: usersTable.phone,
      avatarUrl: usersTable.avatarUrl,
      workHoursPerDay: usersTable.workHoursPerDay,
      salary: usersTable.salary,
      isApproved: usersTable.isApproved,
      createdAt: usersTable.createdAt,
    }).from(usersTable);

    let result = users;
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(u => u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s));
    }
    if (role) result = result.filter(u => u.role === role);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAdmin, async (req: any, res) => {
  try {
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      password: z.string().min(6),
      role: z.enum(["admin", "employee"]).default("employee"),
      department: z.string().optional(),
      position: z.string().optional(),
      phone: z.string().optional(),
      workHoursPerDay: z.number().optional().default(8),
      salary: z.number().optional(),
    });
    const body = schema.parse(req.body);
    const [user] = await db.insert(usersTable).values({
      name: body.name,
      email: body.email,
      passwordHash: hashPassword(body.password),
      role: body.role,
      department: body.department,
      position: body.position,
      phone: body.phone,
      workHoursPerDay: body.workHoursPerDay ?? 8,
      salary: body.salary,
    }).returning();
    await db.insert(userSettingsTable).values({ userId: user.id }).onConflictDoNothing();
    const { passwordHash, ...safeUser } = user;
    return res.status(201).json(safeUser);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get("/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [user] = await db.select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      department: usersTable.department,
      position: usersTable.position,
      phone: usersTable.phone,
      avatarUrl: usersTable.avatarUrl,
      workHoursPerDay: usersTable.workHoursPerDay,
      salary: usersTable.salary,
      createdAt: usersTable.createdAt,
    }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (req.userId !== id) {
      const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
      if (!me || me.role !== "admin") {
        return res.status(403).json({ error: "Not allowed" });
      }
    }
    const schema = z.object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      department: z.string().nullable().optional(),
      position: z.string().optional(),
      phone: z.string().optional(),
      workHoursPerDay: z.number().optional(),
      salary: z.number().nullable().optional(),
    });
    const body = schema.parse(req.body);
    if (body.email) {
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, body.email)).limit(1);
      if (existing && existing.id !== id) {
        return res.status(400).json({ error: "Email already in use by another account" });
      }
    }
    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.email !== undefined) updates.email = body.email;
    if (body.department !== undefined) updates.department = body.department;
    if (body.position !== undefined) updates.position = body.position;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.workHoursPerDay !== undefined) updates.workHoursPerDay = body.workHoursPerDay;
    if (body.salary !== undefined) updates.salary = body.salary;

    const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
    if (!updated) return res.status(404).json({ error: "User not found" });
    const { passwordHash, ...safeUser } = updated;
    return res.json(safeUser);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put("/:id/password", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const schema = z.object({ password: z.string().min(6) });
    const { password } = schema.parse(req.body);
    const [updated] = await db.update(usersTable)
      .set({ passwordHash: hashPassword(password) })
      .where(eq(usersTable.id, id))
      .returning({ id: usersTable.id });
    if (!updated) return res.status(404).json({ error: "User not found" });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.userId) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    await db.delete(attendanceTable).where(eq(attendanceTable.userId, id));
    await db.update(leaveTable).set({ reviewedBy: null }).where(eq(leaveTable.reviewedBy, id));
    await db.delete(leaveTable).where(eq(leaveTable.userId, id));
    await db.delete(userSettingsTable).where(eq(userSettingsTable.userId, id));
    await db.delete(usersTable).where(eq(usersTable.id, id));
    return res.status(204).send();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
