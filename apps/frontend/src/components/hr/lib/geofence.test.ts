import { describe, expect, it } from 'vitest';
import { evaluateGeofence, haversineDistanceMeters } from './geofence';

describe('haversineDistanceMeters', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineDistanceMeters('-1.234567', '116.123456', '-1.234567', '116.123456')).toBe(0);
  });

  it('returns null when a coordinate is unparseable', () => {
    expect(haversineDistanceMeters('not-a-number', '116.1', '-1.2', '116.1')).toBeNull();
  });

  it('computes a known short distance (~1 minute of latitude ≈ 1852 m)', () => {
    // 1 minute of latitude (1/60 degree) is ~1852 m regardless of longitude.
    const d = haversineDistanceMeters('0.000000', '116.000000', '0.016667', '116.000000');
    expect(d).not.toBeNull();
    expect(d as number).toBeGreaterThan(1800);
    expect(d as number).toBeLessThan(1900);
  });

  it('is symmetric', () => {
    const a = haversineDistanceMeters('-1.25', '116.10', '-1.30', '116.15');
    const b = haversineDistanceMeters('-1.30', '116.15', '-1.25', '116.10');
    expect(a).toBe(b);
  });
});

describe('evaluateGeofence', () => {
  it('flags withinRadius=null when the location has no configured geometry', () => {
    const result = evaluateGeofence('-1.25', '116.10', null, null, 100);
    expect(result).toEqual({ distanceM: null, radiusM: 100, withinRadius: null });
  });

  it('passes when the capture point is inside the radius', () => {
    const result = evaluateGeofence('-1.234567', '116.123456', '-1.234567', '116.123456', 100);
    expect(result.distanceM).toBe(0);
    expect(result.withinRadius).toBe(true);
  });

  it('fails when the capture point is outside the radius, and still reports the exact distance', () => {
    // ~1852 m north of the location centre, radius 100 m.
    const result = evaluateGeofence('0.016667', '116.000000', '0.000000', '116.000000', 100);
    expect(result.distanceM).not.toBeNull();
    expect(result.distanceM as number).toBeGreaterThan(100);
    expect(result.withinRadius).toBe(false);
  });

  it('treats the radius as inclusive (distance exactly equal to radius passes)', () => {
    // Construct a point whose computed distance rounds to exactly the radius.
    const distanceAt100 = haversineDistanceMeters('0.0009', '116.0', '0.0', '116.0')!;
    const result = evaluateGeofence('0.0009', '116.0', '0.0', '116.0', distanceAt100);
    expect(result.withinRadius).toBe(true);
  });
});
