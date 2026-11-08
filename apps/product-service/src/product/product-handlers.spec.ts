import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryService } from '../category/category.service.js';
import { ServiceHandlers } from '../service-handlers.js';
import { ProductService } from './product.service.js';
import { ReservationService } from '../reservation/reservation.service.js';
import type { EventHandlers, HttpHandlers } from '@app/common';

type TestRequest = {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  principal?: { sub: string; role: 'SELLER' };
};

describe('Product HTTP handlers', () => {
  const registered = new Map<
    string,
    (request: TestRequest) => Promise<unknown>
  >();
  const http = {
    register: vi.fn(
      (
        operationId: string,
        handler: (request: TestRequest) => Promise<unknown>,
      ) => registered.set(operationId, handler),
    ),
  };
  const categories = {};
  const products = {
    list: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: 'product-id' }),
    findById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const reservations = {
    reserve: vi.fn(),
  };

  beforeEach(() => {
    registered.clear();
    vi.clearAllMocks();
    new ServiceHandlers(
      http as unknown as HttpHandlers,
      {} as EventHandlers,
      categories as unknown as CategoryService,
      products as unknown as ProductService,
      reservations as unknown as ReservationService,
    ).onModuleInit();
  });

  it('registers every Product CRUD and reservation operation from the contract', () => {
    expect(
      [
        'product_get__api_products',
        'product_post__api_products',
        'product_get__api_products_id',
        'product_patch__api_products_id',
        'product_delete__api_products_id',
        'product_put__internal_products_id_auction-reservation',
      ].every((operationId) => registered.has(operationId)),
    ).toBe(true);
  });

  it('uses the authenticated principal subject as the create sellerId', async () => {
    const body = {
      categoryId: 'category-id',
      title: 'Camera',
      description: 'Film camera',
    };
    const handler = registered.get('product_post__api_products');
    if (!handler) throw new Error('Product create handler was not registered');

    await handler({
      params: {},
      query: {},
      body,
      principal: { sub: 'authenticated-seller-id', role: 'SELLER' },
    });

    expect(products.create).toHaveBeenCalledWith(
      'authenticated-seller-id',
      body,
    );
  });

  it('delegates internal auction reservation to reservation service', async () => {
    const handler = registered.get(
      'product_put__internal_products_id_auction-reservation',
    );
    if (!handler)
      throw new Error('Auction reservation handler was not registered');

    const body = {
      auctionId: 'auction-123',
      sellerId: 'seller-456',
    };

    await handler({
      params: { id: 'prod-789' },
      query: {},
      body,
    });

    expect(reservations.reserve).toHaveBeenCalledWith(
      'prod-789',
      'auction-123',
      'seller-456',
    );
  });
});
