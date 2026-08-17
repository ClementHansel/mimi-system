/**
 * Wire-boundary type aliases (CONTRACTS.md §0 — binding for every agent).
 *
 * Money, quantity and temperature travel as decimal STRINGS on the wire and in
 * every JSON payload — never as JS `number`. This file only names the shape;
 * `./money`, `./qty`, and `./temp` own parsing, formatting, and arithmetic.
 * A mismatch here is a G1 blocker (BUILD-PLAN §5 W1-B, D-10).
 */
import type { ErrorCode } from './error-codes';

/** NUMERIC(18,2) decimal string, e.g. `"125000.00"`. Never a JS number. */
export type Money = string;

/** NUMERIC(14,3) decimal string, e.g. `"12.500"`. Never a JS number. */
export type Qty = string;

/** NUMERIC(4,1) decimal string, e.g. `"-18.0"`. Never a JS number. */
export type Temp = string;

/** Postgres UUID (v4 for entities, v7 for sync event ids — see @mimi/sync-protocol). */
export type UUID = string;

/** `'YYYY-MM-DD'`. */
export type ISODate = string;

/** ISO-8601 UTC timestamp, e.g. `"2026-08-17T02:31:00.000Z"`. */
export type ISODateTime = string;

/** Standard list envelope for every paginated endpoint (CONTRACTS.md §0). */
export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** The exception-filter error shape every endpoint returns on failure (CONTRACTS.md §0). */
export interface ApiErrorShape {
  statusCode: number;
  /** Stable machine key — the closed union from `./error-codes`, e.g. `ERR_STOCK_INSUFFICIENT`. */
  code: ErrorCode;
  message: string;
  details?: unknown;
}
