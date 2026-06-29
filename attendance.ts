import { Router } from "express";
import { db, attendanceTable, usersTable, locationsTable, lateJustificationsTable } from "@workspace/db";
import { eq, and, gte, lte, desc, isNull, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";
import { createNotification } from "../lib/notify";
import { getLateThresholdMinutes } from "../lib/gemini-config";

const router = Router();

/**
 * All timestamps are stored in UTC in PostgreSQL.
 * Timestamps are returned as ISO 8601 UTC strings (toISOString()).
 * Clients display times in their local timezone.
 */
function calcHours(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  if (ms < 0) return 0;
  return Math.round((ms / 3_600_000) * 100) / 100;
}

function calcOvertime(hoursWorked: number, workHoursPerDay: number): number {
  return Math.max(0, Math.round((hoursWorked - workHoursPerDay) * 100) / 100);
}

async function checkInStatus(checkInTime: Date): Promise<string> {
  const totalMinutes = checkInTime.getUTCHours() * 60 + checkInTime.getUTCMinutes();
  return totalMinutes > (await getLateThresholdMinutes()) ? "late" : "present";
}

/** Serialize a record's timestamps to ISO strings. */
function serializeRecord(r: any): any {
  return {
    ...r,
    checkIn: r.checkIn instanceof Date ? r.checkIn.toISOString() : r.checkIn,
    checkOut: r.checkOut instanceof Date ? r.checkOut.toISOString() : (r.checkOut ?? null),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  };
}

router.get("/", requireAuth, async (req: any, res) => {
  try {
    const { userId, from, to, status } = req.query as any;
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const targetUserId = me.role === "admin" && userId ? parseInt(userId) : req.userId;

    const records = await db.select({
      id: attendanceTable.id,
      userId: attendanceTable.userId,
      userName: usersTable.name,
      locationId: attendanceTable.locationId,
      locationName: locationsTable.name,
      date: attendanceTable.date,
      checkIn: attendanceTable.checkIn,
      checkOut: attendanceTable.checkOut,
      hoursWorked: attendanceTable.hoursWorked,
      overtime: attendanceTable.overtime,
      status: attendanceTable.status,
      notes: attendanceTable.notes,
      biometricVerified: attendanceTable.biometricVerified,
      createdAt: attendanceTable.createdAt,
    })
      .from(attendanceTable)
      .leftJoin(usersTable, eq(attendanceTable.userId, usersTable.id))
      .leftJoin(locationsTable, eq(attendanceTable.locationId, locationsTable.id))
      .where(me.role === "admin" && !userId ? undefined : eq(attendanceTable.userId, targetUserId))
      .orderBy(desc(attendanceTable.checkIn));

    let result = records;
    if (from) result = result.filter(r => r.date >= from);
    if (to) result = result.filter(r => r.date <= to);
    if (status) result = result.filter(r => r.status === status);

    return res.json(result.map(serializeRecord));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /check-in
 * Creates a new session for today. Blocked only if there is already an
 * open (not checked-out) session — NOT if the user has checked in before.
 */
router.post("/check-in", requireAuth, async (req: any, res) => {
  try {
    const schema = z.object({
      locationId: z.number().int(),
      biometricVerified: z.boolean().optional().default(false),
      notes: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const today = new Date().toISOString().split("T")[0];

    // Block only if there is currently an open session
    const openSession = await db.select()
      .from(attendanceTable)
      .where(and(
        eq(attendanceTable.userId, req.userId),
        eq(attendanceTable.date, today),
        isNull(attendanceTable.checkOut)
      ))
      .limit(1);

    if (openSession.length > 0) {
      return res.status(400).json({ error: "Already checked in. Please check out before starting a new session." });
    }

    const now = new Date();
    const status = await checkInStatus(now);
    const [record] = await db.insert(attendanceTable).values({
      userId: req.userId,
      locationId: body.locationId,
      date: today,
      checkIn: now,
      status,
      notes: body.notes,
      biometricVerified: body.biometricVerified ?? false,
    }).returning();

    const [loc] = await db.select().from(locationsTable).where(eq(locationsTable.id, body.locationId)).limit(1);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    if (status === "late") {
      createNotification({
        type: "LATE_CHECKIN",
        title: `Late check-in: ${user?.name ?? "Employee"}`,
        message: `${user?.name ?? "An employee"} checked in late at ${now.toUTCString()}.`,
        relatedId: record.id,
        relatedType: "attendance",
      }).catch(console.error);
    }
    return res.status(201).json({
      ...serializeRecord(record),
      userName: user?.name ?? null,
      locationName: loc?.name ?? null,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /check-out
 * Closes the latest open session for today. Can be called multiple times
 * throughout the day (each time closing the most recent open session).
 */
router.post("/check-out", requireAuth, async (req: any, res) => {
  try {
    const schema = z.object({ notes: z.string().optional() });
    const body = schema.parse(req.body);
    const today = new Date().toISOString().split("T")[0];

    // Find the latest open session
    const [openRecord] = await db.select()
      .from(attendanceTable)
      .where(and(
        eq(attendanceTable.userId, req.userId),
        eq(attendanceTable.date, today),
        isNull(attendanceTable.checkOut)
      ))
      .orderBy(desc(attendanceTable.checkIn))
      .limit(1);

    if (!openRecord) {
      return res.status(404).json({ error: "Not currently checked in" });
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const now = new Date();
    const hoursWorked = calcHours(openRecord.checkIn, now);
    const overtime = calcOvertime(hoursWorked, user.workHoursPerDay);
    const status = hoursWorked < user.workHoursPerDay * 0.75 ? "early_leave" : openRecord.status;

    const [updated] = await db.update(attendanceTable).set({
      checkOut: now,
      hoursWorked,
      overtime,
      status,
      notes: body.notes ?? openRecord.notes,
    }).where(eq(attendanceTable.id, openRecord.id)).returning();

    const [loc] = openRecord.locationId
      ? await db.select().from(locationsTable).where(eq(locationsTable.id, openRecord.locationId)).limit(1)
      : [null];

    return res.json({
      ...serializeRecord(updated),
      userName: user?.name ?? null,
      locationName: (loc as any)?.name ?? null,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /today
 * Returns a summary of all sessions for today including:
 *  - sessions[]: each check-in/out pair
 *  - currentlyCheckedIn: whether there is an open session right now
 *  - totalHoursWorked: cumulative hours of all completed sessions
 * Also includes top-level fields for backward-compat (checkIn, checkOut, hoursWorked, status).
 */
router.get("/today", requireAuth, async (req: any, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    const records = await db.select({
      id: attendanceTable.id,
      userId: attendanceTable.userId,
      userName: usersTable.name,
      locationId: attendanceTable.locationId,
      locationName: locationsTable.name,
      date: attendanceTable.date,
      checkIn: attendanceTable.checkIn,
      checkOut: attendanceTable.checkOut,
      hoursWorked: attendanceTable.hoursWorked,
      overtime: attendanceTable.overtime,
      status: attendanceTable.status,
      notes: attendanceTable.notes,
      biometricVerified: attendanceTable.biometricVerified,
      createdAt: attendanceTable.createdAt,
    })
      .from(attendanceTable)
      .leftJoin(usersTable, eq(attendanceTable.userId, usersTable.id))
      .leftJoin(locationsTable, eq(attendanceTable.locationId, locationsTable.id))
      .where(and(eq(attendanceTable.userId, req.userId), eq(attendanceTable.date, today)))
      .orderBy(attendanceTable.checkIn);

    if (records.length === 0) {
      return res.status(404).json({ error: "No check-in today" });
    }

    const sessions = records.map(serializeRecord);
    const openSession = sessions.find(s => !s.checkOut) ?? null;
    const currentlyCheckedIn = openSession !== null;

    // Cumulative hours from all completed sessions
    const completedHours = sessions
      .filter(s => s.checkOut)
      .reduce((sum, s) => sum + (s.hoursWorked || 0), 0);

    // If open session, add in-progress time
    const inProgressHours = openSession
      ? calcHours(new Date(openSession.checkIn), new Date())
      : 0;

    const totalHoursWorked = Math.round((completedHours + inProgressHours) * 100) / 100;

    const first = sessions[0];
    const last = sessions[sessions.length - 1];

    return res.json({
      // Backward-compat fields (based on first/last session of day)
      id: first.id,
      userId: first.userId,
      userName: first.userName,
      locationId: first.locationId,
      locationName: first.locationName,
      date: first.date,
      checkIn: first.checkIn,
      checkOut: currentlyCheckedIn ? null : last.checkOut,
      hoursWorked: totalHoursWorked,
      overtime: Math.max(0, Math.round((totalHoursWorked - 8) * 100) / 100),
      status: first.status,
      biometricVerified: first.biometricVerified,
      notes: first.notes,
      createdAt: first.createdAt,
      // New fields for multi-session support
      sessions,
      currentlyCheckedIn,
      totalHoursWorked,
      openSessionId: openSession?.id ?? null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const schema = z.object({
      checkIn: z.string().optional(),
      checkOut: z.string().optional(),
      status: z.string().optional(),
      notes: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const updates: any = {};
    if (body.checkIn) updates.checkIn = new Date(body.checkIn);
    if (body.checkOut) updates.checkOut = new Date(body.checkOut);
    if (body.status) updates.status = body.status;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (updates.checkIn && updates.checkOut) {
      updates.hoursWorked = calcHours(updates.checkIn, updates.checkOut);
      updates.overtime = calcOvertime(updates.hoursWorked, 8);
    }
    const [updated] = await db.update(attendanceTable).set(updates).where(eq(attendanceTable.id, id)).returning();
    if (!updated) return res.status(404).json({ error: "Record not found" });
    return res.json({ ...serializeRecord(updated), userName: null, locationName: null });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get("/summary/daily", requireAuth, async (req: any, res) => {
  try {
    const { date, userId } = req.query as any;
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const targetDate = date || new Date().toISOString().split("T")[0];

    if (me.role === "admin") {
      const allUsers = await db.select().from(usersTable);
      const dayRecords = await db.select().from(attendanceTable).where(eq(attendanceTable.date, targetDate));
      // Per-user stats (group by userId for multi-session support)
      const userMap = new Map<number, typeof dayRecords>();
      for (const r of dayRecords) {
        if (!userMap.has(r.userId)) userMap.set(r.userId, []);
        userMap.get(r.userId)!.push(r);
      }
      let present = 0, late = 0, onLeave = 0;
      for (const [, recs] of userMap) {
        const first = recs[0];
        if (first.status === "on_leave") onLeave++;
        else if (first.status === "late") { present++; late++; }
        else present++;
      }
      const totalHours = dayRecords.reduce((sum, r) => sum + (r.hoursWorked || 0), 0);
      return res.json({
        date: targetDate,
        totalEmployees: allUsers.length,
        present,
        absent: allUsers.length - present - onLeave,
        late,
        onLeave,
        totalHours: Math.round(totalHours * 100) / 100,
      });
    } else {
      const uid = parseInt(userId) || req.userId;
      const records = await db.select().from(attendanceTable)
        .where(and(eq(attendanceTable.userId, uid), eq(attendanceTable.date, targetDate)));
      const totalHours = records.reduce((s, r) => s + (r.hoursWorked || 0), 0);
      const first = records[0];
      return res.json({
        date: targetDate,
        totalEmployees: 1,
        present: records.length > 0 ? 1 : 0,
        absent: records.length > 0 ? 0 : 1,
        late: first?.status === "late" ? 1 : 0,
        onLeave: first?.status === "on_leave" ? 1 : 0,
        totalHours: Math.round(totalHours * 100) / 100,
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/summary/monthly", requireAuth, async (req: any, res) => {
  try {
    const { month, year, userId } = req.query as any;
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const targetUserId = me.role === "admin" && userId ? parseInt(userId) : req.userId;
    const now = new Date();
    const m = parseInt(month) || now.getMonth() + 1;
    const y = parseInt(year) || now.getFullYear();
    const fromDate = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const toDate = `${y}-${String(m).padStart(2, "0")}-${lastDay}`;

    const records = await db.select().from(attendanceTable)
      .where(and(
        eq(attendanceTable.userId, targetUserId),
        gte(attendanceTable.date, fromDate),
        lte(attendanceTable.date, toDate)
      ));

    // Group by date to correctly count days (multiple sessions per day)
    const dateMap = new Map<string, typeof records>();
    for (const r of records) {
      if (!dateMap.has(r.date)) dateMap.set(r.date, []);
      dateMap.get(r.date)!.push(r);
    }

    let presentDays = 0, leaveDays = 0;
    for (const [, dayRecs] of dateMap) {
      if (dayRecs[0].status === "on_leave") leaveDays++;
      else presentDays++;
    }

    const totalHours = records.reduce((s, r) => s + (r.hoursWorked || 0), 0);
    const overtime = records.reduce((s, r) => s + (r.overtime || 0), 0);

    return res.json({
      month: m,
      year: y,
      userId: targetUserId,
      totalDays: lastDay,
      presentDays,
      absentDays: Math.max(0, lastDay - presentDays - leaveDays),
      leaveDays,
      totalHours: Math.round(totalHours * 100) / 100,
      overtime: Math.round(overtime * 100) / 100,
      avgHoursPerDay: presentDays > 0 ? Math.round((totalHours / presentDays) * 100) / 100 : 0,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ─── Late Justification Routes ──────────────────────────────────────────── */

/**
 * POST /:id/justify
 * Employee submits a justification for a late check-in on record :id.
 */
router.post("/:id/justify", requireAuth, async (req: any, res) => {
  try {
    const attendanceId = parseInt(req.params.id);
    const schema = z.object({ reason: z.string().min(5).max(1000) });
    const { reason } = schema.parse(req.body);

    const [rec] = await db.select().from(attendanceTable)
      .where(and(eq(attendanceTable.id, attendanceId), eq(attendanceTable.userId, req.userId)))
      .limit(1);
    if (!rec) return res.status(404).json({ error: "Attendance record not found" });
    if (rec.status !== "late") return res.status(400).json({ error: "Justification only allowed for late records" });

    // Check if already submitted
    const [existing] = await db.select().from(lateJustificationsTable)
      .where(and(eq(lateJustificationsTable.attendanceId, attendanceId), eq(lateJustificationsTable.userId, req.userId)))
      .limit(1);
    if (existing) return res.status(409).json({ error: "Justification already submitted", justification: existing });

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);

    const [justification] = await db.insert(lateJustificationsTable).values({
      attendanceId,
      userId: req.userId,
      reason,
      status: "pending",
    }).returning();

    createNotification({
      type: "LATE_JUSTIFICATION",
      title: `تبرير تأخر: ${user?.name ?? "موظف"}`,
      message: `${user?.name ?? "موظف"} تقدّم بتبرير للتأخر بتاريخ ${rec.date}. السبب: ${reason}`,
      relatedId: justification.id,
      relatedType: "late_justification",
    }).catch(console.error);

    return res.status(201).json(justification);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /justifications
 * Admin: list all late justifications with employee + attendance info.
 * Employee: list their own justifications.
 */
router.get("/justifications", requireAuth, async (req: any, res) => {
  try {
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const rows = await db.select({
      id:           lateJustificationsTable.id,
      attendanceId: lateJustificationsTable.attendanceId,
      userId:       lateJustificationsTable.userId,
      reason:       lateJustificationsTable.reason,
      status:       lateJustificationsTable.status,
      adminNote:    lateJustificationsTable.adminNote,
      reviewedBy:   lateJustificationsTable.reviewedBy,
      reviewedAt:   lateJustificationsTable.reviewedAt,
      createdAt:    lateJustificationsTable.createdAt,
      employeeName: usersTable.name,
      date:         attendanceTable.date,
      checkIn:      attendanceTable.checkIn,
    })
      .from(lateJustificationsTable)
      .leftJoin(usersTable, eq(lateJustificationsTable.userId, usersTable.id))
      .leftJoin(attendanceTable, eq(lateJustificationsTable.attendanceId, attendanceTable.id))
      .where(me.role === "admin" ? undefined : eq(lateJustificationsTable.userId, req.userId))
      .orderBy(desc(lateJustificationsTable.createdAt));

    return res.json(rows.map(r => ({
      ...r,
      checkIn: r.checkIn instanceof Date ? r.checkIn.toISOString() : r.checkIn,
      reviewedAt: r.reviewedAt instanceof Date ? r.reviewedAt.toISOString() : r.reviewedAt,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    })));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /justifications/:id
 * Admin: approve or reject a late justification.
 * On approval, the attendance record status is changed to "present" (excused).
 */
router.patch("/justifications/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const schema = z.object({
      status: z.enum(["approved", "rejected"]),
      adminNote: z.string().optional(),
    });
    const body = schema.parse(req.body);

    const [just] = await db.select().from(lateJustificationsTable)
      .where(eq(lateJustificationsTable.id, id)).limit(1);
    if (!just) return res.status(404).json({ error: "Justification not found" });
    if (just.status !== "pending") return res.status(400).json({ error: "Already reviewed" });

    const [updated] = await db.update(lateJustificationsTable).set({
      status:     body.status,
      adminNote:  body.adminNote ?? null,
      reviewedBy: req.userId,
      reviewedAt: new Date(),
    }).where(eq(lateJustificationsTable.id, id)).returning();

    if (body.status === "approved") {
      await db.update(attendanceTable)
        .set({ status: "present" })
        .where(eq(attendanceTable.id, just.attendanceId));
    }

    const [employee] = await db.select().from(usersTable)
      .where(eq(usersTable.id, just.userId)).limit(1);
    const [attRec] = await db.select().from(attendanceTable)
      .where(eq(attendanceTable.id, just.attendanceId)).limit(1);

    const statusAr = body.status === "approved" ? "موافقة" : "رفض";
    createNotification({
      type: "LATE_JUSTIFICATION",
      title: `${statusAr} تبرير التأخر — ${employee?.name ?? ""}`,
      message: body.status === "approved"
        ? `تمت الموافقة على تبرير التأخر بتاريخ ${attRec?.date ?? ""}. يُحتسب الحضور كاملاً.`
        : `تم رفض تبرير التأخر بتاريخ ${attRec?.date ?? ""}. ${body.adminNote ?? ""}`,
      relatedId: id,
      relatedType: "late_justification",
    }).catch(console.error);

    return res.json({ ...updated, reviewedAt: updated.reviewedAt?.toISOString() ?? null });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post("/daily-summary", requireAdmin, async (req: any, res) => {
  try {
    const { messagesTable } = await import("@workspace/db");
    const today = new Date().toISOString().split("T")[0];

    const employees = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.role, "employee"));

    let sent = 0;

    for (const emp of employees) {
      const [att] = await db
        .select()
        .from(attendanceTable)
        .where(and(eq(attendanceTable.userId, emp.id), eq(attendanceTable.date, today)))
        .limit(1);

      let body = `📋 ملخص الحضور ليوم ${today}\n\nالموظف: ${emp.name}\n`;

      if (!att) {
        body += `الحالة: ❌ غائب\n`;
      } else {
        const statusLabel: Record<string, string> = {
          present: "✅ حاضر",
          late: "🟠 متأخر",
          absent: "❌ غائب",
          on_leave: "📅 إجازة",
          early_leave: "🟡 مغادرة مبكرة",
        };
        body += `الحالة: ${statusLabel[att.status ?? ""] ?? att.status}\n`;

        if (att.checkIn) {
          const ci = new Date(att.checkIn);
          body += `وقت الوصول: ${ci.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}\n`;
        }
        if (att.checkOut) {
          const co = new Date(att.checkOut);
          body += `وقت المغادرة: ${co.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}\n`;
        }
        if (att.hoursWorked != null) {
          body += `إجمالي ساعات العمل: ${att.hoursWorked} ساعة\n`;
        }
      }

      const adminUser = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.role, "admin"))
        .limit(1);

      const senderId = adminUser[0]?.id ?? (req as any).user?.userId;
      if (!senderId) continue;

      await db.insert(messagesTable).values({
        senderId,
        receiverId: emp.id,
        subject: `ملخص الحضور - ${today}`,
        body,
        isBroadcast: false,
      });

      sent++;
    }

    return res.json({ sent });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/bulk", requireAdmin, async (req: any, res) => {
  try {
    const { ids } = req.body as { ids: number[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    const { inArray } = await import("drizzle-orm");
    await db.delete(attendanceTable).where(inArray(attendanceTable.id, ids));
    return res.json({ deleted: ids.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [exists] = await db.select({ id: attendanceTable.id }).from(attendanceTable).where(eq(attendanceTable.id, id)).limit(1);
    if (!exists) return res.status(404).json({ error: "Record not found" });
    await db.delete(attendanceTable).where(eq(attendanceTable.id, id));
    return res.status(204).send();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
