import { describe, it, expect } from 'vitest';
import { solveZeroSumGame } from '../../src/core/solvers/games/zeroSum';
import { Rational } from '../../src/core/math/rational';
import { randInt, rng } from '../helpers/bruteLP';

const M = (rows: number[][]) => rows.map(r => r.map(x => Rational.of(x)));

describe('zero-sum games', () => {
  it('saddle point', () => {
    const r = solveZeroSumGame({ payoff: M([[3, 5, 4], [2, 1, 0]]) });
    expect(r.hasSaddlePoint).toBe(true);
    expect(r.gameValue.toString()).toBe('3');
  });
  it('matching pennies has value 0 with ½-½ strategies', () => {
    const r = solveZeroSumGame({ payoff: M([[1, -1], [-1, 1]]) });
    expect(r.hasSaddlePoint).toBe(false);
    expect(r.gameValue.toString()).toBe('0');
    expect(r.playerAStrategy.map(String)).toEqual(['1/2', '1/2']);
    expect(r.playerBStrategy.map(String)).toEqual(['1/2', '1/2']);
    expect(r.fair).toBe(true);
  });
  it('rock-paper-scissors is a fair 3×3 game', () => {
    const r = solveZeroSumGame({ payoff: M([[0, -1, 1], [1, 0, -1], [-1, 1, 0]]) });
    expect(r.gameValue.toString()).toBe('0');
    expect(r.playerAStrategy.map(String)).toEqual(['1/3', '1/3', '1/3']);
    expect(r.verified).toBe(true);
  });
  it('random games: both strategies verified optimal, graphical value matches LP value', () => {
    const r = rng(1234);
    for (let t = 0; t < 200; t++) {
      const m = randInt(r, 1, 4), n = randInt(r, 1, 4);
      const res = solveZeroSumGame({ payoff: M(Array.from({ length: m }, () => Array.from({ length: n }, () => randInt(r, -6, 9)))) });
      expect(res.error).toBeUndefined();
      expect(res.verified, JSON.stringify(res.playerAStrategy.map(String)) + JSON.stringify(res.playerBStrategy.map(String))).toBe(true);
      expect(res.maximin.lte(res.gameValue)).toBe(true);
      expect(res.gameValue.lte(res.minimax)).toBe(true);
      if (res.graphical) expect(res.graphical.value.eq(res.gameValue)).toBe(true);
    }
  });
});
