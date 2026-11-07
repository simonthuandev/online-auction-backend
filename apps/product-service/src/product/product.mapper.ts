import type { ProductRecord } from './product.repository.js';
import type { ProductPage, ProductResponse } from './product.dto.js';

export function toProductResponse(product: ProductRecord): ProductResponse {
  return {
    id: product.id,
    sellerId: product.sellerId,
    categoryId: product.categoryId,
    category: {
      id: product.category.id,
      name: product.category.name,
      description: product.category.description,
    },
    title: product.title,
    description: product.description,
    status: product.status,
    condition: product.condition,
    images: product.images.map(({ url, isPrimary }) => ({ url, isPrimary })),
  };
}

export function toProductPage(
  products: ProductRecord[],
  page: number,
  pageSize: number,
  total: number,
): ProductPage {
  return {
    items: products.map(toProductResponse),
    page,
    pageSize,
    total,
  };
}
