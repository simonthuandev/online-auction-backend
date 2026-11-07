import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProductRepository,
  ProductTransaction,
} from './product.repository.js';
import type { ProductRecord } from './product.repository.js';
import { ProductService } from './product.service.js';

const tx = {} as ProductTransaction;

describe('ProductService', () => {
  const products = {
    transaction: vi.fn(),
    categoryExists: vi.fn(),
    create: vi.fn(),
    lockProduct: vi.fn(),
    findInTransaction: vi.fn(),
    update: vi.fn(),
    replaceImages: vi.fn(),
    delete: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
  };
  const service = new ProductService(products as unknown as ProductRepository);
  const category = {
    id: 'category-id',
    name: 'Books',
    description: null,
  };
  const product = {
    id: 'product-id',
    sellerId: 'seller-a',
    categoryId: category.id,
    category,
    title: 'Camera',
    description: 'Film camera',
    status: 'DRAFT',
    condition: 'NEW',
    images: [],
    reservedAuctionId: 'private-auction-id',
    reservationSnapshot: { internal: true },
    lastAuctionVersion: 9,
  } as unknown as ProductRecord;

  beforeEach(() => {
    vi.resetAllMocks();
    products.transaction.mockImplementation(
      async (work: (transaction: ProductTransaction) => Promise<unknown>) =>
        work(tx),
    );
    products.categoryExists.mockResolvedValue(true);
    products.create.mockResolvedValue(product);
    products.lockProduct.mockResolvedValue(true);
    products.findInTransaction.mockResolvedValue(product);
    products.update.mockResolvedValue(product);
    products.replaceImages.mockResolvedValue(undefined);
    products.delete.mockResolvedValue(product);
    products.findById.mockResolvedValue(product);
    products.list.mockResolvedValue({ items: [product], total: 1 });
  });

  it('creates a DRAFT/NEW product using the authenticated seller identity', async () => {
    const response = await service.create('seller-from-principal', {
      categoryId: category.id,
      title: 'Camera',
      description: 'Film camera',
      images: [{ url: 'https://cdn.example.test/camera.jpg', isPrimary: true }],
    });

    expect(products.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sellerId: 'seller-from-principal',
        categoryId: category.id,
        condition: 'NEW',
        images: [
          { url: 'https://cdn.example.test/camera.jpg', isPrimary: true },
        ],
      }),
    );
    expect(response).toMatchObject({
      sellerId: 'seller-a',
      status: 'DRAFT',
      condition: 'NEW',
      category,
    });
  });

  it('rejects more than one primary image before opening a write transaction', async () => {
    await expect(
      service.create('seller-a', {
        categoryId: category.id,
        title: 'Camera',
        description: 'Film camera',
        images: [
          { url: 'https://cdn.example.test/a.jpg', isPrimary: true },
          { url: 'https://cdn.example.test/b.jpg', isPrimary: true },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(products.transaction).not.toHaveBeenCalled();
  });

  it('rejects creation as READY', async () => {
    await expect(
      service.create('seller-a', {
        categoryId: category.id,
        title: 'Camera',
        description: 'Film camera',
        status: 'READY',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires an image and a primary image when changing to READY', async () => {
    for (const images of [
      [],
      [{ url: 'https://cdn.example.test/a.jpg', isPrimary: false }],
    ]) {
      products.findInTransaction.mockResolvedValueOnce({
        ...product,
        images,
      } as ProductRecord);
      await expect(
        service.update('product-id', 'seller-a', { status: 'READY' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(products.update).not.toHaveBeenCalled();
  });

  it('forbids another seller from patching or deleting a product', async () => {
    products.findInTransaction.mockResolvedValue({
      ...product,
      sellerId: 'seller-b',
    });

    await expect(
      service.update('product-id', 'seller-a', { title: 'Changed' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.delete('product-id', 'seller-a'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(products.update).not.toHaveBeenCalled();
    expect(products.delete).not.toHaveBeenCalled();
  });

  it.each(['RESERVED', 'IN_AUCTION', 'SOLD'] as const)(
    'rejects patch and delete for %s products',
    async (status) => {
      products.findInTransaction.mockResolvedValue({
        ...product,
        status,
      });

      await expect(
        service.update('product-id', 'seller-a', { title: 'Changed' }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.delete('product-id', 'seller-a'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(products.update).not.toHaveBeenCalled();
      expect(products.delete).not.toHaveBeenCalled();
    },
  );

  it('returns 404 when creating with a missing category', async () => {
    products.categoryExists.mockResolvedValue(false);

    await expect(
      service.create('seller-a', {
        categoryId: 'missing-category',
        title: 'Camera',
        description: 'Film camera',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(products.create).not.toHaveBeenCalled();
  });

  it('always hides DRAFT from list, even when requested explicitly', async () => {
    await expect(service.list(1, 20, { status: 'DRAFT' })).resolves.toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });
    expect(products.list).not.toHaveBeenCalled();
  });

  it('maps detail fields explicitly and includes category and images only', async () => {
    products.findById.mockResolvedValue({
      ...product,
      images: [{ url: 'https://cdn.example.test/a.jpg', isPrimary: true }],
    });

    const response = await service.findById('product-id');
    expect(response).toMatchObject({
      category,
      images: [{ url: 'https://cdn.example.test/a.jpg', isPrimary: true }],
    });
    expect(response).not.toHaveProperty('reservedAuctionId');
    expect(response).not.toHaveProperty('reservationSnapshot');
    expect(response).not.toHaveProperty('lastAuctionVersion');
  });

  it('returns 404 for a missing detail product', async () => {
    products.findById.mockResolvedValue(null);
    await expect(service.findById('missing-product')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('replaces an image list only after validating it', async () => {
    const images = [
      { url: 'https://cdn.example.test/new.jpg', isPrimary: true },
    ];
    await service.update('product-id', 'seller-a', { images });
    expect(products.replaceImages).toHaveBeenCalledWith(
      tx,
      'product-id',
      images,
    );

    products.findInTransaction.mockResolvedValueOnce(product);
    await expect(
      service.update('product-id', 'seller-a', {
        images: [
          { url: 'https://cdn.example.test/a.jpg', isPrimary: true },
          { url: 'https://cdn.example.test/b.jpg', isPrimary: true },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(products.replaceImages).toHaveBeenCalledTimes(1);
  });
});
