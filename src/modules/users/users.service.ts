import { Injectable } from '@nestjs/common';
import type { VerifiedProviderIdentity } from '../auth/providers/provider-verifier.interface';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async signIn(identity: VerifiedProviderIdentity, preferredName?: string) {
    const { provider, providerUserId } = identity;
    const name = preferredName?.trim() || identity.displayName?.trim() || 'Pescador';
    return this.prisma.user.upsert({
      where: { provider_providerUserId: { provider, providerUserId } },
      create: { provider, providerUserId, name: Array.from(name).slice(0, 32).join('') },
      update: { providerUserId },
      select: { id: true },
    });
  }

  async profile(id: string) {
    const { purchases, ...player } = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        name: true,
        coins: true,
        gems: true,
        createdAt: true,
        purchases: { orderBy: { itemId: 'asc' }, select: { itemId: true } },
      },
    });
    return { ...player, ownedItemIds: purchases.map((purchase) => purchase.itemId) };
  }
}
