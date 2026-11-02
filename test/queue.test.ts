import { describe, expect, it } from 'vitest';
import { backoffSeconds } from '../src/services/queue.js';

describe('backoffSeconds', () => {
  it('doubles from 30s and caps at 15 minutes', () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(4)).toBe(240);
    expect(backoffSeconds(5)).toBe(480);
    expect(backoffSeconds(6)).toBe(900);
    expect(backoffSeconds(20)).toBe(900);
    expect(backoffSeconds(0)).toBe(30);
  });
});
