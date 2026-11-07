import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateProductInput,
  ProductImageInput,
  ProductPage,
  ProductStatus,
  UpdateProductInput,
} from './product.dto.js';
import { toProductPage, toProductResponse } from './product.mapper.js';
import {
  ProductRepository,
  type ProductListFilter,
  type ProductWriteData,
} from './product.repository.js';

const productStatuses: ProductStatus[] = [
  'DRAFT',
  'READY',
  'RESERVED',
  'IN_AUCTION',
  'SOLD',
];

function assertImagePrimaries(images: ProductImageInput[]) {
  if (images.filter((image) => image.isPrimary).length > 1)
    throw new BadRequestException('Only one primary image is allowed');
}

function assertReadyImages(images: ProductImageInput[]) {
  if (
    images.length === 0 ||
    images.filter((image) => image.isPrimary).length !== 1
  )
    throw new BadRequestException(
      'A READY product must have exactly one primary image',
    );
}

function assertEditableStatus(status: ProductStatus) {
  if (status !== 'DRAFT' && status !== 'READY')
    throw new ConflictException(
      'Product cannot be changed in its current state',
    );
}

function assertProductStatus(value: string): asserts value is ProductStatus {
  if (!productStatuses.includes(value as ProductStatus))
    throw new BadRequestException('Invalid product status filter');
}

@Injectable()
export class ProductService {
  constructor(private readonly products: ProductRepository) {}

  async create(sellerId: string | undefined, input: CreateProductInput) {
    if (!sellerId) throw new ForbiddenException('Seller identity is required');
    if (input.status !== undefined && input.status !== 'DRAFT')
      throw new BadRequestException('Products must be created as DRAFT');

    const images = input.images ?? [];
    assertImagePrimaries(images);

    return this.products.transaction(async (tx) => {
      if (!(await this.products.categoryExists(tx, input.categoryId)))
        throw new NotFoundException('Category not found');
      const product = await this.products.create(tx, {
        sellerId,
        categoryId: input.categoryId,
        title: input.title,
        description: input.description,
        condition: input.condition ?? 'NEW',
        images,
      });
      return toProductResponse(product);
    });
  }

  async list(
    page: number,
    pageSize: number,
    filter: {
      categoryId?: string;
      status?: string;
      search?: string;
    },
  ): Promise<ProductPage> {
    const normalizedFilter: ProductListFilter = {
      categoryId: filter.categoryId,
      search: filter.search,
    };
    if (filter.status !== undefined) {
      assertProductStatus(filter.status);
      normalizedFilter.status = filter.status;
    }
    if (normalizedFilter.status === 'DRAFT')
      return { items: [], page, pageSize, total: 0 };

    const result = await this.products.list(page, pageSize, normalizedFilter);
    return toProductPage(result.items, page, pageSize, result.total);
  }

  async findById(id: string) {
    const product = await this.products.findById(id);
    if (!product) throw new NotFoundException('Product not found');
    return toProductResponse(product);
  }

  async update(
    id: string,
    sellerId: string | undefined,
    input: UpdateProductInput,
  ) {
    if (!sellerId) throw new ForbiddenException('Seller identity is required');

    return this.products.transaction(async (tx) => {
      if (!(await this.products.lockProduct(tx, id)))
        throw new NotFoundException('Product not found');
      const existing = await this.products.findInTransaction(tx, id);
      if (!existing) throw new NotFoundException('Product not found');
      if (existing.sellerId !== sellerId)
        throw new ForbiddenException('Product belongs to another seller');
      assertEditableStatus(existing.status);

      const nextStatus = input.status ?? existing.status;
      const nextImages = input.images ?? existing.images;
      assertImagePrimaries(nextImages);
      if (nextStatus === 'READY') assertReadyImages(nextImages);
      if (input.categoryId !== undefined) {
        if (!(await this.products.categoryExists(tx, input.categoryId)))
          throw new NotFoundException('Category not found');
      }

      const data: ProductWriteData = {};
      if (input.categoryId !== undefined) data.categoryId = input.categoryId;
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.condition !== undefined) data.condition = input.condition;
      if (input.status !== undefined) data.status = input.status;

      if (input.images !== undefined)
        await this.products.replaceImages(tx, id, input.images);
      const product =
        Object.keys(data).length > 0
          ? await this.products.update(tx, id, data)
          : await this.products.findInTransaction(tx, id);
      if (!product) throw new NotFoundException('Product not found');
      return toProductResponse(product);
    });
  }

  async delete(id: string, sellerId: string | undefined) {
    if (!sellerId) throw new ForbiddenException('Seller identity is required');

    await this.products.transaction(async (tx) => {
      if (!(await this.products.lockProduct(tx, id)))
        throw new NotFoundException('Product not found');
      const product = await this.products.findInTransaction(tx, id);
      if (!product) throw new NotFoundException('Product not found');
      if (product.sellerId !== sellerId)
        throw new ForbiddenException('Product belongs to another seller');
      assertEditableStatus(product.status);
      await this.products.delete(tx, id);
    });
    return { deleted: true as const };
  }
}
