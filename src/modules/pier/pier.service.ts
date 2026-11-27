import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  type CastDto,
  type FinishDto,
  type ActionDto,
  type WardrobeDto,
  wardrobePrices,
} from './pier.dto';

import {
  FishingProgress,
  nightAt,
  specimen,
  type Specimen,
  type Outcome,
} from './fishing-progress';
import { randomInt } from 'node:crypto';
type Attempt = Omit<Specimen, 'id'> & {
  id: string;
  fishId: string | null;
  canLand: boolean;
  outcome: Outcome | null;
  finishKey: string | null;
  passAvailable: boolean;
  newRecord: boolean;
};
const publicFields = { id: true, name: true, avatar: true } as const;

@Injectable()
export class PierService {
  constructor(private readonly db: PrismaService) {}

  private async load(tx: Prisma.TransactionClient, id: string) {
    await tx.$executeRaw`INSERT INTO pier_saves ("playerId") VALUES (${id}::uuid) ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT "playerId" FROM pier_saves WHERE "playerId"=${id}::uuid FOR UPDATE`;
    await tx.$executeRaw`UPDATE pier_saves SET bait=12, day=(statement_timestamp() AT TIME ZONE 'UTC')::date
      WHERE "playerId"=${id}::uuid AND day < (statement_timestamp() AT TIME ZONE 'UTC')::date`;
    await tx.$executeRaw`INSERT INTO pier_activity_days ("playerId",day)
      VALUES (${id}::uuid,(statement_timestamp() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING`;
    return tx.pierSave.findUniqueOrThrow({ where: { playerId: id } });
  }

  async state(id: string) {
    return this.db.$transaction(async (tx) => {
      const save = await this.load(tx, id);
      const profile = await tx.user.findUniqueOrThrow({
        where: { id },
        select: { ...publicFields, coins: true, gems: true },
      });
      const used = await tx.baitOperation.count({
        where: { playerId: id, kind: 'ad', day: save.day },
      });
      return {
        ...save,
        ...profile,
        bait: save.bait + save.bonusBait,
        adSlots: Math.max(0, 3 - used),
        day: save.day.toISOString().slice(0, 10),
      };
    });
  }

  private async putFish(tx: Prisma.TransactionClient, player: string, fish: Specimen[]) {
    const values = fish.map(
      (f) =>
        Prisma.sql`(${player}::uuid,${f.id}::uuid,${f.station},${f.species},${f.slot},${f.rare},${f.percentile},${f.length},${f.grams})`,
    );
    await tx.$executeRaw`INSERT INTO pier_schools ("playerId",id,station,species,slot,rare,percentile,length,grams)
      VALUES ${Prisma.join(values)}`;
  }

  private async expire(tx: Prisma.TransactionClient, id: string) {
    await tx.$executeRaw`UPDATE pier_attempts SET outcome='expired',"closedAt"=now()
      WHERE "playerId"=${id}::uuid AND outcome IS NULL AND "openedAt" <= now()-interval '3 minutes'`;
  }

