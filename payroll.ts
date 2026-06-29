import { Router } from "express";
import { db, usersTable, attendanceTable, leaveTable, payrollReportsTable, bonusesTable } from "@workspace/db";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";
import { getLateThresholdMinutes } from "../lib/gemini-config";

const router = Router();

/* ─── Helpers ────────────────────────────────────────────── */

/** Count Mon–Fri days in a given month (or custom date range). */
function workingDaysInRange(start: Date, end: Date): number {
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0=Sun 6=Sat
    if (dow !== 0 && dow !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

/** Late minutes above the configured threshold. */
async function lateMinutesFor(checkIn: Date): Promise<number> {
  const totalMin = checkIn.getUTCHours() * 60 + checkIn.getUTCMinutes();
  return Math.max(0, totalMin - (await getLateThresholdMinutes()));
}

/** Round to 2 decimals. */
const r2 = (n: number) => Math.round(n * 100) / 100;

/* ─── Calculate (preview, no save) ──────────────────────── */

const calculateSchema = z.object({
  userId: z.coerce.number().int().positive(),
  period: z.string().regex(/^\d{4}-\d{2}$/), // "YYYY-MM"
});

router.post("/calculate", requireAuth, async (req: any, res) => {
  const parsed = calculateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });

  const { userId, period } = parsed.data;

  const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
  if (!me) return res.status(401).json({ error: "Unauthorized" });
  if (me.role !== "admin" && me.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  const [year, month] = period.split("-").map(Number);

  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd   = new Date(Date.UTC(year, month, 0));     // last day

  try {
    /* 1. Employee info */
    const [emp] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const baseSalary      = emp.salary ?? 0;
    const workHoursPerDay = emp.workHoursPerDay ?? 8;

    /* 2. Working days in period */
    const workingDaysInMonth = workingDaysInRange(periodStart, periodEnd);
    const dailyRate  = r2(workingDaysInMonth > 0 ? baseSalary / workingDaysInMonth : 0);
    const hourlyRate = r2(workHoursPerDay > 0 ? dailyRate / workHoursPerDay : 0);

    /* 3. Attendance records */
    const startStr = periodStart.toISOString().slice(0, 10);
    const endStr   = periodEnd.toISOString().slice(0, 10);

    const attRecords = await db.select().from(attendanceTable)
      .where(and(
        eq(attendanceTable.userId, userId),
        gte(attendanceTable.date, startStr),
        lte(attendanceTable.date, endStr),
      ));

    const daysPresent       = attRecords.length;
    let totalOvertimeHours  = 0;
    let totalLateMinutes    = 0;

    for (const rec of attRecords) {
      totalOvertimeHours += rec.overtime ?? 0;
      if (rec.status === "late" && rec.checkIn) {
        totalLateMinutes += await lateMinutesFor(new Date(rec.checkIn));
      }
    }

    /* 4. Leave records overlapping the period */
    const leaveRecords = await db.select().from(leaveTable)
      .where(and(
        eq(leaveTable.userId, userId),
        eq(leaveTable.status, "approved"),
        lte(leaveTable.startDate, endStr),
        gte(leaveTable.endDate, startStr),
      ));

    let paidLeaveDays   = 0;
    let unpaidLeaveDays = 0;

    for (const lv of leaveRecords) {
      const lvStart = new Date(Math.max(new Date(lv.startDate).getTime(), periodStart.getTime()));
      const lvEnd   = new Date(Math.min(new Date(lv.endDate).getTime(), periodEnd.getTime()));
      const days    = workingDaysInRange(lvStart, lvEnd);
      if (lv.type === "unpaid") unpaidLeaveDays += days;
      else paidLeaveDays += days;
    }

    /* 5. Absent days (working days not covered by attendance or approved leave) */
    const daysAbsent = Math.max(0, workingDaysInMonth - daysPresent - paidLeaveDays - unpaidLeaveDays);

    /* 6. Compute components */
    const overtimeBonus       = r2(totalOvertimeHours * hourlyRate * 1.5);
    const latePenalty         = r2((totalLateMinutes / 60) * hourlyRate);
    const unpaidLeaveDeduction = r2(unpaidLeaveDays * dailyRate);
    const absentDeduction     = r2(daysAbsent * dailyRate);

    /* 7. Admin bonuses & deductions for the period */
    const bonusRows = await db.select().from(bonusesTable)
      .where(and(eq(bonusesTable.userId, userId), eq(bonusesTable.period, period)));
    const adminBonusTotal     = r2(bonusRows.filter(b => b.type === "bonus").reduce((s, b) => s + b.amount, 0));
    const adminDeductionTotal = r2(bonusRows.filter(b => b.type === "deduction").reduce((s, b) => s + b.amount, 0));

    const totalDeductions = r2(latePenalty + unpaidLeaveDeduction + absentDeduction + adminDeductionTotal);
    const totalAdditions  = r2(overtimeBonus + adminBonusTotal);
    const netSalary       = r2(baseSalary + totalAdditions - totalDeductions);

    return res.json({
      employeeId:   emp.id,
      employeeName: emp.name,
      department:   emp.department,
      period,
      periodStart:  startStr,
      periodEnd:    endStr,
      baseSalary,
      dailyRate,
      hourlyRate,
      workHoursPerDay,
      workingDaysInMonth,
      daysPresent,
      daysAbsent,
      paidLeaveDays,
      unpaidLeaveDays,
      totalOvertimeHours: r2(totalOvertimeHours),
      totalLateMinutes,
      overtimeBonus,
      latePenalty,
      unpaidLeaveDeduction,
      absentDeduction,
      adminBonusTotal,
      adminDeductionTotal,
      totalDeductions,
      totalAdditions,
      netSalary,
      bonusItems: bonusRows.map(b => ({
        id: b.id,
        type: b.type,
        amount: b.amount,
        reason: b.reason,
        period: b.period,
        createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : b.createdAt,
      })),
      attendanceRecords: attRecords.map(r => ({
        date:         r.date,
        status:       r.status,
        hoursWorked:  r.hoursWorked,
        overtime:     r.overtime,
        lateMinutes:  0,
        checkIn:      r.checkIn ? new Date(r.checkIn).toISOString() : null,
        checkOut:     r.checkOut ? new Date(r.checkOut).toISOString() : null,
      })),
      leaveRecords: leaveRecords.map(l => ({
        type:      l.type,
        startDate: l.startDate,
        endDate:   l.endDate,
        totalDays: l.totalDays,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ─── Save report ────────────────────────────────────────── */

const saveSchema = z.object({
  userId:               z.number().int().positive(),
  employeeName:         z.string(),
  period:               z.string(),
  periodStart:          z.string(),
  periodEnd:            z.string(),
  baseSalary:           z.number(),
  dailyRate:            z.number(),
  hourlyRate:           z.number(),
  workingDaysInMonth:   z.number().int(),
  daysPresent:          z.number().int(),
  daysAbsent:           z.number().int(),
  paidLeaveDays:        z.number().int(),
  unpaidLeaveDays:      z.number().int(),
  totalOvertimeHours:   z.number(),
  totalLateMinutes:     z.number().int(),
  overtimeBonus:        z.number(),
  latePenalty:          z.number(),
  unpaidLeaveDeduction: z.number(),
  totalDeductions:      z.number(),
  totalAdditions:       z.number(),
  netSalary:            z.number(),
  notes:                z.string().optional(),
});

router.post("/save", requireAuth, requireAdmin, async (req: any, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });

  try {
    const [report] = await db.insert(payrollReportsTable).values({
      ...parsed.data,
      generatedBy: req.userId,
    }).returning();
    return res.json(report);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ─── List saved reports ─────────────────────────────────── */

router.get("/reports", requireAuth, requireAdmin, async (req: any, res) => {
  try {
    const { userId, period } = req.query as any;
    let query = db.select({
      id:           payrollReportsTable.id,
      userId:       payrollReportsTable.userId,
      employeeName: payrollReportsTable.employeeName,
      period:       payrollReportsTable.period,
      baseSalary:   payrollReportsTable.baseSalary,
      netSalary:    payrollReportsTable.netSalary,
      totalDeductions: payrollReportsTable.totalDeductions,
      totalAdditions:  payrollReportsTable.totalAdditions,
      daysPresent:  payrollReportsTable.daysPresent,
      daysAbsent:   payrollReportsTable.daysAbsent,
      createdAt:    payrollReportsTable.createdAt,
    }).from(payrollReportsTable).orderBy(desc(payrollReportsTable.createdAt)).$dynamic();

    const rows = await query;
    let result = rows;
    if (userId) result = result.filter(r => r.userId === parseInt(userId));
    if (period) result = result.filter(r => r.period === period);
    return res.json(result.map(r => ({ ...r, createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt })));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ─── Get single report ──────────────────────────────────── */

router.get("/reports/:id", requireAuth, requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [report] = await db.select().from(payrollReportsTable).where(eq(payrollReportsTable.id, id)).limit(1);
    if (!report) return res.status(404).json({ error: "Report not found" });
    return res.json({ ...report, createdAt: report.createdAt instanceof Date ? report.createdAt.toISOString() : report.createdAt });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ─── Delete report ──────────────────────────────────────── */

router.delete("/reports/:id", requireAuth, requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(payrollReportsTable).where(eq(payrollReportsTable.id, id));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
