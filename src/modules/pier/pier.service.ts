import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { type SaveDto, type WardrobeDto, wardrobePrices } from './pier.dto';

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

  async save(id: string, dto: SaveDto) {
    return this.db.$transaction(async (tx) => {
      const state = await this.load(tx, id);
      if (state.mutation === dto.mutation) {
        const caught = await tx.pierCatch.findUnique({
          where: { playerId_revision: { playerId: id, revision: state.revision } },
        });
        return {
          ...state,
          bait: state.bait + state.bonusBait,
          offer: caught ? await this.adOffer(tx, id, state.day) : 0,
        };
      }
      if (state.revision !== dto.revision || state.bait + state.bonusBait < dto.spend)
        throw new ConflictException('Reload progress');
      const revision = state.revision + 1;
      if (dto.capture)
        await tx.pierCatch.create({ data: { playerId: id, revision, ...dto.capture } });
      const saved = await tx.pierSave.update({
        where: { playerId: id },
        data: {
          revision,
          snapshot: dto.snapshot,
          mutation: dto.mutation,
          bait: { decrement: Math.min(state.bait, dto.spend) },
          bonusBait: { decrement: Math.max(0, dto.spend - state.bait) },
        },
      });
      const offer = dto.capture ? await this.adOffer(tx, id, state.day) : 0;
      return { ...saved, bait: saved.bait + saved.bonusBait, offer };
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
    const updated = await this.db
      .$executeRaw`UPDATE pier_saves SET bait=12, day=(statement_timestamp() AT TIME ZONE 'UTC')::date
      WHERE day < (statement_timestamp() AT TIME ZONE 'UTC')::date`;
    return { updated };
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
