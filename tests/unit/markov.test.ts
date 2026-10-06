import { describe, it, expect } from 'vitest';
import { solveMarkovChain } from '../../src/core/solvers/markov/markov';
import { Rational } from '../../src/core/math/rational';

const M = (rows: string[][]) => rows.map(r => r.map(x => Rational.parse(x)));

describe('markov', () => {
  it('steady state of a 2-state chain', () => {
    const r = solveMarkovChain({ transitionMatrix: M([['0.7', '0.3'], ['0.4', '0.6']]) });
    expect(r.steadyState!.distribution.map(String)).toEqual(['4/7', '3/7']);
    expect(r.irreducible).toBe(true);
    expect(r.firstPassage![0]![1]!.toString()).toBe('10/3');
    expect(r.firstPassage![0]![0]!.toString()).toBe('7/4');
  });
  it('rejects non-stochastic rows, naming row and sum', () => {
    const r = solveMarkovChain({ transitionMatrix: M([['0.5', '0.4'], ['0.4', '0.6']]) });
    expect(r.error).toMatch(/Row 1 sums to 9\/10/);
  });
  it('periodic chain flagged, stationary still given', () => {
    const r = solveMarkovChain({ transitionMatrix: M([['0', '1'], ['1', '0']]) });
    expect(r.periodic).toBe(true);
    expect(r.period).toBe(2);
    expect(r.steadyState!.distribution.map(String)).toEqual(['1/2', '1/2']);
    expect(r.steadyState!.limiting).toBe(false);
  });
  it('reducible chain with two closed classes', () => {
    const r = solveMarkovChain({ transitionMatrix: M([['1', '0', '0'], ['0', '1', '0'], ['0.5', '0.5', '0']]) });
    expect(r.classes.filter(c => c.closed)).toHaveLength(2);
    expect(r.diagnostics.some(d => d.code === 'REDUCIBLE')).toBe(true);
  });
  it('gambler-style absorbing chain', () => {
    const r = solveMarkovChain({ transitionMatrix: M([['1', '0', '0', '0'], ['0.5', '0', '0.5', '0'], ['0', '0.5', '0', '0.5'], ['0', '0', '0', '1']]) });
    expect(r.absorbing!.expectedSteps!.map(String)).toEqual(['2', '2']);
    expect(r.absorbing!.absorptionProbabilities![0]!.map(String)).toEqual(['2/3', '1/3']);
  });
  it('n-step and initial distribution', () => {
    const r = solveMarkovChain({ transitionMatrix: M([['0.7', '0.3'], ['0.4', '0.6']]), initialDistribution: M([['1', '0']])[0]! }, 2);
    expect(r.nStep!.distribution!.map(String)).toEqual(['61/100', '39/100']);
  });
});