  async school(id: string) {
    return this.db.$transaction(async (tx) => {
      const save = await this.load(tx, id),
        progress = new FishingProgress(save.snapshot);
      await this.expire(tx, id);
      let rows = await tx.$queryRaw<
        Specimen[]
      >`SELECT * FROM pier_schools WHERE "playerId"=${id}::uuid ORDER BY station,species,slot`;
      if (!rows.length) {
        rows = [];
        for (const [station, species, residents, visitors] of [
          [0, 0, 4, 0],
          [0, 2, 1, 2],
          [1, 1, 3, 2],
          [1, 3, 1, 0],
          [2, 4, 3, 2],
          [2, 5, 1, 0],
        ]) {
          const count = residents + (visitors && randomInt(2) ? visitors : 0);
          for (let slot = 0; slot < count; slot++) {
            const fish = specimen(species, slot, station);
            rows.push(fish);
          }
        }
        await this.putFish(tx, id, rows);
      }
      const now = new Date(),
        night = nightAt(now);
      const active = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM pier_attempts WHERE "playerId"=${id}::uuid AND outcome IS NULL`;
      return {
        night,
        serverTime: now.toISOString(),
        revision: save.revision,
        active: active[0]?.id,
        items: rows.filter(
          (f) => progress.unlocked(f.station) && this.available(f, progress, night),
        ),
      };
    });
  }

  private available(fish: Specimen, p: FishingProgress, night: boolean) {
    if (fish.species === 3 || fish.species === 5)
      return (fish.species === 5) === night && p.pass(fish.station) >= 3;
    return true;
  }

  async cast(id: string, dto: CastDto) {
    return this.db
      .$transaction(async (tx) => {
        const state = await this.load(tx, id),
          p = new FishingProgress(state.snapshot);
        await this.expire(tx, id);
        const [prior] = await tx.$queryRaw<
          Attempt[]
        >`SELECT * FROM pier_attempts WHERE "playerId"=${id}::uuid AND id=${dto.key}::uuid`;
        if (prior) {
          if (prior.station !== dto.station || prior.fishId !== (dto.fishId ?? null))
            throw new ConflictException('Cast key already used');
          Logger.log({ event: 'pier.cast.replay', player: id, attempt: prior.id });
          return { id: prior.id, outcome: prior.outcome, bait: state.bait + state.bonusBait };
        }
        const [open] = await tx.$queryRaw<
          Attempt[]
        >`SELECT id FROM pier_attempts WHERE "playerId"=${id}::uuid AND outcome IS NULL`;
        if (open || !p.unlocked(dto.station) || (!state.bait && !state.bonusBait))
          throw new ConflictException('Cast unavailable');
        let fish: Specimen | undefined;
        const night = nightAt(new Date());
        if (dto.fishId) {
          [fish] = await tx.$queryRaw<
            Specimen[]
          >`SELECT * FROM pier_schools WHERE "playerId"=${id}::uuid AND id=${dto.fishId}::uuid AND station=${dto.station}`;
          if (!fish || !this.available(fish, p, night))
            throw new ConflictException('Reload school');
        }
        if (!p.hasRoom(fish?.percentile ?? 0)) throw new ConflictException('Basket full');
        await tx.$executeRaw`INSERT INTO pier_attempts ("playerId",id,station,"fishId",species,rare,percentile,length,grams,"passAvailable")
        VALUES (${id}::uuid,${dto.key}::uuid,${dto.station},${fish?.id ?? null}::uuid,${fish?.species ?? null},${fish?.rare ?? null},
        ${fish?.percentile ?? null},${fish?.length ?? null},${fish?.grams ?? null},${dto.station === 1 ? !night : night})`;
        await tx.pierSave.update({
          where: { playerId: id },
          data: state.bait ? { bait: { decrement: 1 } } : { bonusBait: { decrement: 1 } },
        });
        return { id: dto.key, outcome: null, bait: state.bait + state.bonusBait - 1, paid: true };
      })
      .then((result) => {
        if ('paid' in result)
          Logger.log({ event: 'pier.cast.paid', player: id, attempt: dto.key, fish: dto.fishId });
        return result;
      });
  }

  async finish(id: string, dto: FinishDto) {
    return this.db
      .$transaction(async (tx) => {
        const state = await this.load(tx, id),
          p = new FishingProgress(state.snapshot);
        await this.expire(tx, id);
        const [a] = await tx.$queryRaw<
          Attempt[]
        >`SELECT *, clock_timestamp() >= "openedAt" + interval '3.2 seconds' AS "canLand" FROM pier_attempts WHERE "playerId"=${id}::uuid AND id=${dto.attempt}::uuid`;
        if (!a) throw new NotFoundException();
        const outcome: Outcome = dto.outcome;
        let record = false;
        if (a.outcome) {
          if (a.outcome === 'expired') return { outcome: a.outcome, newRecord: false, offer: 0 };
          if (a.finishKey !== dto.key || a.outcome !== outcome) {
            Logger.warn({ event: 'pier.finish.duplicate_rejected', player: id, attempt: a.id });
            throw new ConflictException('Attempt already closed');
          }
          Logger.log({ event: 'pier.finish.replay', player: id, attempt: a.id });
          return {
            outcome: a.outcome,
            newRecord: a.newRecord,
            offer: a.outcome === 'caught' ? await this.adOffer(tx, id, state.day) : 0,
          };
        }
        const now = new Date();
        if (outcome === 'caught') {
          if (!a.fishId || !a.canLand || !p.hasRoom(a.percentile))
            throw new ConflictException('Invalid catch');
          const [f] = await tx.$queryRaw<
            Specimen[]
          >`SELECT * FROM pier_schools WHERE "playerId"=${id}::uuid AND id=${a.fishId}::uuid`;
          if (!f) throw new ConflictException('Specimen gone');
          const best = await tx.pierCatch.aggregate({
            where: { playerId: id, species: f.species },
            _max: { length: true },
          });
          record = f.length > (best._max.length ?? 0);
          p.catch(f, now);
          await tx.pierCatch.create({
            data: {
              playerId: id,
              revision: state.revision + 1,
              species: f.species,
              rare: f.rare,
              length: f.length,
              grams: f.grams,
              size: ['S', 'M', 'L', 'XL'][Math.floor(f.percentile / 250)],
            },
          });
          await tx.$executeRaw`DELETE FROM pier_schools WHERE id=${f.id}::uuid`;
          await this.putFish(tx, id, [specimen(f.species, f.slot, f.station)]);
        }
        p.advance(
          a.station,
          outcome === 'caught',
          a.species === 3 || a.species === 5,
          a.passAvailable,
        );
        await tx.pierSave.update({
          where: { playerId: id },
          data: { snapshot: p.encode(), revision: { increment: 1 }, mutation: dto.key },
        });
        await tx.$executeRaw`UPDATE pier_attempts SET outcome=${outcome},"closedAt"=now(),"finishKey"=${dto.key}::uuid,"newRecord"=${record}
        WHERE "playerId"=${id}::uuid AND id=${a.id}::uuid`;
        return {
          outcome,
          newRecord: record,
          offer: outcome === 'caught' ? await this.adOffer(tx, id, state.day) : 0,
          closed: true,
        };
      })
      .then((result) => {
        if ('closed' in result)
          Logger.log({
            event: 'pier.finish',
            player: id,
            attempt: dto.attempt,
            outcome: result.outcome,
          });
        return result;
      });
  }

  async action(id: string, dto: ActionDto) {
    return this.db.$transaction(async (tx) => {
      const state = await this.load(tx, id);
      if (state.mutation === dto.key) return { revision: state.revision };
      await this.expire(tx, id);
      const [active] = await tx.$queryRaw<
        Attempt[]
      >`SELECT id FROM pier_attempts WHERE "playerId"=${id}::uuid AND outcome IS NULL`;
      if (active || state.revision !== dto.revision) throw new ConflictException('Reload progress');
      const p = new FishingProgress(state.snapshot);
      p.act(dto.action, new Date());
      return tx.pierSave.update({
        where: { playerId: id },
        data: { snapshot: p.encode(), mutation: dto.key, revision: { increment: 1 } },
        select: { revision: true },
      });
    });
  }

  private async adOffer(tx: Prisma.TransactionClient, id: string, day: Date) {
    const milestone = await tx.pierCatch.count({ where: { playerId: id } });
    if (!milestone || milestone % 5) return 0;
    const used = await tx.baitOperation.count({ where: { playerId: id, kind: 'ad', day } });
    if (used >= 3) return 0;
    const opened = await tx.baitOperation.findUnique({
      where: { playerId_milestone: { playerId: id, milestone } },
    });
    return opened ? 0 : milestone;
  }

  async baitOperation(id: string, key: string, kind: 'ad' | 'purchase', milestone?: number) {
    return this.db.$transaction(async (tx) => {
      const state = await this.load(tx, id);
      const prior = await tx.baitOperation.findUnique({ where: { id: key } });
      if (prior) {
        if (
          prior.playerId !== id ||
          prior.kind !== kind ||
          (kind === 'ad' && prior.milestone !== milestone)
        )
          throw new ConflictException('Operation already used');
        return { ticket: key };
      }
      if (kind === 'ad') {
        const count = await tx.pierCatch.count({ where: { playerId: id } });
        if (!milestone || milestone % 5 !== 0 || milestone !== Math.floor(count / 5) * 5)
          throw new ConflictException('No offer available');
        const used = await tx.baitOperation.count({
          where: { playerId: id, kind, day: state.day },
        });
        if (
          used >= 3 ||
          (await tx.baitOperation.findUnique({
            where: { playerId_milestone: { playerId: id, milestone } },
          }))
        )
          throw new ConflictException('Offer already used');
      } else {
        const paid = await tx.user.updateMany({
          where: { id, gems: { gte: 1 } },
          data: { gems: { decrement: 1 } },
        });
        if (!paid.count) throw new ConflictException('Not enough gems');
        await tx.pierSave.update({
          where: { playerId: id },
          data: { bonusBait: { increment: 3 } },
        });
      }
      await tx.baitOperation.create({
        data: { id: key, playerId: id, day: state.day, kind, milestone },
      });
      return { ticket: key };
    });
  }

  async wardrobe(id: string, { item, action }: WardrobeDto) {
    return this.db.$transaction(async (tx) => {
      const save = await this.load(tx, id);
      const slot = item === 'hat' ? 'hat' : 'outfit';
      if (action === 'buy' && !save.owned.includes(item)) {
        const gems = wardrobePrices[item];
        const paid = await tx.user.updateMany({
          where: { id, gems: { gte: gems } },
          data: { gems: { decrement: gems } },
        });
        if (!paid.count) throw new ConflictException('Not enough gems');
        await tx.pierSave.update({
          where: { playerId: id },
          data: { owned: { push: item } },
        });
      } else if (action !== 'buy') {
        if (!save.owned.includes(item)) throw new ConflictException('Item not owned');
        if (action === 'equip' || save[slot] === item)
          await tx.pierSave.update({
            where: { playerId: id },
            data: { [slot]: action === 'equip' ? item : null },
          });
      }
      const wardrobe = await tx.pierSave.findUniqueOrThrow({
        where: { playerId: id },
        select: { owned: true, outfit: true, hat: true },
      });
      const wallet = await tx.user.findUniqueOrThrow({ where: { id }, select: { gems: true } });
      return { ...wardrobe, ...wallet };
    });
  }

  async refill() {
    const start = Date.now();
    try {
      return await this.db
        .$transaction(async (tx) => {
          const updated =
            await tx.$executeRaw`UPDATE pier_saves SET bait=12, day=(statement_timestamp() AT TIME ZONE 'UTC')::date
      WHERE day < (statement_timestamp() AT TIME ZONE 'UTC')::date`;
          const duration = Date.now() - start;
          await tx.$executeRaw`INSERT INTO pier_refills (accounts,duration_ms) VALUES (${updated},${duration})`;
          return { updated };
        })
        .then((result) => {
          Logger.log({
            event: 'bait.refill',
            utc: new Date().toISOString(),
            result: 'success',
            accounts: result.updated,
            durationMs: Date.now() - start,
          });
          return result;
        });
    } catch (error) {
      Logger.error({
        event: 'bait.refill',
        utc: new Date().toISOString(),
        result: 'failure',
        accounts: 0,
        durationMs: Date.now() - start,
      });
      throw error;
    }
  }

  async history(id: string, before: number) {
    return {
      items: await this.db.pierCatch.findMany({
        where: { playerId: id, revision: { lt: before } },
        orderBy: { revision: 'desc' },
        take: 50,
        select: {
          revision: true,
          species: true,
          rare: true,
          length: true,
          grams: true,
          size: true,
          caughtAt: true,
        },
      }),
    };
  }
  async stats(id: string) {
    const [total, variants, days, biggest] = await Promise.all([
      this.db.pierCatch.count({ where: { playerId: id } }),
      this.db.pierCatch.groupBy({ by: ['species', 'rare'], where: { playerId: id } }),
      this.db.pierActivityDay.count({ where: { playerId: id } }),
      this.db.pierCatch.findFirst({
        where: { playerId: id },
        orderBy: [{ length: 'desc' }, { grams: 'desc' }],
        select: { length: true, species: true },
      }),
    ]);
    return {
      total,
      species: new Set(variants.map((v) => v.species)).size,
      album: variants.length,
      days,
      largest: biggest?.length ?? 0,
      kind: biggest?.species ?? 0,
    };
  }
  async search(id: string, q: string) {
    const name = typeof q === 'string' ? q.trim().toLowerCase() : '';
    if (name.length < 2 || name.length > 32)
      throw new BadRequestException('Use 2 to 32 characters');
    const prefix = name.replace(/[\\%_]/g, '\\$&') + '%';
    return {
      items: await this.db
        .$queryRaw`SELECT id,name,avatar FROM players WHERE id <>${id}::uuid AND lower(name) LIKE ${prefix} ORDER BY lower(name),id LIMIT 30`,
    };
  }
  async friends(id: string) {
    const rows = await this.db.friendship.findMany({
      where: { OR: [{ low: id }, { high: id }] },
      include: { first: { select: publicFields }, second: { select: publicFields } },
      orderBy: [{ low: 'asc' }, { high: 'asc' }],
    });
    return {
      items: rows.map((row) => ({
        ...(row.low === id ? row.second : row.first),
        status: row.accepted ? 'friend' : row.sender === id ? 'sent' : 'received',
      })),
    };
  }
  async friend(id: string, other: string, action: string) {
    other = other.toLowerCase();
    if (id === other) throw new BadRequestException('Choose another player');
    const [low, high] = [id, other].sort();
    if (action === 'send') {
      try {
        await this.db.friendship.create({ data: { low, high, sender: id } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if (error.code === 'P2002') throw new ConflictException('Request already exists');
          if (error.code === 'P2003') throw new NotFoundException();
        }
        throw error;
      }
    } else {
      const where = { low, high, sender: other, accepted: false };
      const result =
        action === 'accept'
          ? await this.db.friendship.updateMany({ where, data: { accepted: true } })
          : await this.db.friendship.deleteMany({ where });
      if (result.count !== 1) throw new NotFoundException('No incoming request');
    }
    return { ok: true };
  }
}
