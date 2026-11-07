export type ProductStatus =
  'DRAFT' | 'READY' | 'RESERVED' | 'IN_AUCTION' | 'SOLD';

export type ProductCondition = 'NEW' | 'USED' | 'LIKE_NEW';

export type ProductImageInput = {
  url: string;
  isPrimary: boolean;
};

export type CreateProductInput = {
  categoryId: string;
  title: string;
  description: string;
  condition?: ProductCondition;
  images?: ProductImageInput[];
  status?: 'DRAFT' | 'READY';
};

export type UpdateProductInput = Partial<{
  categoryId: string;
  title: string;
  description: string;
  condition: ProductCondition;
  images: ProductImageInput[];
  status: 'DRAFT' | 'READY';
}>;

export type ProductResponse = {
  id: string;
  sellerId: string;
  categoryId: string;
  category: {
    id: string;
    name: string;
    description: string | null;
  };
  title: string;
  description: string;
  status: ProductStatus;
  condition: ProductCondition;
  images: ProductImageInput[];
};

export type ProductPage = {
  items: ProductResponse[];
  page: number;
  pageSize: number;
  total: number;
};
