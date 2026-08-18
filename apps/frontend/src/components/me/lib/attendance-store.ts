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
  attendanceId: UUID;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

interface AttendanceState {
  today: TodayAttendance | null;
  recordCheckIn: (date: ISODate, attendanceId: UUID, at: string) => void;
  recordCheckOut: (at: string) => void;
  /** Clears stale state from a previous day so a new day starts fresh. */
  resetIfStale: (currentDate: ISODate) => void;
}

export const useMeAttendanceStore = create<AttendanceState>()(
  persist(
    (set, get) => ({
      today: null,
      recordCheckIn: (date, attendanceId, at) =>
        set({ today: { date, attendanceId, checkedInAt: at, checkedOutAt: null } }),
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
