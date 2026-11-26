export interface ShopItem {
  itemId: string;
  category: 'basket' | 'rod' | 'expansion';
  priceCoins: number;
  requires: readonly string[];
}

// IDs match PierAnalytics.Purchased in the Unity client.
export const catalog: readonly ShopItem[] = [
  { itemId: 'large_basket', category: 'basket', priceCoins: 12, requires: [] },
  { itemId: 'reinforced_rod', category: 'rod', priceCoins: 28, requires: [] },
  { itemId: 'rocks_walkway', category: 'expansion', priceCoins: 40, requires: [] },
  { itemId: 'point_extension', category: 'expansion', priceCoins: 85, requires: ['rocks_walkway'] },
  {
    itemId: 'long_rod',
    category: 'rod',
    priceCoins: 110,
    requires: ['reinforced_rod', 'point_extension'],
  },
];
