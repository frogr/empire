// Shared test fixture: a small connected city so sim tests don't depend on the
// full neighborhoods.json data file.

import type { NeighborhoodSeed } from './content/types';

export function fixtureSeeds(): NeighborhoodSeed[] {
  const mk = (
    id: string, borough: NeighborhoodSeed['borough'], area: NeighborhoodSeed['area_type'],
    coastal: boolean, subway: string[], prosperity: number, pos: [number, number],
  ): NeighborhoodSeed => ({
    id, name: id.replace(/_/g, ' '), borough, area_type: area, coastal, subway, pos,
    adjacent: [],
    stats_2026: { population: 60000, prosperity, crime: 0.5, infrastructure: 0.5, faith: 0.5 },
  });
  const seeds = [
    mk('bushwick', 'brooklyn', 'rowhouse', false, ['L', 'M'], 0.4, [60, 55]),
    mk('red_basin', 'brooklyn', 'waterfront', true, ['F'], 0.3, [45, 65]),
    mk('iron_flats', 'queens', 'industrial', true, ['M'], 0.35, [70, 45]),
    mk('tower_green', 'bronx', 'projects', false, ['6'], 0.25, [55, 15]),
    mk('mid_spire', 'manhattan', 'grid_dense', false, ['L', '6'], 0.8, [40, 35]),
    mk('quiet_hills', 'staten_island', 'suburban', true, ['SIR'], 0.55, [20, 80]),
    mk('green_vale', 'queens', 'parkland', false, [], 0.5, [80, 30]),
    mk('hall_square', 'manhattan', 'civic', false, ['6'], 0.7, [38, 45]),
  ];
  seeds.forEach((s, i) => {
    s.adjacent = [seeds[(i + 1) % seeds.length].id, seeds[(i + seeds.length - 1) % seeds.length].id];
  });
  return seeds;
}
