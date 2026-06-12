// The real-NYC neighborhood skeleton (PRD §4.1). Hand-authored data file;
// adjacency is symmetric, the graph is connected, landmarks are fictionalized
// where trademarked.

import neighborhoodsJson from '../../../content/neighborhoods.json';
import type { NeighborhoodSeed } from './types';

export function loadNeighborhoods(): NeighborhoodSeed[] {
  return neighborhoodsJson.neighborhoods as unknown as NeighborhoodSeed[];
}
