import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Principal } from '@app/common/platform/security.js';
import { PrismaService } from '../prisma/prisma.service.js';

type CategoryResponse = {
  id: string;
  name: string;
  description: string | null;
};

export type CreateCategoryInput = {
  name: string;
  description?: string;
};

export type UpdateCategoryInput = Partial<CreateCategoryInput>;

export type CategoryPage = {
  items: CategoryResponse[];
  page: number;
  pageSize: number;
  total: number;
};

function prismaCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  )
    return error.code;
  return undefined;
}

function categoryResponse(category: CategoryResponse): CategoryResponse {
  return {
    id: category.id,
    name: category.name,
    description: category.description,
  };
}

function normalizedName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed)
    throw new BadRequestException('Category name must not be empty');
  return trimmed;
}

@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(role: Principal['role'] | undefined) {
    if (role !== 'ADMIN') throw new ForbiddenException('Insufficient role');
  }

  async list(
    page: number,
    pageSize: number,
    search = '',
  ): Promise<CategoryPage> {
    const escapedSearch = search.replace(/[\\%_]/g, '\\$&');
    const where = escapedSearch
      ? { name: { contains: escapedSearch, mode: 'insensitive' as const } }
      : undefined;
    const [categories, total] = await Promise.all([
      this.prisma.category.findMany({
        where,
        select: { id: true, name: true, description: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.category.count({ where }),
    ]);

    return {
      items: categories.map(categoryResponse),
      page,
      pageSize,
      total,
    };
  }

  async create(
    input: CreateCategoryInput,
    role: Principal['role'] | undefined,
  ): Promise<CategoryResponse> {
    this.assertAdmin(role);
    try {
      const category = await this.prisma.category.create({
        data: {
          name: normalizedName(input.name),
          description: input.description,
        },
        select: { id: true, name: true, description: true },
      });
      return categoryResponse(category);
    } catch (error) {
      if (prismaCode(error) === 'P2002')
        throw new ConflictException('Category name already exists');
      throw error;
    }
  }

  async update(
    id: string,
    input: UpdateCategoryInput,
    role: Principal['role'] | undefined,
  ): Promise<CategoryResponse> {
    this.assertAdmin(role);
    if (Object.keys(input).length === 0)
      throw new BadRequestException('Category update must not be empty');

    const data: UpdateCategoryInput = {};
    if (input.name !== undefined) data.name = normalizedName(input.name);
    if (input.description !== undefined) data.description = input.description;

    try {
      const category = await this.prisma.category.update({
        where: { id },
        data,
        select: { id: true, name: true, description: true },
      });
      return categoryResponse(category);
    } catch (error) {
      if (prismaCode(error) === 'P2002')
        throw new ConflictException('Category name already exists');
      if (prismaCode(error) === 'P2025')
        throw new NotFoundException('Category not found');
      throw error;
    }
  }

  async delete(
    id: string,
    role: Principal['role'] | undefined,
  ): Promise<{ deleted: true }> {
    this.assertAdmin(role);
    try {
      const category = await this.prisma.category.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!category) throw new NotFoundException('Category not found');

      if ((await this.prisma.product.count({ where: { categoryId: id } })) > 0)
        throw new ConflictException('Category contains products');

      await this.prisma.category.delete({ where: { id } });
      return { deleted: true };
    } catch (error) {
      if (prismaCode(error) === 'P2003')
        throw new ConflictException('Category contains products');
      if (prismaCode(error) === 'P2025')
        throw new NotFoundException('Category not found');
      throw error;
    }
  }
}
