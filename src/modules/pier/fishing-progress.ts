import { ConflictException } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';

// Field positions in the saved Unity ProgressFile v10/v11.
const stock = [2, 5, 8, 9, 10, 11];
const prices = [4, 9, 6, 20, 14, 36];
const ranges = [
  [12, 28, 18, 160],
  [15, 45, 70, 1800],
  [25, 85, 180, 4600],
  [30, 95, 60, 1200],
  [35, 100, 450, 8500],
  [40, 125, 600, 12500],
];
export function specimen(species: number, slot: number, station: number) {
  const percentile = randomInt(1000),
    t = percentile / 999;
  const [cm, max, g, heavy] = ranges[species];
  return {
    id: randomUUID(),
    station,
    species,
    slot,
    rare: randomInt(128) === 0,
    percentile,
    length: Math.round(cm + (max - cm) * t),
    grams: Math.round(
      g + (heavy - g) * (((1 + (max / cm - 1) * t) ** 3 - 1) / ((max / cm) ** 3 - 1)),
    ),
  };
}
export type Specimen = ReturnType<typeof specimen>;
export type Outcome = 'caught' | 'escaped' | 'empty' | 'abandoned' | 'expired';
export class FishingProgress {
  private fields: string[];
  constructor(snapshot: string) {
    this.fields = snapshot ? snapshot.split('|') : Array<string>(49).fill('0');
    if (!snapshot) {
      this.fields[0] = '10';
      this.fields[48] = '';
    }
    if (this.fields[0] === '9' && this.fields.length === 48) {
      this.fields.push('');
      this.fields[0] = '10';
    }
    if (
      !(
        (this.fields[0] === '10' && this.fields.length === 49) ||
        (this.fields[0] === '11' && this.fields.length === 50)
      )
    )
      throw new ConflictException('Unsupported stored progress');
  }
  private get(i: number) {
    return Number(this.fields[i] || 0);
  }
  private set(i: number, n: number) {
    this.fields[i] = String(n);
  }
  private add(i: number, n: number) {
    this.set(i, this.get(i) + n);
  }
  private get measures() {
    return this.fields[48] ? this.fields[48].split(',').map(Number) : [];
  }
  encode() {
    return this.fields.join('|');
  }
  unlocked(station: number) {
    return station === 0 || this.get(station === 1 ? 6 : 13) === 1;
  }
  capacity() {
    return this.get(3) ? 5 : 3;
  }
  used() {
    return (
      stock.reduce((n, i) => n + this.get(i), 0) +
      this.measures.filter((code) => code % 1000 >= 750).length
    );
  }
  pass(station: number) {
    return this.get(station === 1 ? 16 : 17);
  }
  hasRoom(percentile: number) {
    return this.used() + (percentile >= 750 ? 2 : 1) <= this.capacity();
  }
  catch(f: Specimen, now: Date) {
    const mask = f.rare ? 18 : 15,
      bit = 1 << f.species;
    if (!(this.get(mask) & bit)) this.set(26 + 2 * f.species + Number(f.rare), dayNumber(now));
    this.set(mask, this.get(mask) | bit);
    this.add(stock[f.species], 1);
    if (f.rare) this.add(19 + f.species, 1);
    this.set(4, 1);
    this.fields[48] = [
      ...this.measures,
      (f.species * 2 + Number(f.rare)) * 1000 + f.percentile,
    ].join(',');
  }
  advance(station: number, caught: boolean, special: boolean, available: boolean) {
    if (!station) return;
    let pass = this.pass(station);
    if (pass >= 3 && available) pass = pass === 4 || (caught && special) ? 0 : 4;
    else if (caught && pass < 3) {
      const bit = station === 1 ? 1 : 2;
      pass++;
      if (pass === 2 && this.get(49) & bit) pass = 3;
      if (pass === 3) {
        this.set(0, 11);
        this.set(49, this.get(49) ^ bit);
      }
    }
    this.set(station === 1 ? 16 : 17, pass);
  }
  act(action: string, now: Date) {
    const require = (ok: boolean) => {
      if (!ok) throw new ConflictException('Action unavailable');
    };
    if (action === 'sell') {
      require(this.used() > 0);
      stock.forEach((idx, k) => {
        this.add(1, (this.get(idx) + 2 * this.get(19 + k)) * prices[k]);
        this.set(idx, 0);
        this.set(19 + k, 0);
      });
      this.fields[48] = '';
    } else if (['basket', 'rocks', 'point', 'rod'].includes(action)) {
      const rod = action === 'rod',
        level = this.get(12);
      const [idx, price] = rod
        ? [12, level === 0 ? 28 : 110]
        : action === 'basket'
          ? [3, 12]
          : action === 'rocks'
            ? [6, 40]
            : [13, 85];
      require(rod ? level < 2 && (!level || this.unlocked(2)) : !this.get(idx));
      require((action !== 'point' || this.unlocked(1)) && this.get(1) >= price);
      this.add(idx, 1);
      this.add(1, -price);
    } else if (action.startsWith('station')) {
      const station = Number(action.slice(-1));
      require(this.unlocked(station));
      this.set(7, Number(station === 1));
      this.set(14, Number(station === 2));
    } else {
      const chapter = this.get(38),
        today = dayNumber(now),
        seconds = Math.floor(now.getTime() / 1000);
      if (action === 'daily') {
        require(chapter === 3 && today > this.get(41) && !this.get(39) && !this.get(40));
        this.set(41, today);
        this.set(43, 0);
        this.set(44, 0);
        return;
      }
      require(
        chapter === 3
          ? this.get(41) > 0 && !this.get(44)
          : seconds >= this.get(42) && (chapter !== 2 || this.unlocked(2)),
      );
      if (action === 'read') {
        this.set(43, 1);
        return;
      }
      require(action === 'deliver');
      const orders = [
        [2, 2, 16, 0, 0],
        [2, 5, 40, 0, 0],
        [2, 2, 0, 5, 1],
        [0, 3, 24, 1, 1],
        [2, 3, 26, 0, 0],
        [4, 2, 40, 0, 0],
        [1, 2, 34, 2, 1],
      ];
      const [a, n, reward, b, m] = orders[chapter === 3 ? 3 + (this.get(41) % 4) : chapter];
      const take = (kind: number, needed: number) => {
        const total = this.get(stock[kind]),
          count = Math.min(total, needed),
          rare = Math.max(0, count - (total - this.get(19 + kind)));
        let common = count - rare,
          colored = rare;
        this.fields[48] = this.measures
          .filter((code) => {
            if (Math.floor(code / 2000) !== kind) return true;
            if (Math.floor(code / 1000) % 2) {
              if (colored > 0) {
                colored--;
                return false;
              }
            } else if (common > 0) {
              common--;
              return false;
            }
            return true;
          })
          .join(',');
        this.add(stock[kind], -count);
        this.add(19 + kind, -rare);
        return count;
      };
      const first = take(a, n - this.get(39)),
        second = take(b, m - this.get(40));
      require(first + second > 0);
      this.add(39, first);
      this.add(40, second);
      if (this.get(39) === n && this.get(40) === m) {
        this.add(1, reward);
        this.set(39, 0);
        this.set(40, 0);
        this.set(43, 0);
        if (chapter === 3) {
          this.set(45, this.get(45) | (1 << (this.get(41) % 4)));
          this.set(44, 1);
          this.set(41, Math.max(today, this.get(41)));
        } else {
          this.add(38, 1);
          this.set(42, seconds + 60);
        }
      }
    }
    require(this.get(1) <= 2147483647);
  }
}
export const dayNumber = (date: Date) => Number(date.toISOString().slice(0, 10).replace(/-/g, ''));
export const nightAt = (date: Date) => Math.cos(2 * Math.PI * (date.getTime() / 1200000)) < -0.19;
