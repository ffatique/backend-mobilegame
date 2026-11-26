import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SaveDto } from './pier.dto';

const publicFields = { id: true, name: true, avatar: true } as const;

@Injectable()
export class PierService {
  constructor(private readonly db: PrismaService) {}

  private async load(tx: Prisma.TransactionClient, id: string) {
    await tx.$executeRaw`INSERT INTO pier_saves ("playerId") VALUES (${id}::uuid) ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT "playerId" FROM pier_saves WHERE "playerId"=${id}::uuid FOR UPDATE`;
    await tx.$executeRaw`UPDATE pier_saves SET bait=12, day=(statement_timestamp() AT TIME ZONE 'UTC')::date
      WHERE "playerId"=${id}::uuid AND day < (statement_timestamp() AT TIME ZONE 'UTC')::date`;
    return tx.pierSave.findUniqueOrThrow({ where: { playerId: id } });
  }

  async state(id: string) {
    return this.db.$transaction(async (tx) => {
      const save = await this.load(tx, id);
      const profile = await tx.user.findUniqueOrThrow({
        where: { id },
        select: { ...publicFields, coins: true, gems: true },
      });
      return { ...save, ...profile, day: save.day.toISOString().slice(0, 10) };
    });
  }

  async save(id: string, dto: SaveDto) {
    return this.db.$transaction(async (tx) => {
      const state = await this.load(tx, id);
      if (state.mutation === dto.mutation) return state;
      if (state.revision !== dto.revision || state.bait < dto.spend)
        throw new ConflictException('Reload progress');
      const revision = state.revision + 1;
      if (dto.capture)
        await tx.pierCatch.create({ data: { playerId: id, revision, ...dto.capture } });
      return tx.pierSave.update({
        where: { playerId: id },
        data: {
          revision,
          snapshot: dto.snapshot,
          mutation: dto.mutation,
          bait: { decrement: dto.spend },
        },
      });
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
    const [total, species, biggest] = await Promise.all([
      this.db.pierCatch.count({ where: { playerId: id } }),
      this.db.pierCatch.groupBy({ by: ['species'], where: { playerId: id } }),
      this.db.pierCatch.findFirst({
        where: { playerId: id },
        orderBy: [{ length: 'desc' }, { grams: 'desc' }],
        select: { length: true, species: true },
      }),
    ]);
    return {
      total,
      species: species.length,
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
