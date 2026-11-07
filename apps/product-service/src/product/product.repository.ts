import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client/product/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  ProductCondition,
  ProductImageInput,
  ProductStatus,
} from './product.dto.js';

const productSelect = {
  id: true,
  sellerId: true,
  categoryId: true,
  title: true,
  description: true,
  status: true,
  condition: true,
  category: { select: { id: true, name: true, description: true } },
  images: {
    select: { url: true, isPrimary: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.ProductSelect;

export type ProductRecord = Prisma.ProductGetPayload<{
  select: typeof productSelect;
}>;

export type ProductTransaction = Prisma.TransactionClient;

export type ProductListFilter = {
  categoryId?: string;
  status?: ProductStatus;
  search?: string;
};

export type ProductWriteData = {
  categoryId?: string;
  title?: string;
  description?: string;
  condition?: ProductCondition;
  status?: 'DRAFT' | 'READY';
};

@Injectable()
export class ProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: ProductTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async categoryExists(
    tx: ProductTransaction,
    categoryId: string,
  ): Promise<boolean> {
    return Boolean(
      await tx.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      }),
    );
  }

  create(
    tx: ProductTransaction,
    data: {
      sellerId: string;
      categoryId: string;
      title: string;
      description: string;
      condition: ProductCondition;
      images: ProductImageInput[];
    },
  ): Promise<ProductRecord> {
    return tx.product.create({
      data: {
        sellerId: data.sellerId,
        categoryId: data.categoryId,
        title: data.title,
        description: data.description,
        condition: data.condition,
        images: {
          create: data.images.map(({ url, isPrimary }) => ({
            url,
            isPrimary,
          })),
        },
      },
      select: productSelect,
    });
  }

  async lockProduct(tx: ProductTransaction, id: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "Product" WHERE "id" = ${id} FOR UPDATE`,
    );
    return rows.length > 0;
  }

  findInTransaction(
    tx: ProductTransaction,
    id: string,
  ): Promise<ProductRecord | null> {
    return tx.product.findUnique({
      where: { id },
      select: productSelect,
    });
  }

  update(
    tx: ProductTransaction,
    id: string,
    data: ProductWriteData,
  ): Promise<ProductRecord> {
    return tx.product.update({
      where: { id },
      data,
      select: productSelect,
    });
  }

  async replaceImages(
    tx: ProductTransaction,
    productId: string,
    images: ProductImageInput[],
  ): Promise<void> {
    await tx.productImage.deleteMany({ where: { productId } });
    if (images.length > 0)
      await tx.productImage.createMany({
        data: images.map(({ url, isPrimary }) => ({
          productId,
          url,
          isPrimary,
        })),
      });
  }

  delete(tx: ProductTransaction, id: string): Promise<unknown> {
    return tx.product.delete({ where: { id } });
  }

  async findById(id: string): Promise<ProductRecord | null> {
    return this.prisma.product.findUnique({
      where: { id },
      select: productSelect,
    });
  }

  async list(
    page: number,
    pageSize: number,
    filter: ProductListFilter,
  ): Promise<{ items: ProductRecord[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      status: filter.status ?? { not: 'DRAFT' },
      ...(filter.categoryId !== undefined
        ? { categoryId: filter.categoryId }
        : {}),
      ...(filter.search
        ? {
            OR: [
              { title: { contains: filter.search, mode: 'insensitive' } },
              {
                description: {
                  contains: filter.search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: productSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items, total };
  }
}
