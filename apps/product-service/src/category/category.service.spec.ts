import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { CategoryService } from './category.service.js';

describe('CategoryService', () => {
  const prisma = {
    category: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    product: { count: vi.fn() },
  };
  const service = new CategoryService(prisma as unknown as PrismaService);
  const category = { id: 'category-id', name: 'Books', description: null };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('lists categories with escaped search and stable paginated ordering', async () => {
    prisma.category.findMany.mockResolvedValue([category]);
    prisma.category.count.mockResolvedValue(1);

    await expect(service.list(2, 5, 'a%_\\b')).resolves.toEqual({
      items: [category],
      page: 2,
      pageSize: 5,
      total: 1,
    });
    expect(prisma.category.findMany).toHaveBeenCalledWith({
      where: { name: { contains: 'a\\%\\_\\\\b', mode: 'insensitive' } },
      select: { id: true, name: true, description: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: 5,
      take: 5,
    });
    expect(prisma.category.count).toHaveBeenCalledWith({
      where: { name: { contains: 'a\\%\\_\\\\b', mode: 'insensitive' } },
    });
  });

  it('creates categories with a trimmed name and contract-shaped response', async () => {
    prisma.category.create.mockResolvedValue(category);

    await expect(
      service.create({ name: '  Books  ' }, 'ADMIN'),
    ).resolves.toEqual(category);
    expect(prisma.category.create).toHaveBeenCalledWith({
      data: { name: 'Books', description: undefined },
      select: { id: true, name: true, description: true },
    });
  });

  it('rejects a name that becomes empty after trimming', async () => {
    await expect(
      service.create({ name: '   ' }, 'ADMIN'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.category.create).not.toHaveBeenCalled();
  });

  it('rejects non-admin writes before touching the database', async () => {
    await expect(
      service.create({ name: 'Books' }, 'USER'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.update(category.id, { name: 'Art' }, 'SELLER'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.delete(category.id, undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.category.create).not.toHaveBeenCalled();
    expect(prisma.category.update).not.toHaveBeenCalled();
    expect(prisma.category.findUnique).not.toHaveBeenCalled();
    expect(prisma.product.count).not.toHaveBeenCalled();
  });

  it('updates supplied fields and trims a replacement name', async () => {
    prisma.category.update.mockResolvedValue({
      ...category,
      name: 'Art',
      description: 'Fine art',
    });

    await expect(
      service.update(
        category.id,
        { name: ' Art ', description: 'Fine art' },
        'ADMIN',
      ),
    ).resolves.toEqual({
      id: category.id,
      name: 'Art',
      description: 'Fine art',
    });
  });

  it('rejects an empty patch', async () => {
    await expect(
      service.update(category.id, {}, 'ADMIN'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.category.update).not.toHaveBeenCalled();
  });

  it('maps duplicate category names to conflict', async () => {
    prisma.category.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.create({ name: 'Books' }, 'ADMIN'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps duplicate names during update to conflict', async () => {
    prisma.category.update.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.update(category.id, { name: 'Books' }, 'ADMIN'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a missing category update to not found', async () => {
    prisma.category.update.mockRejectedValue({ code: 'P2025' });

    await expect(
      service.update(category.id, { name: 'Art' }, 'ADMIN'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes an empty category', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: category.id });
    prisma.product.count.mockResolvedValue(0);

    await expect(service.delete(category.id, 'ADMIN')).resolves.toEqual({
      deleted: true,
    });
    expect(prisma.category.delete).toHaveBeenCalledWith({
      where: { id: category.id },
    });
  });

  it('rejects deleting a category that still has products', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: category.id });
    prisma.product.count.mockResolvedValue(1);

    await expect(service.delete(category.id, 'ADMIN')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.category.delete).not.toHaveBeenCalled();
  });

  it('maps a missing category delete to not found', async () => {
    prisma.category.findUnique.mockResolvedValue(null);

    await expect(service.delete(category.id, 'ADMIN')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.product.count).not.toHaveBeenCalled();
  });
});
