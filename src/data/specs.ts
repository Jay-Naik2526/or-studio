/**
 * Serialisable ("spec") forms of every module's input. Numbers stay as strings so fractions survive
 * save / load / share-URL round trips exactly.
 */

export type ModuleId = 'lp' | 'integer' | 'transport' | 'assign' | 'network' | 'project' | 'queuing' | 'inventory' | 'games' | 'markov' | 'simulation' | 'nlp';

export interface LPSpec { text: string }

export interface TransportSpec {
  rows: string[]; cols: string[];
  costs: string[][];       // "M"/"x" = prohibited route
  supply: string[]; demand: string[];
  objective: 'min' | 'max';
}

export interface AssignSpec { rows: string[]; cols: string[]; costs: string[][]; objective: 'min' | 'max' }

export interface GraphSpec {
  nodes: { id: string; label: string; x: number; y: number }[];
  edges: { id: string; from: string; to: string; weight: string; capacity: string; directed: boolean }[];
  source: string; sink: string;
  sources: string[]; sinks: string[];
}

export interface ProjectSpec {
  activities: { id: string; pred: string; duration: string; a: string; m: string; b: string; normalCost: string; crashDuration: string; crashCost: string }[];
  deadline: string;
  target: string; // PERT target time
}

export interface QueueSpec {
  model: 'mm1' | 'mmc' | 'mm1n' | 'mmcn' | 'mmcnn' | 'mg1';
  lambda: string; mu: string; servers: string; capacity: string; sigma: string;
  Cs: string; Cw: string; basis: 'system' | 'queue';
}

export interface InventorySpec {
  model: 'eoq' | 'epq' | 'shortage' | 'discount' | 'newsvendor';
  D: string; K: string; h: string; hRate: boolean; c: string; L: string; k: string; p: string;
  breaks: { minQty: string; price: string }[]; discountType: 'allUnits' | 'incremental';
  price: string; salvage: string; goodwill: string;
  dist: 'normal' | 'uniform' | 'discrete'; mean: string; sd: string; umin: string; umax: string;
  discrete: { demand: string; prob: string }[];
}

export interface GameSpec { rows: string[]; cols: string[]; payoff: string[][] }

export interface MarkovSpec { names: string[]; P: string[][]; init: string[]; n: string }

export interface DistSpec { type: 'uniform' | 'exponential' | 'normal' | 'triangular' | 'poisson' | 'discrete' | 'constant'; p1: string; p2: string; p3: string; values: string }

export interface SimSpec {
  kind: 'montecarlo' | 'queue';
  seed: string; generator: 'lcg' | 'mt';
  vars: { name: string; dist: DistSpec }[];
  expression: string; trials: string; threshold: string;
  interarrival: DistSpec; service: DistSpec; servers: string; customers: string; warmup: string;
}

export interface NLPSpec {
  tab: 'unconstrained' | 'kkt' | 'qp';
  expression: string; start: string; method: 'gradient' | 'newton';
  constraints: { expr: string; kind: 'le' | 'eq' }[]; point: string;
  Q: string[][]; c: string[]; A: string[][]; b: string[];
}
