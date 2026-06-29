import { Router } from "express";
import { db, attendanceTable, usersTable, locationsTable, leaveTable } from "@workspace/db";
import { eq, gte, lte, and, desc } from "drizzle-orm";
import { requireAuth } from "./auth";
import { getLateThresholdMinutes } from "../lib/gemini-config";

const router = Router();

const STANDARD_HOURS_PER_DAY = 8;

function countWorkingDays(from: string, to: string): number {
  const start = new Date(from);
  const end = new Date(to);
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

router.get("/attendance", requireAuth, async (req: any, res) => {
  try {
    const { from, to, userId } = req.query as any;
    if (!from || !to) return res.status(400).json({ error: "from and to are required" });

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
      .where(
        me.role === "admin" && !userId
          ? and(gte(attendanceTable.date, from), lte(attendanceTable.date, to))
          : and(eq(attendanceTable.userId, targetUserId), gte(attendanceTable.date, from), lte(attendanceTable.date, to))
      )
      .orderBy(desc(attendanceTable.date));

    const leaveRecords = await db.select({
      id: leaveTable.id,
      userId: leaveTable.userId,
      userName: usersTable.name,
      type: leaveTable.type,
      startDate: leaveTable.startDate,
      endDate: leaveTable.endDate,
      totalDays: leaveTable.totalDays,
      reason: leaveTable.reason,
      status: leaveTable.status,
    })
      .from(leaveTable)
      .leftJoin(usersTable, eq(leaveTable.userId, usersTable.id))
      .where(
        me.role === "admin" && !userId
          ? and(gte(leaveTable.startDate, from), lte(leaveTable.startDate, to), eq(leaveTable.status, "approved"))
          : and(eq(leaveTable.userId, targetUserId), gte(leaveTable.startDate, from), lte(leaveTable.startDate, to), eq(leaveTable.status, "approved"))
      );

    // Group records by (userId, date) for 8-hour cap per day
    const dayGroups = new Map<string, number>();
    for (const r of records) {
      const key = `${r.userId}::${r.date}`;
      dayGroups.set(key, (dayGroups.get(key) ?? 0) + (r.hoursWorked || 0));
    }

    let totalHours = 0;
    let normalHours = 0;
    let overtimeHours = 0;
    for (const dayHours of dayGroups.values()) {
      totalHours    += dayHours;
      normalHours   += Math.min(dayHours, STANDARD_HOURS_PER_DAY);
      overtimeHours += Math.max(0, dayHours - STANDARD_HOURS_PER_DAY);
    }
    totalHours    = Math.round(totalHours    * 100) / 100;
    normalHours   = Math.round(normalHours   * 100) / 100;
    overtimeHours = Math.round(overtimeHours * 100) / 100;

    const uniqueDays = new Map<string, string>();
    for (const r of records) {
      const key = `${r.userId}::${r.date}`;
      uniqueDays.set(key, r.status);
    }
    const dayStatuses = [...uniqueDays.values()];
    const presentDays = dayStatuses.filter(s => s === "present" || s === "late" || s === "early_leave").length;
    const absentDays  = dayStatuses.filter(s => s === "absent").length;
    const leaveDays   = dayStatuses.filter(s => s === "on_leave").length
                      + leaveRecords.reduce((s, l) => s + l.totalDays, 0);
    const lateDays    = dayStatuses.filter(s => s === "late").length;

    const workingDays    = countWorkingDays(from, to);
    const expectedHours  = workingDays * STANDARD_HOURS_PER_DAY;

    // Build attendance rows with lateMinutes
    const lateThreshold = await getLateThresholdMinutes();
    const attendanceRows = records.map(r => {
      let lateMinutes = 0;
      if (r.status === "late" && r.checkIn) {
        const ci = r.checkIn instanceof Date ? r.checkIn : new Date(r.checkIn);
        const ciMin = ci.getUTCHours() * 60 + ci.getUTCMinutes();
        lateMinutes = Math.max(0, ciMin - lateThreshold);
      }
      const normalH   = Math.min(r.hoursWorked || 0, STANDARD_HOURS_PER_DAY);
      const overtimeH = Math.max(0, (r.hoursWorked || 0) - STANDARD_HOURS_PER_DAY);
      return {
        ...r,
        isLeave: false,
        checkIn:   r.checkIn?.toISOString() ?? null,
        checkOut:  r.checkOut?.toISOString() ?? null,
        createdAt: r.createdAt?.toISOString() ?? null,
        normalHours: normalH,
        overtimeCalc: overtimeH,
        lateMinutes,
        leaveType: null,
        leaveReason: null,
        leaveStartDate: null,
        leaveEndDate: null,
        leaveTotalDays: null,
      };
    });

    // Build leave rows
    const leaveRows = leaveRecords.map(l => ({
      id: l.id,
      isLeave: true,
      userId: l.userId,
      userName: l.userName ?? "",
      locationId: null,
      locationName: null,
      date: l.startDate,
      checkIn: null,
      checkOut: null,
      hoursWorked: 0,
      overtime: 0,
      normalHours: 0,
      overtimeCalc: 0,
      lateMinutes: 0,
      status: "on_leave",
      notes: null,
      biometricVerified: false,
      createdAt: null,
      leaveType: l.type,
      leaveReason: l.reason ?? "",
      leaveStartDate: l.startDate,
      leaveEndDate: l.endDate,
      leaveTotalDays: l.totalDays,
    }));

    // Merge and sort by date descending
    const allRows = [...attendanceRows, ...leaveRows]
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

    return res.json({
      from,
      to,
      records: allRows,
      summary: {
        totalDays: workingDays,
        totalHours:    Math.round(totalHours    * 100) / 100,
        normalHours:   Math.round(normalHours   * 100) / 100,
        overtime:      Math.round(overtimeHours * 100) / 100,
        presentDays,
        absentDays,
        leaveDays,
        lateDays,
        workingDays,
        expectedHours,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/dashboard", requireAuth, async (req: any, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const now = new Date();
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

    const allUsers = await db.select().from(usersTable);
    const todayRecords = await db.select().from(attendanceTable).where(eq(attendanceTable.date, today));
    const monthRecords = await db.select().from(attendanceTable)
      .where(and(gte(attendanceTable.date, firstOfMonth), lte(attendanceTable.date, today)));

    const pendingLeaves = await db.select().from(leaveTable).where(eq(leaveTable.status, "pending"));

    const recentActivity = await db.select({
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
      .orderBy(desc(attendanceTable.createdAt))
      .limit(10);

    const present = todayRecords.filter(r => r.status === "present" || r.status === "late").length;
    const onLeave = todayRecords.filter(r => r.status === "on_leave").length;
    const late = todayRecords.filter(r => r.status === "late").length;
    const totalHoursMonth = monthRecords.reduce((s, r) => s + (r.hoursWorked || 0), 0);

    return res.json({
      totalEmployees: allUsers.length,
      presentToday: present,
      absentToday: allUsers.length - present - onLeave,
      onLeaveToday: onLeave,
      lateToday: late,
      pendingLeaves: pendingLeaves.length,
      totalHoursThisMonth: Math.round(totalHoursMonth * 100) / 100,
      avgAttendanceRate: allUsers.length > 0 ? Math.round((present / allUsers.length) * 100) : 0,
      recentActivity: recentActivity.map(r => ({
        ...r,
        checkIn:   r.checkIn?.toISOString(),
        checkOut:  r.checkOut?.toISOString() ?? null,
        createdAt: r.createdAt?.toISOString(),
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
