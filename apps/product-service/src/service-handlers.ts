import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';
import {
  CategoryService,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from './category/category.service.js';
import { ProductService } from './product/product.service.js';
import type {
  CreateProductInput,
  UpdateProductInput,
} from './product/product.dto.js';
import { ReservationService } from './reservation/reservation.service.js';
import type { ReserveProductInput } from './reservation/reservation.dto.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly categories: CategoryService,
    private readonly products: ProductService,
    private readonly reservations: ReservationService,
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
    this.http.register('product_get__api_products', async (request) =>
      this.products.list(
        Number(request.query.page ?? 1),
        Number(request.query.pageSize ?? 20),
        {
          categoryId:
            typeof request.query.categoryId === 'string'
              ? request.query.categoryId
              : undefined,
          status:
            typeof request.query.status === 'string'
              ? request.query.status
              : undefined,
          search:
            typeof request.query.search === 'string'
              ? request.query.search
              : undefined,
        },
      ),
    );
    this.http.register('product_post__api_products', async (request) =>
      this.products.create(
        request.principal?.sub,
        request.body as CreateProductInput,
      ),
    );
    this.http.register('product_get__api_products_id', async (request) =>
      this.products.findById(String(request.params.id)),
    );
    this.http.register('product_patch__api_products_id', async (request) =>
      this.products.update(
        String(request.params.id),
        request.principal?.sub,
        request.body as UpdateProductInput,
      ),
    );
    this.http.register('product_delete__api_products_id', async (request) =>
      this.products.delete(String(request.params.id), request.principal?.sub),
    );
    this.http.register(
      'product_put__internal_products_id_auction-reservation',
      async (request) => {
        const body = request.body as ReserveProductInput;
        return this.reservations.reserve(
          String(request.params.id),
          body.auctionId,
          body.sellerId,
        );
      },
    );
    // this.events.register('auction.ended', async (tx, event) => { ... });
    // Event writes must use the supplied transaction, not an independent Prisma transaction.
  }
}
