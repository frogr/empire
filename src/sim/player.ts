// Player character: stats, use-trained skills, inventory, injuries, needs.

import { Rand } from './rng';
import { ITEM_BY_ID } from './content';
import type { ItemDef, OriginDef, SkillId, StatId } from './content/types';

export const SKILLS: SkillId[] = [
  'melee', 'firearms', 'sneak', 'streetwise', 'tech', 'theology', 'athletics', 'trade', 'medicine',
];
export const STATS: StatId[] = ['STR', 'AGI', 'END', 'WIT', 'CHA', 'NRV'];

export interface ItemStack {
  id: string;
  qty: number;
}

export type InjuryKind = 'bleeding' | 'concussion' | 'limp' | 'bruised_ribs';

export interface Injury {
  kind: InjuryKind;
  severity: number; // 1..3
  turns: number; // age, for natural healing of minor ones
}

export const INJURY_LABEL: Record<InjuryKind, string> = {
  bleeding: 'bleeding',
  concussion: 'concussion',
  limp: 'limp',
  bruised_ribs: 'bruised ribs',
};

export class PlayerChar {
  name: string;
  originId: string;
  stats: Record<StatId, number>;
  skillXp: Record<SkillId, number>;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  hunger = 15; // 0 fed .. 100 starving
  money: number;
  inventory: ItemStack[] = [];
  weapon: string | null = null; // item id
  armor: string | null = null;
  injuries: Injury[] = [];

  constructor(name: string, origin: OriginDef, r: Rand) {
    this.name = name;
    this.originId = origin.id;
    this.stats = { ...origin.stats };
    this.skillXp = Object.fromEntries(SKILLS.map((s) => [s, 0])) as Record<SkillId, number>;
    for (const [s, lvl] of Object.entries(origin.skills)) {
      this.skillXp[s as SkillId] = xpForLevel(lvl);
    }
    this.maxHp = this.stats.END * 4 + 10;
    this.hp = this.maxHp;
    this.maxStamina = this.stats.END * 3 + this.stats.AGI * 2;
    this.stamina = this.maxStamina;
    this.money = r.int(origin.money[0], origin.money[1]);
    for (const it of origin.items) this.gain(it.id, it.qty);
    const weapon = this.inventory.find((s) => ITEM_BY_ID.get(s.id)?.kind === 'weapon');
    if (weapon) this.weapon = weapon.id;
    const armor = this.inventory.find((s) => ITEM_BY_ID.get(s.id)?.kind === 'armor');
    if (armor) this.armor = armor.id;
  }

  skill(s: SkillId): number {
    return levelForXp(this.skillXp[s]);
  }

  /** Use-trained: every meaningful use grants xp (Kenshi-style). */
  train(s: SkillId, amount = 1): boolean {
    const before = this.skill(s);
    this.skillXp[s] += amount;
    return levelForXp(this.skillXp[s]) > before;
  }

  gain(id: string, qty = 1): void {
    const def = ITEM_BY_ID.get(id);
    if (!def) return;
    const existing = this.inventory.find((s) => s.id === id);
    if (existing) existing.qty += qty;
    else this.inventory.push({ id, qty });
  }

  /** Remove qty of an item; returns false if not enough. */
  spend(id: string, qty = 1): boolean {
    const stack = this.inventory.find((s) => s.id === id);
    if (!stack || stack.qty < qty) return false;
    stack.qty -= qty;
    if (stack.qty <= 0) {
      this.inventory = this.inventory.filter((s) => s !== stack);
      if (this.weapon === id && !this.inventory.some((s) => s.id === id)) this.weapon = null;
      if (this.armor === id && !this.inventory.some((s) => s.id === id)) this.armor = null;
    }
    return true;
  }

  weaponDef(): ItemDef | null {
    return this.weapon ? ITEM_BY_ID.get(this.weapon) ?? null : null;
  }

  armorValue(): number {
    const def = this.armor ? ITEM_BY_ID.get(this.armor) : null;
    return def?.armor ?? 0;
  }

  has(kind: InjuryKind): Injury | undefined {
    return this.injuries.find((i) => i.kind === kind);
  }

  injure(kind: InjuryKind, severity = 1): void {
    const existing = this.has(kind);
    if (existing) existing.severity = Math.min(3, existing.severity + severity);
    else this.injuries.push({ kind, severity, turns: 0 });
  }

  /** Net worth = cash + everything carried, at face value (PRD: money is score). */
  netWorth(): number {
    let total = this.money;
    for (const s of this.inventory) total += (ITEM_BY_ID.get(s.id)?.value ?? 0) * s.qty;
    return total;
  }
}

export function xpForLevel(lvl: number): number {
  // 0,10,30,60,100,150...
  return (lvl * (lvl + 1) * 10) / 2;
}

export function levelForXp(xp: number): number {
  let lvl = 0;
  while (xpForLevel(lvl + 1) <= xp) lvl++;
  return lvl;
}
