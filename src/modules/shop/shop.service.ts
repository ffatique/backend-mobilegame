import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { catalog } from './catalog';

@Injectable()
export class ShopService {
  constructor(private readonly prisma: PrismaService) {}

  async buy(userId: string, itemId: string) {
    const item = catalog.find((entry) => entry.itemId === itemId);
    if (!item) throw new NotFoundException('Unknown shop item');

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (item.requires.length > 0) {
          const owned = await tx.purchase.count({
            where: { userId, itemId: { in: [...item.requires] } },
          });
          if (owned !== item.requires.length) {
            throw new ConflictException('Missing required upgrade');
          }
        }

        // The unique purchase also serializes concurrent attempts to buy this upgrade.
        await tx.purchase.create({ data: { userId, itemId, pricePaid: item.priceCoins } });
        const debit = await tx.user.updateMany({
          where: { id: userId, coins: { gte: item.priceCoins } },
          data: { coins: { decrement: item.priceCoins } },
        });
        if (debit.count === 0) throw new BadRequestException('Insufficient funds');

        const { coins } = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { coins: true },
        });
        return { status: 'purchased', itemId, pricePaid: item.priceCoins, coins };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Upgrade already owned');
      }
      throw error;
    }
  }
}
