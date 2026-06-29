import { Router } from "express";
import { db, salaryAdvancesTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";
import { createNotification } from "../lib/notify";

const router = Router();

/* ── GET /api/salary-advances  (admin sees all, employee sees own) ── */
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const rows = await db
      .select({
        id: salaryAdvancesTable.id,
        userId: salaryAdvancesTable.userId,
        userName: usersTable.name,
        amount: salaryAdvancesTable.amount,
        reason: salaryAdvancesTable.reason,
        status: salaryAdvancesTable.status,
        adminNote: salaryAdvancesTable.adminNote,
        reviewedBy: salaryAdvancesTable.reviewedBy,
        reviewedAt: salaryAdvancesTable.reviewedAt,
        deductedPeriod: salaryAdvancesTable.deductedPeriod,
        createdAt: salaryAdvancesTable.createdAt,
      })
      .from(salaryAdvancesTable)
      .leftJoin(usersTable, eq(salaryAdvancesTable.userId, usersTable.id))
      .orderBy(desc(salaryAdvancesTable.createdAt));

    const result = me?.role === "admin" ? rows : rows.filter((r: any) => r.userId === req.userId);
    return res.json(result.map((r: any) => ({
      ...r,
      reviewedAt: r.reviewedAt instanceof Date ? r.reviewedAt.toISOString() : r.reviewedAt,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    })));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/salary-advances/:id ── */
router.get("/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const rows = await db
      .select({
        id: salaryAdvancesTable.id,
        userId: salaryAdvancesTable.userId,
        userName: usersTable.name,
        amount: salaryAdvancesTable.amount,
        reason: salaryAdvancesTable.reason,
        status: salaryAdvancesTable.status,
        adminNote: salaryAdvancesTable.adminNote,
        reviewedBy: salaryAdvancesTable.reviewedBy,
        reviewedAt: salaryAdvancesTable.reviewedAt,
        deductedPeriod: salaryAdvancesTable.deductedPeriod,
        createdAt: salaryAdvancesTable.createdAt,
      })
      .from(salaryAdvancesTable)
      .leftJoin(usersTable, eq(salaryAdvancesTable.userId, usersTable.id))
      .where(eq(salaryAdvancesTable.id, id))
      .limit(1);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const r = rows[0];
    if (me?.role !== "admin" && (r as any).userId !== req.userId) return res.status(403).json({ error: "Forbidden" });
    return res.json({
      ...r,
      reviewedAt: (r as any).reviewedAt instanceof Date ? (r as any).reviewedAt.toISOString() : (r as any).reviewedAt,
      createdAt: (r as any).createdAt instanceof Date ? (r as any).createdAt.toISOString() : (r as any).createdAt,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/salary-advances  (employee requests) ── */
router.post("/", requireAuth, async (req: any, res) => {
  try {
    const schema = z.object({
      amount: z.number().positive(),
      reason: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const [record] = await db.insert(salaryAdvancesTable).values({
      userId: req.userId,
      amount: body.amount,
      reason: body.reason ?? null,
      status: "pending",
    }).returning();

    const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    await createNotification({
      type: "SYSTEM_ALERT",
      title: `💵 طلب سلفة — ${user?.name ?? "موظف"}`,
      message: `طلب الموظف ${user?.name ?? ""} سلفة بمبلغ ${body.amount}${body.reason ? `. السبب: ${body.reason.slice(0, 80)}` : ""}`,
      relatedId: record.id,
      relatedType: "salary_advance",
    }).catch(console.error);

    return res.status(201).json({
      ...record,
      createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/* ── PATCH /api/salary-advances/:id  (admin approves/rejects) ── */
router.patch("/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const schema = z.object({
      status: z.enum(["approved", "rejected"]),
      adminNote: z.string().optional(),
      deductedPeriod: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const [existing] = await db.select().from(salaryAdvancesTable).where(eq(salaryAdvancesTable.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Not found" });

    const [updated] = await db.update(salaryAdvancesTable).set({
      status: body.status,
      adminNote: body.adminNote ?? null,
      deductedPeriod: body.deductedPeriod ?? null,
      reviewedBy: req.userId,
      reviewedAt: new Date(),
    }).where(eq(salaryAdvancesTable.id, id)).returning();

    const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, updated.userId)).limit(1);
    const statusAr = body.status === "approved" ? "موافقة" : "رفض";
    await createNotification({
      type: "SYSTEM_ALERT",
      title: `${body.status === "approved" ? "✅" : "❌"} ${statusAr} طلب السلفة — ${user?.name ?? ""}`,
      message: `تم ${statusAr} طلب السلفة بمبلغ ${existing.amount}${body.adminNote ? `. ملاحظة: ${body.adminNote}` : ""}`,
      relatedId: updated.id,
      relatedType: "salary_advance",
    }).catch(console.error);

    return res.json({
      ...updated,
      reviewedAt: updated.reviewedAt instanceof Date ? updated.reviewedAt.toISOString() : updated.reviewedAt,
      createdAt: updated.createdAt instanceof Date ? updated.createdAt.toISOString() : updated.createdAt,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/* ── DELETE /api/salary-advances/:id  (employee cancels pending) ── */
router.delete("/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const [existing] = await db.select().from(salaryAdvancesTable).where(eq(salaryAdvancesTable.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (me?.role !== "admin" && existing.userId !== req.userId) return res.status(403).json({ error: "Forbidden" });
    if (me?.role !== "admin" && existing.status !== "pending") return res.status(400).json({ error: "Cannot cancel a reviewed request" });
    await db.delete(salaryAdvancesTable).where(eq(salaryAdvancesTable.id, id));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
