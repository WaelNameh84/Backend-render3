import { Router } from "express";
import { db, requestsTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";
import { createNotification } from "../lib/notify";

const router = Router();

router.get("/", requireAuth, async (req: any, res) => {
  try {
    const { userId, type } = req.query as any;
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);

    const baseSelect = db.select({
      id: requestsTable.id,
      userId: requestsTable.userId,
      userName: usersTable.name,
      type: requestsTable.type,
      date: requestsTable.date,
      startTime: requestsTable.startTime,
      endTime: requestsTable.endTime,
      hours: requestsTable.hours,
      reason: requestsTable.reason,
      status: requestsTable.status,
      adminNote: requestsTable.adminNote,
      reviewedBy: requestsTable.reviewedBy,
      reviewedAt: requestsTable.reviewedAt,
      createdAt: requestsTable.createdAt,
    }).from(requestsTable).leftJoin(usersTable, eq(requestsTable.userId, usersTable.id));

    const rows = await (
      me.role === "admin" && !userId
        ? baseSelect.orderBy(desc(requestsTable.createdAt))
        : baseSelect
            .where(eq(requestsTable.userId, me.role === "admin" && userId ? parseInt(userId) : req.userId))
            .orderBy(desc(requestsTable.createdAt))
    );

    let result = rows;
    if (type) result = result.filter(r => r.type === type);

    return res.json(result.map(r => ({
      ...r,
      reviewedAt: r.reviewedAt instanceof Date ? r.reviewedAt.toISOString() : r.reviewedAt,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    })));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAuth, async (req: any, res) => {
  try {
    const schema = z.object({
      type: z.enum(["overtime", "permission", "excuse"]),
      date: z.string(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      hours: z.number().optional(),
      reason: z.string().min(1),
      targetUserId: z.number().int().optional(),
    });
    const body = schema.parse(req.body);

    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const targetId = (me?.role === "admin" && body.targetUserId) ? body.targetUserId : req.userId;

    const [record] = await db.insert(requestsTable).values({
      userId: targetId,
      type: body.type,
      date: body.date,
      startTime: body.startTime ?? null,
      endTime: body.endTime ?? null,
      hours: body.hours ?? null,
      reason: body.reason,
      status: "pending",
    }).returning();

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, targetId)).limit(1);
    const typeLabels: Record<string, string> = {
      overtime: "عمل إضافي", permission: "إذن خروج", excuse: "عذر غياب"
    };
    createNotification({
      type: "SYSTEM_ALERT",
      title: `طلب ${typeLabels[body.type] ?? body.type} — ${user?.name ?? ""}`,
      message: `${user?.name ?? "موظف"} طلب ${typeLabels[body.type] ?? body.type} بتاريخ ${body.date}. السبب: ${body.reason}`,
      relatedId: record.id,
      relatedType: "request",
    }).catch(console.error);

    return res.status(201).json({
      ...record,
      createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch("/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const schema = z.object({
      status: z.enum(["approved", "rejected"]),
      adminNote: z.string().optional(),
    });
    const body = schema.parse(req.body);

    const [existing] = await db.select().from(requestsTable).where(eq(requestsTable.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status !== "pending") return res.status(400).json({ error: "Already reviewed" });

    const [updated] = await db.update(requestsTable).set({
      status: body.status,
      adminNote: body.adminNote ?? null,
      reviewedBy: req.userId,
      reviewedAt: new Date(),
    }).where(eq(requestsTable.id, id)).returning();

    const [employee] = await db.select().from(usersTable).where(eq(usersTable.id, existing.userId)).limit(1);
    const typeLabels: Record<string, string> = {
      overtime: "العمل الإضافي", permission: "الإذن", excuse: "عذر الغياب"
    };
    const statusAr = body.status === "approved" ? "موافقة على" : "رفض";
    createNotification({
      type: "SYSTEM_ALERT",
      title: `${statusAr} طلب ${typeLabels[existing.type] ?? existing.type}`,
      message: `تم ${statusAr} طلب ${typeLabels[existing.type] ?? existing.type} للموظف ${employee?.name ?? ""} بتاريخ ${existing.date}.`,
      relatedId: id,
      relatedType: "request",
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

export default router;
