import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ISODate, UUID } from '@/lib/shared-types';

/**
 * The device's notion of "have I already checked in/out today, and under
 * which attendanceId" — same reasoning as `components/pos/shift-store.ts`'s
 * `OpenShift`: `LocalRuntime` records the durable
 * `attendance.checked_in`/`checked_out` FACTS, but "what did I already do
 * today, offline or not" is UI-session state Absen needs so a refresh (or a
 * check-out attempt before the check-in fact has ever reached the cloud)
 * doesn't lose track of the attendanceId check-out must reuse, and doesn't
 * re-prompt "absen masuk" over an already-queued check-in.
 *
 * `attendanceId` is minted client-side at check-in time (the same
 * mint-once-reuse-on-retry idiom `ShiftOpenForm` uses for `shiftId`) and
 * reused for that day's check-out commit, so the cloud projector correlates
 * both facts onto one `attendance` row.
 */
export interface TodayAttendance {
  date: ISODate;
  /**
   * WHOSE day this is. Same requirement, and same reason, as
   * `pos/shift-store.ts`'s `OpenShift.kasirUserId` (MA-191): this blob is
   * persisted per browser profile and survives every logout, while an outlet
   * shares one machine between the pagi/siang/malam crews.
   *
   * Attendance is worse than the till, though, because `attendanceId` is the
   * row a CHECK-OUT writes to. `AbsenPanel.submit` falls back to
   * `localToday.attendanceId` whenever the server read hasn't got the
   * check-in yet — offline, or simply not synced — so an unscoped record let
   * the next person to log in on that browser clock OUT of the previous
   * person's attendance row and leave their own day never closed. There is no
   * handover reading of that, the way there is for a shift: an attendance row
   * is personal, so a record belonging to somebody else is simply not shown.
   */
  userId: UUID;
  attendanceId: UUID;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

interface AttendanceState {
  today: TodayAttendance | null;
  recordCheckIn: (date: ISODate, userId: UUID, attendanceId: UUID, at: string) => void;
  recordCheckOut: (at: string) => void;
  /** Clears stale state from a previous day so a new day starts fresh. */
  resetIfStale: (currentDate: ISODate) => void;
}

export const useMeAttendanceStore = create<AttendanceState>()(
  persist(
    (set, get) => ({
      today: null,
      recordCheckIn: (date, userId, attendanceId, at) =>
        set({ today: { date, userId, attendanceId, checkedInAt: at, checkedOutAt: null } }),
      recordCheckOut: (at) =>
        set((s) => (s.today ? { today: { ...s.today, checkedOutAt: at } } : s)),
      resetIfStale: (currentDate) => {
        const current = get().today;
        if (current && current.date !== currentDate) set({ today: null });
      },
    }),
    { name: 'mimi-me-attendance' },
  ),
);

/**
 * This device's record of today, but only if it is the signed-in employee's
 * own — see `TodayAttendance.userId`.
 *
 * Anything else reads as "no local record", which falls the panel back on
 * `getMyAttendance`, a read the server already scopes to the caller. A record
 * written before `userId` existed has none and so reads as someone else's,
 * which is the safe answer for a blob whose owner cannot be established.
 */
export function myLocalAttendance(
  today: TodayAttendance | null,
  userId: string | undefined,
): TodayAttendance | null {
  if (!today || !userId || today.userId !== userId) return null;
  return today;
}
