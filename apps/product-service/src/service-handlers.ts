import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';
import {
  CategoryService,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from './category/category.service.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly categories: CategoryService,
  ) {}
  onModuleInit() {
    this.http.register('product_get__api_categories', async (request) =>
      this.categories.list(
        Number(request.query.page ?? 1),
        Number(request.query.pageSize ?? 20),
        typeof request.query.search === 'string' ? request.query.search : '',
      ),
    );
    this.http.register('product_post__api_categories', async (request) => {
      return this.categories.create(
        request.body as CreateCategoryInput,
        request.principal?.role,
      );
    });
    this.http.register('product_patch__api_categories_id', async (request) => {
      return this.categories.update(
        String(request.params.id),
        request.body as UpdateCategoryInput,
        request.principal?.role,
      );
    });
    this.http.register('product_delete__api_categories_id', async (request) => {
      return this.categories.delete(
        String(request.params.id),
        request.principal?.role,
      );
    });
    // this.events.register('auction.ended', async (tx, event) => { ... });
    // Event writes must use the supplied transaction, not an independent Prisma transaction.
  }
}
